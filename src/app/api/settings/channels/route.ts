import { z } from 'zod'
import { withAuth, json, parseBody } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { setSetting } from '@/lib/org'

/**
 * Channel settings use AppSetting presence as the source of truth:
 * a `channel_email` / `channel_sms` row means "configured". In this build no
 * SMTP/SMS sender is wired — outbound messages stay honestly "queued" in the
 * outbox with an explicit statusReason.
 */

/** GET /api/settings/channels */
export const GET = withAuth(async (req, ctx) => {
  const rows = await db.appSetting.findMany({
    where: { orgId: ctx.org.id, key: { in: ['channel_email', 'channel_sms'] } },
    select: { key: true },
  })
  return json({
    email: rows.some((r) => r.key === 'channel_email'),
    sms: rows.some((r) => r.key === 'channel_sms'),
  })
})

const putSchema = z.object({
  email: z.boolean(),
  sms: z.boolean(),
})

/** PUT /api/settings/channels {email, sms} — write/remove the channel rows (owner/admin). */
export const PUT = withAuth(
  async (req, ctx) => {
    const body = await parseBody(req, putSchema)

    if (body.email) await setSetting(ctx.org.id, 'channel_email', true)
    else await db.appSetting.deleteMany({ where: { orgId: ctx.org.id, key: 'channel_email' } })

    if (body.sms) await setSetting(ctx.org.id, 'channel_sms', true)
    else await db.appSetting.deleteMany({ where: { orgId: ctx.org.id, key: 'channel_sms' } })

    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'settings.channels_updated',
      entity: 'app_setting',
      meta: { email: body.email, sms: body.sms },
    })

    return json({ email: body.email, sms: body.sms })
  },
  { roles: ['owner', 'admin'] }
)
