import { z } from 'zod'
import { withAuth, json, parseBody } from '@/lib/api'
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
 * PUT /api/staff/hours {hours: [{dow, startMin, endMin}]}
 * Org-wide default working hours (staffId = null). Individual staff members
 * can override these via PUT /api/staff/[id]/hours.
 */
export const PUT = withAuth(async (req, ctx) => {
  const { hours } = await parseBody(req, schema)

  await db.$transaction(async (tx) => {
    await tx.workingHour.deleteMany({ where: { orgId: ctx.org.id, staffId: null } })
    for (const h of hours) {
      await tx.workingHour.create({
        data: { orgId: ctx.org.id, staffId: null, dow: h.dow, startMin: h.startMin, endMin: h.endMin },
      })
    }
  })

  await audit({
    orgId: ctx.org.id,
    actorType: 'user',
    actorId: ctx.user.id,
    action: 'staff.hours_updated',
    entity: 'organization',
    entityId: ctx.org.id,
    meta: { scope: 'org_wide', windows: hours.length },
  })

  const saved = await db.workingHour.findMany({
    where: { orgId: ctx.org.id, staffId: null },
    orderBy: [{ dow: 'asc' }, { startMin: 'asc' }],
  })
  return json({ ok: true, hours: saved })
})
