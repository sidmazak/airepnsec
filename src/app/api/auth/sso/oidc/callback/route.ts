import { NextRequest, NextResponse } from 'next/server'
import { withPublic, fail, createSession, sessionCookie } from '@/lib/api'
import { getServerKey } from '@/lib/crypto'
import {
  SSO_STATE_COOKIE,
  exchangeAuthorizationCode,
  verifyIdToken,
  verifySsoState,
} from '@/lib/security/sso'
import {
  commonPolicy,
  discoverOidc,
  loadSsoConfig,
  parseOidcConfig,
  signInWithExternalIdentity,
} from '@/lib/sso'

export const maxDuration = 30

/**
 * GET /api/auth/sso/oidc/callback
 * The identity provider redirects here with `code` and `state`. The code is
 * exchanged (PKCE), the ID token is verified against the provider's signing
 * keys, and only then is a local session issued.
 */
export const GET = withPublic(async (req: NextRequest) => {
  const url = new URL(req.url)
  const stateParam = url.searchParams.get('state') ?? ''
  const code = url.searchParams.get('code') ?? ''
  const providerError = url.searchParams.get('error')
  const cookieState = req.cookies.get(SSO_STATE_COOKIE)?.value ?? ''

  if (providerError) {
    const description = url.searchParams.get('error_description') ?? providerError
    return redirectWithError(req, description)
  }
  if (!stateParam || !cookieState) return redirectWithError(req, 'The sign-in request was incomplete. Please try again.')
  if (stateParam !== cookieState) return redirectWithError(req, 'The sign-in request could not be verified. Please try again.')

  const verified = verifySsoState(stateParam, getServerKey().toString('hex'))
  if (!verified.ok) return redirectWithError(req, `The sign-in request could not be verified: ${verified.reason}.`)

  const { state } = verified
  const loaded = await loadSsoConfig(state.orgId, 'oidc')
  if (!loaded || !loaded.enabled) return redirectWithError(req, 'Single sign-on is not enabled for this organisation.')

  let config
  try {
    config = parseOidcConfig(loaded.config)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The single sign-on configuration is invalid.'
    return redirectWithError(req, `Single sign-on is misconfigured: ${message}`)
  }

  if (!code) return redirectWithError(req, 'The identity provider did not return an authorization code.')

  const hasExplicitEndpoints = Boolean(config.tokenEndpoint && config.jwksUri)
  const discovery = hasExplicitEndpoints ? null : await discoverOidc(config.issuer)
  const tokenEndpoint = config.tokenEndpoint ?? discovery?.token_endpoint
  const jwksUri = config.jwksUri ?? discovery?.jwks_uri
  if (!tokenEndpoint || !jwksUri) {
    return redirectWithError(req, 'The identity provider endpoints could not be resolved.')
  }

  const tokens = await exchangeAuthorizationCode({
    tokenEndpoint,
    code,
    codeVerifier: state.codeVerifier,
    clientId: config.clientId,
    clientSecret: loaded.secrets.clientSecret,
    redirectUri: config.redirectUri,
  })
  if (tokens.error) {
    return redirectWithError(req, tokens.error_description ?? `The identity provider rejected the sign-in (${tokens.error}).`)
  }
  if (!tokens.id_token) {
    return redirectWithError(req, 'The identity provider did not return an ID token.')
  }

  const idToken = await verifyIdToken({
    idToken: tokens.id_token,
    issuer: config.issuer,
    clientId: config.clientId,
    nonce: state.nonce,
    jwksUri,
    clientSecret: loaded.secrets.clientSecret,
  })
  if (!idToken.ok) return redirectWithError(req, idToken.reason)

  const claims = idToken.claims
  const policy = commonPolicy(config)
  const identity = {
    subject: String(claims.sub ?? ''),
    email: String(claims.email ?? ''),
    emailVerified: claims.email_verified === true,
    name: (claims.name as string | undefined) ?? (claims.preferred_username as string | undefined),
  }
  if (!identity.email && discovery?.userinfo_endpoint && tokens.access_token) {
    const info = await fetchUserInfo(discovery.userinfo_endpoint, tokens.access_token)
    if (info) {
      identity.email = String(info.email ?? info.preferred_username ?? '')
      identity.emailVerified = info.email_verified === true
      identity.name = (info.name as string | undefined) ?? identity.name
      if (!identity.subject) identity.subject = String(info.sub ?? '')
    }
  }

  const result = await signInWithExternalIdentity({
    orgId: state.orgId,
    kind: 'oidc',
    identity,
    policy,
  })
  if (!result.ok) return redirectWithError(req, result.reason)

  const session = await createSession(result.user.id)
  const res = NextResponse.redirect(new URL(state.returnTo, url.origin), 307)
  res.headers.append('set-cookie', sessionCookie(session.token, session.expiresAt))
  res.headers.append('set-cookie', `${SSO_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
  return res
})

async function fetchUserInfo(endpoint: string, accessToken: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(endpoint, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } })
    if (!res.ok) return null
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Send the browser back to the app with a readable reason instead of a raw error page. */
function redirectWithError(req: NextRequest, message: string): NextResponse {
  const url = new URL('/', req.url)
  url.searchParams.set('sso_error', message.slice(0, 300))
  const res = NextResponse.redirect(url, 307)
  res.headers.append('set-cookie', `${SSO_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
  return res
}
