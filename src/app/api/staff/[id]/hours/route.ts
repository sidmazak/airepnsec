import { z } from 'zod'
import { withAuth, json, parseBody, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'

const hourSchema = z
  .object({
    dow: z.number().int().min(0, 'dow is 0 (Sunday) .. 6 (Saturday)').max(6),
    startMin: z.number().int().min(0).max(1439),
    endMin: z.number().int().min(1).max(1440),
  })
  .refine((h) => h.endMin > h.startMin, { message: 'endMin must be after startMin' })

const schema = z.object({
  hours: z.array(hourSchema).max(56, 'Too many windows'),
})

/**
 * PUT /api/staff/[id]/hours {hours: [{dow, startMin, endMin}]}
 * Replaces this staff member's personal working hours (the full set).
 */
export const PUT = withAuth(async (req, ctx, params) => {
  const staff = await db.staff.findFirst({ where: { id: params.id, orgId: ctx.org.id } })
  if (!staff) throw new ApiError(404, 'Staff member not found', 'not_found')

  const { hours } = await parseBody(req, schema)

  await db.$transaction(async (tx) => {
    await tx.workingHour.deleteMany({ where: { orgId: ctx.org.id, staffId: staff.id } })
    for (const h of hours) {
      await tx.workingHour.create({
        data: { orgId: ctx.org.id, staffId: staff.id, dow: h.dow, startMin: h.startMin, endMin: h.endMin },
      })
    }
  })

  await audit({
    orgId: ctx.org.id,
    actorType: 'user',
    actorId: ctx.user.id,
    action: 'staff.hours_updated',
    entity: 'staff',
    entityId: staff.id,
    meta: { staffId: staff.id, windows: hours.length },
  })

  const saved = await db.workingHour.findMany({
    where: { orgId: ctx.org.id, staffId: staff.id },
    orderBy: [{ dow: 'asc' }, { startMin: 'asc' }],
  })
  return json({ ok: true, hours: saved })
}, { roles: ['owner', 'admin'] })
