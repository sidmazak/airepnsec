import { z } from 'zod'
import { withAuth, json, parseBody, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { getChannelReadinessMap } from '@/lib/integrations/readiness'

const schema = z.object({
  channel: z.enum(['email', 'sms', 'inapp']).default('email'),
})

function fmtWhen(startAt: Date, endAt: Date): string {
  return `${startAt.toISOString().slice(0, 10)} ${startAt.toISOString().slice(11, 16)}–${endAt
    .toISOString()
    .slice(11, 16)} UTC`
}

/**
 * POST /api/bookings/[id]/remind {channel?: 'email'|'sms'|'inapp'}
 * Queues a booking reminder into the outbox with HONEST delivery states:
 * - email/sms: always 'queued'; statusReason explains when no enabled
 *   integration can actually deliver (computed from the integrations, not a
 *   toggle). The outbox dispatcher reports the real send result later.
 * - inapp: recorded as 'sent' (it is genuinely visible in the app).
 * Deduplicated per booking+channel+day.
 */
export const POST = withAuth(async (req, ctx, params) => {
  const { channel } = await parseBody(req, schema)

  const booking = await db.booking.findFirst({
    where: { id: params.id, orgId: ctx.org.id },
    include: {
      customer: true,
      service: { select: { name: true } },
    },
  })
  if (!booking) throw new ApiError(404, 'Booking not found', 'not_found')

  const recipient =
    channel === 'email' ? booking.customer.email : channel === 'sms' ? booking.customer.phone : booking.customer.id

  if (channel !== 'inapp' && !recipient) {
    // Honest failure record — visible in the outbox, never silently dropped.
    const failed = await db.outboxMessage.create({
      data: {
        orgId: ctx.org.id,
        channel,
        recipient: '',
        subject: `Appointment reminder — ${booking.service.name}`,
        body: `Reminder for ${booking.customer.name}: ${booking.service.name} at ${fmtWhen(booking.startAt, booking.endAt)}.`,
        status: 'failed',
        statusReason: `no ${channel} address on file for this customer`,
        relatedType: 'booking',
        relatedId: booking.id,
      },
    })
    return json({ queued: false, status: failed.status, statusReason: failed.statusReason, outboxId: failed.id }, 201)
  }

  const dayKey = new Date().toISOString().slice(0, 10)
  const dedupeKey = `booking_reminder:${booking.id}:${channel}:${dayKey}`
  const existing = await db.outboxMessage.findUnique({ where: { dedupeKey }, select: { id: true } })
  if (existing) {
    throw new ApiError(409, 'A reminder for this booking and channel was already queued today', 'duplicate')
  }

  const isExternal = channel !== 'inapp'
  const readiness = isExternal ? (await getChannelReadinessMap(ctx.org.id))[channel] : null
  const hasChannelConfigured = isExternal ? Boolean(readiness?.ready) : true

  const subject = `Appointment reminder — ${booking.service.name}`
  const body = `Hello ${booking.customer.name},\n\nThis is a reminder for your ${booking.service.name} appointment on ${fmtWhen(
    booking.startAt,
    booking.endAt
  )}.\n\n— ${ctx.org.name}`

  let msg
  try {
    msg = await db.outboxMessage.create({
      data: {
        orgId: ctx.org.id,
        channel,
        recipient,
        subject,
        body,
        status: isExternal ? 'queued' : 'sent',
        statusReason: isExternal && !hasChannelConfigured ? readiness?.detail ?? `no ${channel} integration enabled` : '',
        relatedType: 'booking',
        relatedId: booking.id,
        dedupeKey,
        ...(channel === 'inapp' ? { sentAt: new Date() } : {}),
      },
    })
  } catch (err) {
    // Lost a race against a concurrent identical reminder request.
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'P2002') {
      throw new ApiError(409, 'A reminder for this booking and channel was already queued today', 'duplicate')
    }
    throw err
  }

  await audit({
    orgId: ctx.org.id,
    actorType: 'user',
    actorId: ctx.user.id,
    action: 'booking.reminder_queued',
    entity: 'booking',
    entityId: booking.id,
    meta: { channel, status: msg.status, outboxId: msg.id },
  })

  return json({ queued: true, outboxId: msg.id, status: msg.status, statusReason: msg.statusReason }, 201)
}, { roles: ['owner', 'admin', 'agent'] })
