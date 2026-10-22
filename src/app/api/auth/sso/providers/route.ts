import { NextRequest } from 'next/server'
import { withPublic, json } from '@/lib/api'
import { loadSsoConfig, resolveSsoOrg } from '@/lib/sso'

/**
 * GET /api/auth/sso/providers
 * Public, secret-free list of the federated sign-in methods this instance
 * offers. The sign-in screen uses it to decide whether to show the SSO button.
 */
export const GET = withPublic(async (req: NextRequest) => {
  const url = new URL(req.url)
  const org = await resolveSsoOrg(url.searchParams)
  if (!org) return json({ providers: [] })

  const [oidc, saml] = await Promise.all([loadSsoConfig(org.id, 'oidc'), loadSsoConfig(org.id, 'saml')])
  const providers: Array<{ kind: string; label: string }> = []
  if (oidc?.enabled) {
    const label = typeof oidc.config?.label === 'string' && oidc.config.label.trim() ? oidc.config.label.trim() : 'Single sign-on'
    providers.push({ kind: 'oidc', label })
  }
  if (saml?.enabled) {
    const label = typeof saml.config?.label === 'string' && saml.config.label.trim() ? saml.config.label.trim() : 'Single sign-on'
    providers.push({ kind: 'saml', label })
  }
  return json({ providers })
})
