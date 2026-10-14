import { db } from '@/lib/db'
import { ApiError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { assertSlotAvailable } from '@/lib/business/availability'
import { parseJson } from '@/lib/org'
import type { OrgPolicies } from '@/lib/org'

export type Actor = { type: 'user' | 'ai' | 'system'; id: string }

export type CreateBookingInput = {
  customerId: string
  serviceId: string
  staffId?: string | null
  startAt: string
  source?: 'manual' | 'ai_chat' | 'ai_voice' | 'web' | 'import'
  notes?: string
}

/**
 * Create a booking. Availability is re-validated INSIDE a serialized transaction;
 * the confirmation returned to the caller only exists after that transaction commits.
 */
export async function createBooking(orgId: string, org: { timezone: string; holidays: string }, input: CreateBookingInput, actor: Actor) {
  const service = await db.service.findFirst({ where: { id: input.serviceId, orgId } })
  if (!service || !service.active) throw new ApiError(404, 'Service not found or inactive', 'service_not_found')
  const customer = await db.customer.findFirst({ where: { id: input.customerId, orgId } })
  if (!customer) throw new ApiError(404, 'Customer not found', 'customer_not_found')

  if (input.staffId) {
    const staff = await db.staff.findFirst({ where: { id: input.staffId, orgId, active: true } })
    if (!staff) throw new ApiError(404, 'Staff member not found or inactive', 'staff_not_found')
    const linked = await db.staffService.findUnique({ where: { staffId_serviceId: { staffId: input.staffId, serviceId: input.serviceId } } })
    if (!linked) throw new ApiError(422, 'That staff member does not provide this service', 'staff_service_mismatch')
  }

  const startAt = new Date(input.startAt)
  if (isNaN(startAt.getTime())) throw new ApiError(422, 'Invalid start time', 'invalid_start')
  if (startAt.getTime() < Date.now() - 60_000) throw new ApiError(422, 'Start time is in the past', 'start_in_past')

  const endAt = new Date(startAt.getTime() + service.durationMin * 60_000)
  const policies = parseJson<OrgPolicies>((await db.organization.findUnique({ where: { id: orgId }, select: { policies: true } }))?.policies, {})
  const needsDeposit = service.requiresDeposit && policies.deposit?.requiredForBooking !== false
  const status = needsDeposit ? 'pending' : policies.autoConfirmBookings === false ? 'pending' : 'confirmed'

  const booking = await db.$transaction(async (tx) => {
    await assertSlotAvailable(tx as never, { id: orgId, timezone: org.timezone, holidays: org.holidays }, service, input.staffId ?? null, startAt)
    return tx.booking.create({
      data: {
        orgId,
        customerId: input.customerId,
        serviceId: input.serviceId,
        staffId: input.staffId ?? null,
        startAt,
        endAt,
        status,
        source: input.source ?? 'manual',
        notes: input.notes ?? '',
        priceCents: service.priceCents,
      },
    })
  })

  await audit({
    orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'booking.created',
    entity: 'booking',
    entityId: booking.id,
    meta: { serviceId: input.serviceId, customerId: input.customerId, startAt: startAt.toISOString(), status, source: input.source ?? 'manual' },
  })

  return booking
}

export async function rescheduleBooking(orgId: string, org: { timezone: string; holidays: string }, bookingId: string, newStartAt: string, actor: Actor) {
  const existing = await db.booking.findFirst({ where: { id: bookingId, orgId } })
  if (!existing) throw new ApiError(404, 'Booking not found', 'not_found')
  if (['cancelled', 'completed'].includes(existing.status)) {
    throw new ApiError(409, `Cannot reschedule a ${existing.status} booking`, 'not_reschedulable')
  }
  const service = await db.service.findFirst({ where: { id: existing.serviceId, orgId } })
  if (!service) throw new ApiError(404, 'Service not found', 'service_not_found')

  const startAt = new Date(newStartAt)
  if (isNaN(startAt.getTime())) throw new ApiError(422, 'Invalid start time', 'invalid_start')
  const endAt = new Date(startAt.getTime() + service.durationMin * 60_000)

  const updated = await db.$transaction(async (tx) => {
    await assertSlotAvailable(tx as never, { id: orgId, timezone: org.timezone, holidays: org.holidays }, service, existing.staffId, startAt, existing.id)
    return tx.booking.update({ where: { id: existing.id }, data: { startAt, endAt } })
  })

  await audit({ orgId, actorType: actor.type, actorId: actor.id, action: 'booking.rescheduled', entity: 'booking', entityId: bookingId, meta: { newStartAt: startAt.toISOString() } })
  return updated
}

export async function cancelBooking(orgId: string, bookingId: string, reason: string, actor: Actor) {
  const existing = await db.booking.findFirst({ where: { id: bookingId, orgId } })
  if (!existing) throw new ApiError(404, 'Booking not found', 'not_found')
  if (existing.status === 'cancelled') return existing
  if (existing.status === 'completed') throw new ApiError(409, 'Cannot cancel a completed booking', 'not_cancellable')

  const updated = await db.booking.update({ where: { id: existing.id }, data: { status: 'cancelled', cancelReason: reason } })
  await audit({ orgId, actorType: actor.type, actorId: actor.id, action: 'booking.cancelled', entity: 'booking', entityId: bookingId, meta: { reason } })
  return updated
}

export async function setBookingStatus(orgId: string, bookingId: string, status: 'confirmed' | 'completed' | 'no_show', actor: Actor) {
  const existing = await db.booking.findFirst({ where: { id: bookingId, orgId } })
  if (!existing) throw new ApiError(404, 'Booking not found', 'not_found')
  const updated = await db.booking.update({ where: { id: existing.id }, data: { status } })
  await audit({ orgId, actorType: actor.type, actorId: actor.id, action: 'booking.status_changed', entity: 'booking', entityId: bookingId, meta: { status } })
  return updated
}
