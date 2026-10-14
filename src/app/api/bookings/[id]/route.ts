import { z } from 'zod'
import { withAuth, json, parseBody, ApiError } from '@/lib/api'
import { rescheduleBooking, cancelBooking, setBookingStatus } from '@/lib/business/booking'

const schema = z.object({
  action: z.enum(['reschedule', 'cancel', 'confirm', 'complete', 'no_show']),
  startAt: z.string().min(1).optional(),
  reason: z.string().max(500).optional(),
})

/**
 * PATCH /api/bookings/[id] {action, startAt?, reason?}
 * Lifecycle transitions. Viewers have read-only access → 403 via roles.
 * All state changes and audits are performed by the booking service.
 */
export const PATCH = withAuth(
  async (req, ctx, params) => {
    const body = await parseBody(req, schema)
    const actor = { type: 'user' as const, id: ctx.user.id }

    switch (body.action) {
      case 'reschedule': {
        if (!body.startAt) throw new ApiError(422, 'startAt is required to reschedule', 'missing_start')
        const booking = await rescheduleBooking(
          ctx.org.id,
          { timezone: ctx.org.timezone, holidays: ctx.org.holidays },
          params.id,
          body.startAt,
          actor
        )
        return json(booking)
      }
      case 'cancel': {
        const booking = await cancelBooking(ctx.org.id, params.id, body.reason ?? '', actor)
        return json(booking)
      }
      case 'confirm':
        return json(await setBookingStatus(ctx.org.id, params.id, 'confirmed', actor))
      case 'complete':
        return json(await setBookingStatus(ctx.org.id, params.id, 'completed', actor))
      case 'no_show':
        return json(await setBookingStatus(ctx.org.id, params.id, 'no_show', actor))
    }
  },
  { roles: ['owner', 'admin', 'agent'] }
)
