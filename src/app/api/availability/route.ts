import { withAuth, json, ApiError } from '@/lib/api'
import { parseJson } from '@/lib/org'
import { computeSlots } from '@/lib/business/availability'

const MAX_SLOTS = 200

/**
 * GET /api/availability?serviceId=&from=ISO&to=ISO&staffId=
 * Bookable slots for a service (optionally for one staff member).
 * from defaults to now, to defaults to now + 7 days. Response is capped.
 */
export const GET = withAuth(async (req, ctx) => {
  const url = new URL(req.url)
  const serviceId = url.searchParams.get('serviceId')
  if (!serviceId) {
    throw new ApiError(422, 'serviceId query parameter is required', 'missing_service')
  }

  const fromRaw = url.searchParams.get('from')
  const toRaw = url.searchParams.get('to')
  const from = fromRaw ? new Date(fromRaw) : new Date()
  const to = toRaw ? new Date(toRaw) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    throw new ApiError(422, 'from and to must be valid ISO datetimes', 'invalid_range')
  }
  if (to.getTime() <= from.getTime()) {
    throw new ApiError(422, "'to' must be after 'from'", 'invalid_range')
  }

  const staffId = url.searchParams.get('staffId') || null

  const slots = await computeSlots(
    ctx.org.id,
    { serviceId, staffId, from, to },
    ctx.org.timezone,
    parseJson<string[]>(ctx.org.holidays, [])
  )

  return json({ slots: slots.slice(0, MAX_SLOTS), total: slots.length })
})
