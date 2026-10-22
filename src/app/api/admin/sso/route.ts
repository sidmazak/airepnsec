import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, json, parseBody, fail } from '@/lib/api'
import { listSsoConfigs, publicSsoConfig } from '@/lib/sso'
import { SSO_KINDS } from '@/lib/security/sso'

/**
 * GET /api/admin/sso
 * The organisation's federated sign-in configuration. Secrets are never returned —
 * only whether they are present.
 */
export const GET = withAuth(
  async (_req: NextRequest, ctx) => {
    const configs = await listSsoConfigs(ctx.org.id)
    return json({
      sso: configs.map(publicSsoConfig),
      kinds: SSO_KINDS,
    })
  },
  { roles: ['owner', 'admin'] }
)

const putSchema = z.object({
  kind: z.enum(SSO_KINDS),
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()),
  secrets: z.record(z.string(), z.string()).optional(),
})

/**
 * PUT /api/admin/sso
 * Save the federated sign-in configuration for one protocol.
 */
export const PUT = withAuth(
  async (req: NextRequest, ctx) => {
    const body = await parseBody(req, putSchema)
    const { saveSsoConfig } = await import('@/lib/sso')
    await saveSsoConfig({
      orgId: ctx.org.id,
      kind: body.kind,
      enabled: body.enabled,
      config: body.config,
      secrets: body.secrets,
      actorId: ctx.user.id,
    })
    const configs = await listSsoConfigs(ctx.org.id)
    return json({ ok: true, sso: configs.map(publicSsoConfig) })
  },
  { roles: ['owner', 'admin'] }
)
