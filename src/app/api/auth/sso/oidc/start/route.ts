import { NextRequest, NextResponse } from 'next/server'
import { withPublic, fail } from '@/lib/api'
import { getServerKey } from '@/lib/crypto'
import {
  SSO_STATE_COOKIE,
  buildAuthorizeUrl,
  createPkcePair,
  sanitizeReturnTo,
  signSsoState,
} from '@/lib/security/sso'
import { discoverOidc, loadSsoConfig, parseOidcConfig, resolveSsoOrg } from '@/lib/sso'

export const maxDuration = 30

/**
 * GET /api/auth/sso/oidc/start
 * Starts the OIDC authorization-code flow (with PKCE). The browser is redirected
 * to the identity provider; the signed state travels in an HttpOnly cookie and
 * as the `state` query parameter.
 */
export const GET = withPublic(async (req: NextRequest) => {
  const url = new URL(req.url)
  const org = await resolveSsoOrg(url.searchParams)
  if (!org) return fail(404, 'No organisation is configured on this instance.')

  const loaded = await loadSsoConfig(org.id, 'oidc')
  if (!loaded || !loaded.enabled) return fail(404, 'Single sign-on is not enabled for this organisation.')

  let config
  try {
    config = parseOidcConfig(loaded.config)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The single sign-on configuration is invalid.'
    return fail(500, `Single sign-on is misconfigured: ${message}`)
  }

  const hasExplicitEndpoints = Boolean(config.authorizationEndpoint && config.tokenEndpoint && config.jwksUri)
  const discovery = hasExplicitEndpoints ? null : await discoverOidc(config.issuer)
  const authorizationEndpoint = config.authorizationEndpoint ?? discovery?.authorization_endpoint
  if (!authorizationEndpoint) {
    return fail(502, 'The identity provider could not be reached — its discovery document is missing or incomplete.')
  }

  const returnTo = sanitizeReturnTo(url.searchParams.get('returnTo'))
  const { verifier, challenge } = createPkcePair()
  const nonce = createPkcePair().verifier
  const state = signSsoState(
    {
      orgId: org.id,
      kind: 'oidc',
      nonce,
      codeVerifier: verifier,
      returnTo,
      createdAt: Date.now(),
    },
    getServerKey().toString('hex')
  )

  const target = buildAuthorizeUrl({
    authorizationEndpoint,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    scopes: config.scopes,
    state,
    nonce,
    codeChallenge: challenge,
  })

  const res = NextResponse.redirect(target, 307)
  res.headers.append(
    'set-cookie',
    `${SSO_STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${
      process.env.NODE_ENV === 'production' ? '; Secure' : ''
    }`
  )
  return res
})
