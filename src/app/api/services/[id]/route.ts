import { z } from 'zod'
import { withAuth, json, parseBody, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'

const patchSchema = z
  .object({
    name: z.string().trim().min(1, 'Name cannot be empty').max(120),
    description: z.string().max(2000),
    category: z.string().trim().max(60),
    durationMin: z.number().int().min(5, 'Duration must be at least 5 minutes').max(24 * 60),
    priceCents: z.number().int().min(0, 'Price must be a non-negative integer (cents)'),
    bufferBeforeMin: z.number().int().min(0).max(240),
    bufferAfterMin: z.number().int().min(0).max(240),
    maxPerSlot: z.number().int().min(1).max(50),
    requiresDeposit: z.boolean(),
    depositCents: z.number().int().min(0),
    active: z.boolean(),
  })
  .partial()
  .refine((data) => Object.keys(data).length > 0, { message: 'No fields to update' })

async function getOrgService(orgId: string, id: string) {
  const service = await db.service.findFirst({ where: { id, orgId } })
  if (!service) throw new ApiError(404, 'Service not found', 'not_found')
  return service
}

/** PATCH /api/services/[id] — any subset of service fields (incl. active). */
export const PATCH = withAuth(async (req, ctx, params) => {
  const service = await getOrgService(ctx.org.id, params.id)
  const body = await parseBody(req, patchSchema)

  const updated = await db.service.update({ where: { id: service.id }, data: body })

  await audit({
    orgId: ctx.org.id,
    actorType: 'user',
    actorId: ctx.user.id,
    action: 'service.updated',
    entity: 'service',
    entityId: service.id,
    meta: { fields: Object.keys(body), name: updated.name },
  })

  return json(updated)
}, { roles: ['owner', 'admin'] })

/**
 * DELETE /api/services/[id]
 * A service with booking history is part of the record — refuse and suggest
 * deactivation (active:false) instead.
 */
export const DELETE = withAuth(async (req, ctx, params) => {
  const service = await getOrgService(ctx.org.id, params.id)

  const bookingCount = await db.booking.count({ where: { orgId: ctx.org.id, serviceId: service.id } })
  if (bookingCount > 0) {
    throw new ApiError(
      409,
      `Service has ${bookingCount} booking${bookingCount === 1 ? '' : 's'} and cannot be deleted — deactivate it instead (active: false)`,
      'has_bookings'
    )
  }

  await db.staffService.deleteMany({ where: { serviceId: service.id } })
  await db.service.delete({ where: { id: service.id } })

  await audit({
    orgId: ctx.org.id,
    actorType: 'user',
    actorId: ctx.user.id,
    action: 'service.deleted',
    entity: 'service',
    entityId: service.id,
    meta: { name: service.name },
  })

  return json({ ok: true })
}, { roles: ['owner', 'admin'] })
