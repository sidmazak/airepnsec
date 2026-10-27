import { z } from 'zod'
import { withAuth, json, parseBody } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { normalizeReceptionistStatus, RECEPTIONIST_STATUS_META } from '@/lib/receptionist/status'
import { SCHEDULE_SETTING_KEY, normalizeReceptionistSchedule } from '@/lib/receptionist/schedule'
import { resolveReceptionistStatus, readReceptionistSchedule } from '@/lib/receptionist/runtime'
import { setSetting } from '@/lib/org'

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:MM')

const scheduleSchema = z.object({
  enabled: z.boolean(),
  days: z.record(z.string(), z.object({ start: timeSchema, end: timeSchema }).nullable()).optional(),
  timezone: z.string().max(40).optional(),
})

const patchSchema = z
  .object({
    status: z.enum(['running', 'paused', 'stopped']).optional(),
    schedule: scheduleSchema.optional(),
  })
  .refine((data) => data.status !== undefined || data.schedule !== undefined, { message: 'Provide status and/or schedule' })

/**
 * GET /api/settings/receptionist — the runtime switch and weekly schedule for
 * the org. Non-secret; every signed-in caller can read it.
 */
export const GET = withAuth(async (_req, ctx) => {
  const resolved = await resolveReceptionistStatus(ctx.org)
  return json({
    status: resolved.status,
    baseStatus: resolved.baseStatus,
    scheduledOff: resolved.scheduledOff,
    nextOpenAt: resolved.nextOpenAt?.toISOString() ?? null,
    schedule: resolved.schedule,
    label: RECEPTIONIST_STATUS_META[resolved.status].label,
    detail: resolved.scheduledOff
      ? 'Outside the configured receptionist schedule — inbound is recorded for staff, but the assistant does not reply.'
      : RECEPTIONIST_STATUS_META[resolved.status].detail,
  })
})

/**
 * PATCH /api/settings/receptionist (owner/admin)
 * `{status}` changes the operator switch; `{schedule}` saves the weekly windows.
 * Both are audited with before/after values.
 */
export const PATCH = withAuth(
  async (req, ctx) => {
    const body = await parseBody(req, patchSchema)
    const previous = normalizeReceptionistStatus(ctx.org.receptionistStatus)
    let status = previous
    let scheduleChanged = false

    if (body.status !== undefined) {
      status = normalizeReceptionistStatus(body.status)
      if (status !== previous) {
        await db.organization.update({ where: { id: ctx.org.id }, data: { receptionistStatus: status } })
      }
      await audit({
        orgId: ctx.org.id, actorType: 'user', actorId: ctx.user.id,
        action: 'settings.receptionist_changed', entity: 'organization', entityId: ctx.org.id,
        meta: { from: previous, to: status },
      })
    }

    if (body.schedule !== undefined) {
      const before = await readReceptionistSchedule(ctx.org.id)
      const schedule = normalizeReceptionistSchedule(body.schedule)
      await setSetting(ctx.org.id, SCHEDULE_SETTING_KEY, schedule)
      scheduleChanged = true
      await audit({
        orgId: ctx.org.id, actorType: 'user', actorId: ctx.user.id,
        action: 'settings.receptionist_schedule_changed', entity: 'organization', entityId: ctx.org.id,
        meta: { enabled: schedule.enabled, from: before.enabled, to: schedule.enabled },
      })
    }

    const resolved = await resolveReceptionistStatus({ ...ctx.org, receptionistStatus: status })
    return json({
      status: resolved.status,
      baseStatus: resolved.baseStatus,
      scheduledOff: resolved.scheduledOff,
      nextOpenAt: resolved.nextOpenAt?.toISOString() ?? null,
      schedule: resolved.schedule,
      changed: status !== previous || scheduleChanged,
    })
  },
  { roles: ['owner', 'admin'] }
)
