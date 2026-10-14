import { z } from 'zod'
import { withAuth, json, parseBody, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { createBooking } from '@/lib/business/booking'

function parseDateOr422(raw: string | null, label: string): Date | undefined {
  if (!raw) return undefined
  const d = new Date(raw)
  if (isNaN(d.getTime())) throw new ApiError(422, `${label} must be a valid ISO datetime`, 'invalid_date')
  return d
}

/**
 * GET /api/bookings?from&to&status&customerId
 * Range defaults to today → +30 days on startAt. Ordered by startAt.
 */
export const GET = withAuth(async (req, ctx) => {
  const url = new URL(req.url)

  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const from = parseDateOr422(url.searchParams.get('from'), 'from') ?? startOfToday
  const to = parseDateOr422(url.searchParams.get('to'), 'to') ?? new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000)
  if (to.getTime() < from.getTime()) throw new ApiError(422, "'to' is before 'from'", 'invalid_range')

  const status = url.searchParams.get('status') || undefined
  const customerId = url.searchParams.get('customerId') || undefined

  const bookings = await db.booking.findMany({
    where: {
      orgId: ctx.org.id,
      startAt: { gte: from, lte: to },
      ...(status ? { status } : {}),
      ...(customerId ? { customerId } : {}),
    },
    orderBy: { startAt: 'asc' },
    take: 500,
    include: {
      customer: { select: { id: true, name: true } },
      service: { select: { id: true, name: true } },
      staff: { select: { id: true, name: true } },
    },
  })

  return json({ bookings })
})

const createSchema = z.object({
  customerId: z.string().min(1, 'customerId is required'),
  serviceId: z.string().min(1, 'serviceId is required'),
  staffId: z.string().min(1).nullable().optional(),
  startAt: z.string().min(1, 'startAt is required'),
  notes: z.string().max(4000).optional(),
})

/**
 * POST /api/bookings {customerId, serviceId, staffId?, startAt, notes?}
 * Delegates to createBooking — availability is re-validated inside a
 * serialized transaction and the booking is audited there.
 */
export const POST = withAuth(async (req, ctx) => {
  const body = await parseBody(req, createSchema)

  const booking = await createBooking(
    ctx.org.id,
    { timezone: ctx.org.timezone, holidays: ctx.org.holidays },
    {
      customerId: body.customerId,
      serviceId: body.serviceId,
      staffId: body.staffId ?? null,
      startAt: body.startAt,
      notes: body.notes,
      source: 'manual',
    },
    { type: 'user', id: ctx.user.id }
  )

  return json(booking, 201)
})
