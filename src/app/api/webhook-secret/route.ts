import { withAuth, json } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { randomToken } from '@/lib/crypto'

/**
 * GET /api/webhook-secret (owner/admin) — reveals the CURRENT inbound webhook
 * signing secret on demand. This is the org's own secret for ITS webhook
 * endpoint (like a Stripe whsec shown in the dashboard); every reveal is
 * audited. Rotate via PUT when it may have leaked.
 */
export const GET = withAuth(
  async (req, ctx) => {
    const row = await db.appSetting.findUnique({ where: { orgId_key: { orgId: ctx.org.id, key: 'webhook_secret' } } })
    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'settings.webhook_secret_viewed',
      entity: 'app_setting',
      entityId: 'webhook_secret',
    })
    return json({ secret: row?.value ?? null })
  },
  { roles: ['owner', 'admin'] }
)

/**
 * PUT /api/webhook-secret (owner/admin) — rotate the org webhook secret.
 * The raw string is stored in AppSetting 'webhook_secret' (NOT JSON-wrapped,
 * so getWebhookSecret reads it back verbatim). The secret is returned exactly
 * once, over HTTPS — this response is the only time it is ever visible.
 */
export const PUT = withAuth(
  async (req, ctx) => {
    const secret = randomToken(32)

    await db.appSetting.upsert({
      where: { orgId_key: { orgId: ctx.org.id, key: 'webhook_secret' } },
      create: { orgId: ctx.org.id, key: 'webhook_secret', value: secret },
      update: { value: secret },
    })

    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'settings.webhook_secret_rotated',
      entity: 'app_setting',
      entityId: 'webhook_secret',
    })

    return json({ secret })
  },
  { roles: ['owner', 'admin'] }
)
