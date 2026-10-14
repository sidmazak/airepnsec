import { z } from 'zod'
import { withAuth, json, parseBody } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'

const schema = z.object({
  dataMode: z.enum(['local_only', 'hybrid', 'cloud_first']),
})

/**
 * PUT /api/settings/data-mode {dataMode} (owner/admin)
 * local_only hard-blocks cloud AI calls server-side (assertAiPolicy).
 */
export const PUT = withAuth(
  async (req, ctx) => {
    const body = await parseBody(req, schema)

    const org = await db.organization.update({
      where: { id: ctx.org.id },
      data: { dataMode: body.dataMode },
    })

    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'settings.data_mode_changed',
      entity: 'organization',
      entityId: org.id,
      meta: { dataMode: org.dataMode },
    })

    return json({ dataMode: org.dataMode })
  },
  { roles: ['owner', 'admin'] }
)
