import { z } from 'zod'
import { withAuth, json, parseBody } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { normalizeReceptionistStatus, RECEPTIONIST_STATUS_META } from '@/lib/receptionist/status'

const patchSchema = z.object({
  status: z.enum(['running', 'paused', 'stopped']),
})

/**
 * GET /api/settings/receptionist — the receptionist runtime switch for the org.
 * The value is non-secret — every signed-in caller can read it so the UI and the
 * inbound webhooks behave accordingly.
 */
export const GET = withAuth(async (_req, ctx) => {
  const status = normalizeReceptionistStatus(ctx.org.receptionistStatus)
  const meta = RECEPTIONIST_STATUS_META[status]
  return json({ status, label: meta.label, detail: meta.detail })
})

/**
 * PATCH /api/settings/receptionist (owner/admin) {status}
 * Pausing or stopping the assistant is a deliberate operator action — every change
 * is audited with the before/after value.
 */
export const PATCH = withAuth(
  async (req, ctx) => {
    const body = await parseBody(req, patchSchema)
    const next = normalizeReceptionistStatus(body.status)
    const previous = normalizeReceptionistStatus(ctx.org.receptionistStatus)
    if (previous !== next) {
      await db.organization.update({ where: { id: ctx.org.id }, data: { receptionistStatus: next } })
    }
    await audit({
      orgId: ctx.org.id, actorType: 'user', actorId: ctx.user.id,
      action: 'settings.receptionist_changed', entity: 'organization', entityId: ctx.org.id,
      meta: { from: previous, to: next },
    })
    return json({ status: next, changed: previous !== next })
  },
  { roles: ['owner', 'admin'] }
)
