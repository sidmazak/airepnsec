import { NextRequest, NextResponse } from 'next/server'
import { withPublic, fail } from '@/lib/api'
import { getServerKey } from '@/lib/crypto'
import { SSO_STATE_COOKIE, sanitizeReturnTo, signSsoState } from '@/lib/security/sso'
import { loadSsoConfig, resolveSamlConfig, resolveSsoOrg } from '@/lib/sso'

export const maxDuration = 30

/**
 * GET /api/auth/sso/saml/start
 * Starts the SP-initiated SAML flow. The browser is redirected to the identity
 * provider with a RelayState; the signed request state travels in an HttpOnly
 * cookie (SAML RelayState is limited to 80 bytes, so it cannot carry it).
 */
export const GET = withPublic(async (req: NextRequest) => {
  const url = new URL(req.url)
  const org = await resolveSsoOrg(url.searchParams)
  if (!org) return fail(404, 'No organisation is configured on this instance.')

  const loaded = await loadSsoConfig(org.id, 'saml')
  if (!loaded || !loaded.enabled) return fail(404, 'Single sign-on is not enabled for this organisation.')

  let config
  try {
    config = await resolveSamlConfig({ ...loaded.config, idpCertificate: loaded.secrets.idpCertificate })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The single sign-on configuration is invalid.'
    return fail(500, `Single sign-on is misconfigured: ${message}`)
  }

  const { createSamlLoginUrl } = await import('@/lib/security/saml')
  const returnTo = sanitizeReturnTo(url.searchParams.get('returnTo'))
  let loginUrl: string
  let requestId: string
  try {
    const result = createSamlLoginUrl(config, returnTo)
    loginUrl = result.url
    requestId = result.requestId
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The identity provider metadata could not be read.'
    return fail(500, `Single sign-on is misconfigured: ${message.slice(0, 200)}`)
  }

  const state = signSsoState(
    {
      orgId: org.id,
      kind: 'saml',
      nonce: '',
      codeVerifier: '',
      returnTo,
      createdAt: Date.now(),
      requestId,
    },
    getServerKey().toString('hex')
  )

  const res = NextResponse.redirect(loginUrl, 307)
  res.headers.append(
    'set-cookie',
    `${SSO_STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${
      process.env.NODE_ENV === 'production' ? '; Secure' : ''
    }`
  )
  return res
})
