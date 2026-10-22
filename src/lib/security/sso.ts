import crypto from 'node:crypto'
import { z } from 'zod'

/**
 * Federated sign-in (OIDC + SAML) primitives.
 *
 * Everything in this module is deliberately free of database access so it can be
 * unit-tested without a running server. The routes own the persistence and the
 * session hand-off; this module owns the protocol correctness:
 *
 *  - authorization code flow with PKCE (S256) and single-use state/nonce
 *  - ID token verification (signature via JWKS, iss/aud/exp/nonce checks)
 *  - account-linking / auto-provisioning decisions
 *
 * Nothing here ever fabricates a successful sign-in: every failure path throws
 * with an explicit reason so the UI can report it honestly.
 */

export const SSO_KINDS = ['oidc', 'saml'] as const
export type SsoKind = (typeof SSO_KINDS)[number]

/** Cookie that carries the signed sign-in state back from the identity provider. */
export const SSO_STATE_COOKIE = 'ais_sso_state'

/** Ten minutes is plenty for a redirect round-trip and short enough to limit replay. */
export const SSO_STATE_TTL_MS = 10 * 60_000

/** Only same-site paths are accepted as a post-login destination (no open redirect). */
export function sanitizeReturnTo(value: string | null | undefined): string {
  if (!value) return '/'
  if (!value.startsWith('/')) return '/'
  if (value.startsWith('//')) return '/'
  return value.slice(0, 200)
}

/* ------------------------------------------------------------------ */
/* configuration schemas                                               */
/* ------------------------------------------------------------------ */

export const oidcConfigSchema = z.object({
  /** Human readable name shown on the sign-in button. */
  label: z.string().max(80).optional(),
  /** Issuer identifier — must match the `iss` claim of the ID token. */
  issuer: z.string().min(1, 'issuer is required').max(300),
  /** OAuth client id issued by the provider. */
  clientId: z.string().min(1, 'clientId is required').max(300),
  /** Where the provider sends the user back. Must be the public URL of this app. */
  redirectUri: z.string().url('redirectUri must be an absolute URL').max(500),
  /** Space separated scopes. `openid` is required for OIDC. */
  scopes: z.string().min(1).max(500).default('openid profile email'),
  /** Create a local account when the identity is unknown. */
  autoProvision: z.boolean().default(false),
  /** Role given to auto-provisioned accounts. */
  defaultRole: z.enum(['admin', 'agent', 'viewer']).default('agent'),
  /** Only identities from these e-mail domains may sign in (empty = any domain). */
  domainAllowlist: z.array(z.string().min(3).max(120)).max(50).default([]),
  /** Allow an identity whose e-mail matches an existing local account to sign in to it. */
  linkExisting: z.boolean().default(true),
  /** Require the provider to mark the e-mail as verified before linking/provisioning. */
  requireVerifiedEmail: z.boolean().default(true),
  /** Optional explicit endpoints — when empty the discovery document is used. */
  authorizationEndpoint: z.string().url().max(500).optional(),
  tokenEndpoint: z.string().url().max(500).optional(),
  userinfoEndpoint: z.string().url().max(500).optional(),
  jwksUri: z.string().url().max(500).optional(),
})

export const samlConfigSchema = z.object({
  /** Human readable name shown on the sign-in button. */
  label: z.string().max(80).optional(),
  /** Entity ID of this service provider (SP). */
  entityId: z.string().min(1, 'entityId is required').max(300),
  /** Where the identity provider posts its SAML response. */
  acsUrl: z.string().url('acsUrl must be an absolute URL').max(500),
  /** IdP metadata URL — fetched and parsed on demand. */
  idpMetadataUrl: z.string().url('idpMetadataUrl must be an absolute URL').max(500).optional(),
  /** Or the raw IdP metadata XML. */
  idpMetadataXml: z.string().max(200_000).optional(),
  /** Entity ID of the identity provider. */
  idpEntityId: z.string().min(1, 'idpEntityId is required').max(300),
  /** Single sign-on URL of the identity provider. */
  idpSsoUrl: z.string().url('idpSsoUrl must be an absolute URL').max(500),
  /** X.509 certificate of the IdP (PEM or base64 DER) used to verify signatures. */
  idpCertificate: z.string().min(10, 'idpCertificate is required').max(20_000),
  /** Create a local account when the identity is unknown. */
  autoProvision: z.boolean().default(false),
  defaultRole: z.enum(['admin', 'agent', 'viewer']).default('agent'),
  domainAllowlist: z.array(z.string().min(3).max(120)).max(50).default([]),
  linkExisting: z.boolean().default(true),
  requireVerifiedEmail: z.boolean().default(true),
})

export type OidcConfig = z.infer<typeof oidcConfigSchema>
export type SamlConfig = z.infer<typeof samlConfigSchema>

export type SsoCommonConfig = {
  autoProvision: boolean
  defaultRole: string
  domainAllowlist: string[]
  linkExisting: boolean
  requireVerifiedEmail: boolean
}

/* ------------------------------------------------------------------ */
/* PKCE                                                                */
/* ------------------------------------------------------------------ */

export function base64url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

/** PKCE verifier (43–128 chars) + its S256 challenge. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(48))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/* ------------------------------------------------------------------ */
/* state / nonce                                                       */
/* ------------------------------------------------------------------ */

export type SsoState = {
  orgId: string
  kind: SsoKind
  nonce: string
  codeVerifier: string
  /** Where to send the browser after a successful sign-in. */
  returnTo: string
  createdAt: number
  /** SAML AuthnRequest ID for InResponseTo binding (SAML only). */
  requestId?: string
}

/**
 * A signed, single-use state token. The HMAC signature makes the payload
 * tamper-evident; the TTL bounds its lifetime. Protocol-level replay
 * protection is provided by PKCE + nonce (OIDC) and InResponseTo (SAML).
 * The cookie is deleted after use to limit exposure.
 */
export function signSsoState(state: SsoState, secret: string): string {
  const payload = base64url(Buffer.from(JSON.stringify(state), 'utf8'))
  const sig = base64url(crypto.createHmac('sha256', secret).update(payload).digest())
  return `${payload}.${sig}`
}

export function verifySsoState(token: string, secret: string): { ok: true; state: SsoState } | { ok: false; reason: string } {
  const dot = token.lastIndexOf('.')
  if (dot < 0) return { ok: false, reason: 'malformed state' }
  const payload = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = base64url(crypto.createHmac('sha256', secret).update(payload).digest())
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'state signature mismatch' }
  let parsed: SsoState
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SsoState
  } catch {
    return { ok: false, reason: 'malformed state payload' }
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'malformed state payload' }
  if (Date.now() - parsed.createdAt > SSO_STATE_TTL_MS) return { ok: false, reason: 'state expired' }
  return { ok: true, state: parsed }
}

/* ------------------------------------------------------------------ */
/* OIDC                                                                */
/* ------------------------------------------------------------------ */

export type OidcDiscovery = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  userinfo_endpoint?: string
  end_session_endpoint?: string
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Fetch the provider's discovery document. Returns null when the document is
 * missing or unusable so the caller can report the provider's real answer.
 */
export async function fetchOidcDiscovery(issuer: string, doFetch: FetchLike = fetch): Promise<OidcDiscovery | null> {
  const base = issuer.replace(/\/+$/, '')
  const res = await doFetch(`${base}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } })
  if (!res.ok) return null
  let doc: Record<string, unknown>
  try {
    doc = (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
  const auth = typeof doc.authorization_endpoint === 'string' ? doc.authorization_endpoint : ''
  const token = typeof doc.token_endpoint === 'string' ? doc.token_endpoint : ''
  const jwks = typeof doc.jwks_uri === 'string' ? doc.jwks_uri : ''
  if (!auth || !token || !jwks) return null
  return {
    issuer: typeof doc.issuer === 'string' ? doc.issuer : base,
    authorization_endpoint: auth,
    token_endpoint: token,
    jwks_uri: jwks,
    userinfo_endpoint: typeof doc.userinfo_endpoint === 'string' ? doc.userinfo_endpoint : undefined,
    end_session_endpoint: typeof doc.end_session_endpoint === 'string' ? doc.end_session_endpoint : undefined,
  }
}

export function buildAuthorizeUrl(params: {
  authorizationEndpoint: string
  clientId: string
  redirectUri: string
  scopes: string
  state: string
  nonce: string
  codeChallenge: string
}): string {
  const url = new URL(params.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('scope', params.scopes)
  url.searchParams.set('state', params.state)
  url.searchParams.set('nonce', params.nonce)
  url.searchParams.set('code_challenge', params.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

export type TokenResponse = {
  access_token?: string
  id_token?: string
  token_type?: string
  expires_in?: number
  refresh_token?: string
  error?: string
  error_description?: string
}

/** Authorization-code exchange with PKCE. Provider errors are surfaced verbatim. */
export async function exchangeAuthorizationCode(params: {
  tokenEndpoint: string
  code: string
  codeVerifier: string
  clientId: string
  clientSecret?: string
  redirectUri: string
  doFetch?: FetchLike
}): Promise<TokenResponse> {
  const doFetch = params.doFetch ?? fetch
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.codeVerifier,
  })
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  }
  if (params.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(params.clientId)}:${encodeURIComponent(params.clientSecret)}`).toString('base64')}`
    body.set('client_id', params.clientId)
  }
  const res = await doFetch(params.tokenEndpoint, { method: 'POST', headers, body: body.toString() })
  let json: TokenResponse = {}
  try {
    json = (await res.json()) as TokenResponse
  } catch {
    json = {}
  }
  if (!res.ok) {
    return {
      error: json.error ?? `http_${res.status}`,
      error_description: json.error_description ?? 'The identity provider rejected the authorization code.',
    }
  }
  return json
}

/* ---------------- JWT verification ---------------- */

export type Jwk = {
  kty: string
  kid?: string
  alg?: string
  use?: string
  n?: string
  e?: string
  crv?: string
  x?: string
  y?: string
  k?: string
}

export type JwtHeader = { alg?: string; kid?: string; typ?: string }
export type JwtClaims = {
  iss?: string
  aud?: string | string[]
  sub?: string
  exp?: number
  iat?: number
  nonce?: string
  email?: string
  email_verified?: boolean
  name?: string
  preferred_username?: string
  given_name?: string
  family_name?: string
  [key: string]: unknown
}

export function decodeJwtPart(part: string): Record<string, unknown> {
  const json = Buffer.from(part, 'base64url').toString('utf8')
  return JSON.parse(json) as Record<string, unknown>
}

export function decodeJwt(token: string): { header: JwtHeader; claims: JwtClaims } | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    return {
      header: decodeJwtPart(parts[0]) as JwtHeader,
      claims: decodeJwtPart(parts[1]) as JwtClaims,
    }
  } catch {
    return null
  }
}

function jwkToKey(jwk: Jwk): crypto.KeyObject | null {
  try {
    if (jwk.kty === 'RSA' && jwk.n && jwk.e) {
      return crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' })
    }
    if (jwk.kty === 'EC' && jwk.crv && jwk.x && jwk.y) {
      return crypto.createPublicKey({ key: { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' })
    }
    if (jwk.kty === 'oct' && jwk.k) {
      return crypto.createPublicKey({ key: Buffer.from(jwk.k, 'base64url'), format: 'jwk' })
    }
  } catch {
    return null
  }
  return null
}

function verifySignature(alg: string, data: Buffer, signature: Buffer, jwk: Jwk, clientSecret?: string): boolean {
  try {
    if (alg === 'HS256' || alg === 'HS384' || alg === 'HS512') {
      if (!clientSecret) return false
      const digest = alg === 'HS256' ? 'sha256' : alg === 'HS384' ? 'sha384' : 'sha512'
      const expected = crypto.createHmac(digest, clientSecret).update(data).digest()
      return expected.length === signature.length && crypto.timingSafeEqual(expected, signature)
    }
    const key = jwkToKey(jwk)
    if (!key) return false
    if (alg === 'RS256') return crypto.verify('RSA-SHA256', data, key, signature)
    if (alg === 'RS384') return crypto.verify('RSA-SHA384', data, key, signature)
    if (alg === 'RS512') return crypto.verify('RSA-SHA512', data, key, signature)
    if (alg === 'PS256') return crypto.verify('RSA-SHA256', data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, signature)
    if (alg === 'ES256') return crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature)
    if (alg === 'ES384') return crypto.verify('sha384', data, { key, dsaEncoding: 'ieee-p1363' }, signature)
    return false
  } catch {
    return false
  }
}

export async function fetchJwks(jwksUri: string, doFetch: FetchLike = fetch): Promise<Jwk[]> {
  const res = await doFetch(jwksUri, { headers: { accept: 'application/json' } })
  if (!res.ok) return []
  try {
    const doc = (await res.json()) as { keys?: Jwk[] }
    return Array.isArray(doc.keys) ? doc.keys : []
  } catch {
    return []
  }
}

export type IdTokenResult = { ok: true; claims: JwtClaims } | { ok: false; reason: string }

/**
 * Verify an ID token: signature, issuer, audience, expiry and nonce.
 * Every rejection reason is explicit so the sign-in screen can explain itself.
 */
export async function verifyIdToken(params: {
  idToken: string
  issuer: string
  clientId: string
  nonce?: string
  jwks?: Jwk[]
  jwksUri?: string
  clientSecret?: string
  clockSkewSec?: number
  doFetch?: FetchLike
}): Promise<IdTokenResult> {
  const decoded = decodeJwt(params.idToken)
  if (!decoded) return { ok: false, reason: 'The identity provider returned a malformed ID token.' }
  const { header, claims } = decoded
  const alg = header.alg ?? ''
  if (!alg || alg === 'none') return { ok: false, reason: 'The ID token has no usable signature algorithm.' }

  const parts = params.idToken.split('.')
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`)
  const signature = Buffer.from(parts[2], 'base64url')

  let keys: Jwk[] = params.jwks ?? []
  if (!keys.length && params.jwksUri) {
    keys = await fetchJwks(params.jwksUri, params.doFetch ?? fetch)
  }
  if (!keys.length) return { ok: false, reason: 'Could not load the identity provider signing keys.' }

  const candidates = header.kid ? keys.filter((k) => k.kid === header.kid) : keys
  const verified = candidates.some((jwk) => verifySignature(alg, signed, signature, jwk, params.clientSecret))
  if (!verified) return { ok: false, reason: 'The ID token signature could not be verified.' }

  const expectedIssuer = params.issuer.replace(/\/+$/, '')
  const actualIssuer = (claims.iss ?? '').replace(/\/+$/, '')
  if (!actualIssuer || actualIssuer !== expectedIssuer) {
    return { ok: false, reason: 'The ID token was issued by a different provider than configured.' }
  }

  const aud = claims.aud
  const audiences = Array.isArray(aud) ? aud : aud ? [aud] : []
  if (!audiences.includes(params.clientId)) {
    return { ok: false, reason: 'The ID token is not addressed to this application.' }
  }

  const skew = (params.clockSkewSec ?? 60) * 1000
  const now = Date.now()
  if (typeof claims.exp === 'number' && claims.exp * 1000 + skew < now) {
    return { ok: false, reason: 'The ID token has expired.' }
  }
  if (typeof claims.iat === 'number' && claims.iat * 1000 - skew > now) {
    return { ok: false, reason: 'The ID token was issued in the future.' }
  }
  if (params.nonce !== undefined) {
    if (!claims.nonce || claims.nonce !== params.nonce) {
      return { ok: false, reason: 'The ID token nonce does not match the sign-in request.' }
    }
  }
  return { ok: true, claims }
}

/* ------------------------------------------------------------------ */
/* identity → local account decisions                                  */
/* ------------------------------------------------------------------ */

export type ExternalIdentity = {
  /** Stable subject identifier from the provider (`sub` / `nameId`). */
  subject: string
  email: string
  emailVerified: boolean
  name?: string
}

export type AccountResolution =
  | { action: 'link'; userId: string }
  | { action: 'provision'; role: string; name: string }
  | { action: 'reject'; reason: string }

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function emailDomain(email: string): string {
  const normalized = normalizeEmail(email)
  const at = normalized.lastIndexOf('@')
  return at >= 0 ? normalized.slice(at + 1) : ''
}

/**
 * Decide what to do with an external identity. Pure function so the policy can be
 * unit-tested without a database.
 *
 * `existing` is the local account with the same e-mail (if any) and
 * `existingBySubject` the account already linked to this subject claim.
 */
export function resolveExternalIdentity(params: {
  identity: ExternalIdentity
  existing?: { id: string; orgId: string; active: boolean } | null
  existingBySubject?: { id: string; orgId: string; active: boolean } | null
  orgId: string
  config: SsoCommonConfig
}): AccountResolution {
  const { identity, config } = params
  if (!identity.subject) return { action: 'reject', reason: 'The identity provider did not return a subject identifier.' }
  const email = normalizeEmail(identity.email ?? '')
  if (!email || !email.includes('@')) {
    return { action: 'reject', reason: 'The identity provider did not return an e-mail address.' }
  }
  if (config.requireVerifiedEmail && !identity.emailVerified) {
    return { action: 'reject', reason: 'The identity provider has not verified this e-mail address.' }
  }
  const domain = emailDomain(email)
  if (config.domainAllowlist.length && !config.domainAllowlist.map((d) => d.toLowerCase().trim()).includes(domain)) {
    return { action: 'reject', reason: `E-mail domain "${domain || 'unknown'}" is not allowed to sign in.` }
  }

  const bySubject = params.existingBySubject
  if (bySubject) {
    if (bySubject.orgId !== params.orgId) return { action: 'reject', reason: 'This identity is linked to another organisation.' }
    if (!bySubject.active) return { action: 'reject', reason: 'This account has been deactivated.' }
    return { action: 'link', userId: bySubject.id }
  }

  const existing = params.existing
  if (existing) {
    if (existing.orgId !== params.orgId) return { action: 'reject', reason: 'This e-mail already belongs to another organisation.' }
    if (!existing.active) return { action: 'reject', reason: 'This account has been deactivated.' }
    if (!config.linkExisting) {
      return { action: 'reject', reason: 'This e-mail already has a local account. Sign in with your password instead.' }
    }
    return { action: 'link', userId: existing.id }
  }

  if (!config.autoProvision) {
    return { action: 'reject', reason: 'No account exists for this identity. Ask an administrator for an invitation.' }
  }
  const name = (identity.name ?? '').trim() || email.split('@')[0]
  return { action: 'provision', role: config.defaultRole, name }
}

/* ------------------------------------------------------------------ */
/* SAML                                                                */
/* ------------------------------------------------------------------ */

export type SamlAssertion = {
  subject: string
  email: string
  emailVerified: boolean
  name?: string
  sessionIndex?: string
}

/**
 * Pull the identity out of a validated SAML assertion. The *signature* is
 * verified by the caller (samlify) before this function is used; this only
 * normalises the attribute names, which differ per IdP.
 */
export function extractSamlIdentity(attributes: Record<string, unknown>): SamlAssertion {
  const pick = (...names: string[]): string => {
    for (const name of names) {
      const value = attributes[name]
      if (value === undefined || value === null) continue
      if (Array.isArray(value)) {
        const first = value.find((v) => typeof v === 'string' && v.trim())
        if (typeof first === 'string') return first.trim()
        continue
      }
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
  }
  const subject = pick('uid', 'userid', 'subject', 'NameID', 'nameId', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier')
  const email = pick('email', 'mail', 'emailAddress', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', 'urn:oid:0.9.2342.19200300.100.1.3')
  const name = pick('displayName', 'cn', 'name', 'givenName', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name')
  const verifiedRaw = pick('email_verified', 'emailVerified')
  const emailVerified = verifiedRaw === '' ? true : /^(true|1|yes)$/i.test(verifiedRaw)
  return { subject, email, emailVerified, name: name || undefined }
}
