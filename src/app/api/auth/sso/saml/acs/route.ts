import { NextRequest, NextResponse } from 'next/server'
import { withPublic, createSession, sessionCookie } from '@/lib/api'
import { SSO_STATE_COOKIE, extractSamlIdentity, sanitizeReturnTo, verifySsoState } from '@/lib/security/sso'
import { parseSamlLoginResponse } from '@/lib/security/saml'
import { commonPolicy, loadSsoConfig, resolveSamlConfig, signInWithExternalIdentity } from '@/lib/sso'
import { getServerKey } from '@/lib/crypto'

export const maxDuration = 30

/**
 * POST /api/auth/sso/saml/acs
 * The identity provider posts its SAML Response here. samlify verifies the
 * signature against the IdP certificate before we trust any claim, so a tampered
 * or unsigned response is rejected rather than leading to account linking.
 */
export const POST = withPublic(async (req: NextRequest) => {
  const url = new URL(req.url)
  const stateCookie = req.cookies.get(SSO_STATE_COOKIE)?.value ?? ''
  if (!stateCookie) return redirectToApp(url, '/')

  const verified = verifySsoState(stateCookie, getServerKey().toString('hex'))
  if (!verified.ok || verified.state.kind !== 'saml') return redirectToApp(url, '/')

  const orgId = verified.state.orgId
  const loaded = await loadSsoConfig(orgId, 'saml')
  if (!loaded || !loaded.enabled) return redirectToApp(url, '/')

  let config
  try {
    config = await resolveSamlConfig({ ...loaded.config, idpCertificate: loaded.secrets.idpCertificate })
  } catch {
    return redirectToApp(url, '/')
  }

  const body = await readFormBody(req)
  if (!body?.SAMLResponse || typeof body.SAMLResponse !== 'string') {
    return redirectToApp(url, '/')
  }

  const parsed = await parseSamlLoginResponse(config, {
    ...body,
    RelayState: typeof body.RelayState === 'string' ? body.RelayState : undefined,
  }, { inResponseTo: verified.state.requestId })
  if (!parsed.ok) return redirectToApp(url, '/')

  const nameId = String(parsed.nameId ?? '')
  if (!nameId) return redirectToApp(url, '/')

  const policy = commonPolicy(config)
  let identity = extractSamlIdentity({ [nameId]: '', ...parsed.attributes })
  // Fallback: many IdPs put the e-mail only in the NameID (emailAddress format).
  if (!identity.email && nameId.includes('@')) {
    identity.email = nameId
    identity.emailVerified = true
  }
  identity.subject = nameId

  const result = await signInWithExternalIdentity({ orgId, kind: 'saml', identity, policy })
  if (!result.ok) return redirectError(url, result.reason)

  const session = await createSession(result.user.id)
  const target = sanitizeReturnTo(verified.state.returnTo)
  const res = NextResponse.redirect(new URL(target, url.origin), 307)
  res.headers.append('set-cookie', sessionCookie(session.token, session.expiresAt))
  res.headers.append(`set-cookie`, `${SSO_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
  return res
})

/** Read SAML responses (form data + urlencoded). */
async function readFormBody(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const data = await req.formData()
    const out: Record<string, unknown> = {}
    for (const [key, value] of data.entries()) out[key] = value
    return out
  } catch {
    try {
      const text = await req.text()
      const pairs = new URLSearchParams(text)
      const out: Record<string, unknown> = {}
      for (const [key, value] of pairs.entries()) out[key] = value
      return out
    } catch {
      return {}
    }
  }
}

function redirectToApp(url: URL, path: string): NextResponse {
  const res = NextResponse.redirect(new URL(path, url.origin), 307)
  res.headers.append(`set-cookie`, `${SSO_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
  return res
}

function redirectError(url: URL, message: string): NextResponse {
  const target = new URL('/', url.origin)
  target.searchParams.set('sso_error', message.slice(0, 300))
  const res = NextResponse.redirect(target, 307)
  res.headers.append(`set-cookie`, `${SSO_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
  return res
}
