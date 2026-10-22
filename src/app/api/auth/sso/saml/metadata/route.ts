import { NextRequest, NextResponse } from 'next/server'
import { withPublic, fail } from '@/lib/api'
import { loadSsoConfig, resolveSamlConfig, resolveSsoOrg } from '@/lib/sso'
import { buildSpMetadataXml } from '@/lib/security/saml'

export const maxDuration = 30

/**
 * GET /api/auth/sso/saml/metadata
 * Returns the Service Provider metadata XML. The identity provider operator
 * imports this into their IdP to establish trust.
 */
export const GET = withPublic(async (req: NextRequest) => {
  const url = new URL(req.url)
  const org = await resolveSsoOrg(url.searchParams)
  if (!org) return fail(404, 'No organisation is configured on this instance.')

  const loaded = await loadSsoConfig(org.id, 'saml')
  if (!loaded || !loaded.enabled) return fail(404, 'Single sign-on is not enabled for this organisation.')

  let config
  try {
    config = await resolveSamlConfig(loaded.config)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The single sign-on configuration is invalid.'
    return fail(500, `Single sign-on is misconfigured: ${message}`)
  }

  const xml = buildSpMetadataXml(config)
  return new NextResponse(xml, {
    status: 200,
    headers: {
      'content-type': 'application/samlmetadata+xml',
      'cache-control': 'public, max-age=86400',
    },
  })
})