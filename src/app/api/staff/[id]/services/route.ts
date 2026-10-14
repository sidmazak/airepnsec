import { z } from 'zod'
import { withAuth, json, parseBody, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'

const schema = z.object({
  serviceIds: z.array(z.string().min(1)).max(100),
})

/**
 * PUT /api/staff/[id]/services {serviceIds: []}
 * Replaces the set of services this staff member provides.
 * Every serviceId must belong to the organization.
 */
export const PUT = withAuth(async (req, ctx, params) => {
  const staff = await db.staff.findFirst({ where: { id: params.id, orgId: ctx.org.id } })
  if (!staff) throw new ApiError(404, 'Staff member not found', 'not_found')

  const body = await parseBody(req, schema)
  const serviceIds = [...new Set(body.serviceIds)]

  if (serviceIds.length > 0) {
    const known = await db.service.count({ where: { id: { in: serviceIds }, orgId: ctx.org.id } })
    if (known !== serviceIds.length) {
      throw new ApiError(422, 'One or more services do not exist in this organization', 'unknown_service')
    }
  }

  await db.$transaction(async (tx) => {
    await tx.staffService.deleteMany({ where: { staffId: staff.id } })
    for (const serviceId of serviceIds) {
      await tx.staffService.create({ data: { staffId: staff.id, serviceId } })
    }
  })

  await audit({
    orgId: ctx.org.id,
    actorType: 'user',
    actorId: ctx.user.id,
    action: 'staff.services_updated',
    entity: 'staff',
    entityId: staff.id,
    meta: { serviceIds },
  })

  return json({ ok: true, staffId: staff.id, serviceIds })
})
