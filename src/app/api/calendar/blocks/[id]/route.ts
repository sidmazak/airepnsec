import { withAuth, json, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'

/**
 * DELETE /api/calendar/blocks/[id] (owner/admin/agent) — remove a block and
 * make the affected slots bookable again.
 */
export const DELETE = withAuth(
  async (_req, ctx, params) => {
    const id = params.id ?? ''
    const block = await db.calendarBlock.findFirst({ where: { id, orgId: ctx.org.id } })
    if (!block) throw new ApiError(404, 'Block not found', 'not_found')
    await db.calendarBlock.delete({ where: { id: block.id } })
    await audit({
      orgId: ctx.org.id, actorType: 'user', actorId: ctx.user.id,
      action: 'calendar.block_deleted', entity: 'calendar_block', entityId: block.id,
      meta: { startAt: block.startAt.toISOString(), endAt: block.endAt.toISOString(), source: block.source },
    })
    return json({ deleted: true, id: block.id })
  },
  { roles: ['owner', 'admin', 'agent'] }
)
