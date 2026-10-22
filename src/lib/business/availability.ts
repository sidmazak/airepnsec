import { db } from '@/lib/db'
import { ApiError } from '@/lib/api'
import { parseJson } from '@/lib/org'
import { parseOffsetMinutes, wallClockToUtc } from '@/lib/timezone'
import type { Service } from '@prisma/client'

export const ACTIVE_BOOKING_STATUSES = ['pending', 'confirmed'] as const

export type Slot = { startAt: string; endAt: string; staffId: string | null }

function atWallClock(dayStr: string, minutes: number, tzOffsetMin: number): Date {
  return wallClockToUtc(dayStr, minutes, tzOffsetMin)
}

function parseOffset(timezone: string): number {
  return parseOffsetMinutes(timezone)
}

async function workingWindows(orgId: string, staffId: string | null, dow: number) {
  if (staffId) {
    // staff-specific hours override the org default when present
    const own = await db.workingHour.findMany({ where: { orgId, dow, staffId } })
    if (own.length > 0) return own.map((h) => ({ start: h.startMin, end: h.endMin })).filter((w) => w.end > w.start)
  }
  const hours = await db.workingHour.findMany({ where: { orgId, dow, staffId: null } })
  return hours.map((h) => ({ start: h.startMin, end: h.endMin })).filter((w) => w.end > w.start)
}

export type AvailabilityQuery = {
  serviceId: string
  staffId?: string | null
  from: Date
  to: Date
}

/** Compute bookable slots for a date range. Used by UI, wizard tests, and the assistant. */
export async function computeSlots(orgId: string, query: AvailabilityQuery, tz: string, holidays: string[]): Promise<Slot[]> {
  const service = await db.service.findFirst({ where: { id: query.serviceId, orgId, active: true } })
  if (!service) throw new ApiError(404, 'Service not found or inactive', 'service_not_found')

  const tzOff = parseOffset(tz)
  const holidaySet = new Set(holidays)
  const span = service.durationMin + service.bufferBeforeMin + service.bufferAfterMin

  const bookings = await db.booking.findMany({
    where: {
      orgId,
      status: { in: [...ACTIVE_BOOKING_STATUSES] },
      startAt: { gte: new Date(query.from.getTime() - 1000 * 60 * 60 * 26), lte: query.to },
      ...(query.staffId ? { staffId: query.staffId } : {}),
    },
    select: { startAt: true, endAt: true, staffId: true, serviceId: true },
  })
  const svcMap = new Map((await db.service.findMany({ where: { orgId } })).map((s) => [s.id, s]))

  // External busy windows (Google Calendar free/busy, manual blocks). A block
  // without a staff member blocks the whole business; a staff block only blocks
  // that staff member. In pool mode every block counts (conservative).
  const blocks = await db.calendarBlock.findMany({
    where: { orgId, startAt: { lt: query.to }, endAt: { gt: query.from } },
    select: { startAt: true, endAt: true, staffId: true },
  })

  // effective busy intervals include each booking's buffers
  const busy = bookings.map((b) => {
    const s = svcMap.get(b.serviceId)
    return {
      start: b.startAt.getTime() - (s?.bufferBeforeMin ?? 0) * 60_000,
      end: b.endAt.getTime() + (s?.bufferAfterMin ?? 0) * 60_000,
      staffId: b.staffId,
    }
  })

  for (const block of blocks) {
    if (query.staffId && block.staffId && block.staffId !== query.staffId) continue
    busy.push({ start: block.startAt.getTime(), end: block.endAt.getTime(), staffId: block.staffId })
  }

  const slots: Slot[] = []
  const dayCursor = new Date(query.from)
  dayCursor.setUTCHours(0, 0, 0, 0)
  const endMs = query.to.getTime()

  while (dayCursor.getTime() < endMs + 1000 * 60 * 60 * 26) {
    const day = new Date(dayCursor.getTime() + tzOff * 60_000).toISOString().slice(0, 10)
    const dow = new Date(dayCursor.getTime() + tzOff * 60_000).getUTCDay()
    if (!holidaySet.has(day)) {
      const windows = await workingWindows(orgId, query.staffId ?? null, dow)
      for (const w of windows) {
        for (let t = w.start; t + span <= w.end; t += 15) {
          const busyStart = atWallClock(day, t, tzOff).getTime()
          const candStart = atWallClock(day, t + service.bufferBeforeMin, tzOff).getTime()
          const candEnd = atWallClock(day, t + service.bufferBeforeMin + service.durationMin, tzOff).getTime()
          const busyEnd = atWallClock(day, t + span, tzOff).getTime()
          if (candStart < query.from.getTime() || candEnd > endMs) continue

          if (query.staffId) {
            const overlap = busy.some((b) => b.start < busyEnd && b.end > busyStart)
            if (!overlap) slots.push({ startAt: new Date(candStart).toISOString(), endAt: new Date(candEnd).toISOString(), staffId: query.staffId })
          } else {
            // Pool model (no staff assigned): a booking consumes capacity regardless of
            // whether it was made for a specific staff member or the general pool.
            // Conservative by design — prevents double-booking shared resources.
            const overlapping = busy.filter((b) => b.start < busyEnd && b.end > busyStart).length
            if (overlapping < service.maxPerSlot) {
              slots.push({ startAt: new Date(candStart).toISOString(), endAt: new Date(candEnd).toISOString(), staffId: null })
            }
          }
        }
      }
    }
    dayCursor.setUTCDate(dayCursor.getUTCDate() + 1)
  }

  return slots
}

/**
 * Authoritative availability check performed INSIDE the booking transaction so the
 * conflict check and the insert are serialized together.
 */
export async function assertSlotAvailable(
  tx: {
    booking: { findMany: (args: unknown) => Promise<Array<{ startAt: Date; endAt: Date; serviceId: string }>> },
    calendarBlock?: { findMany: (args: unknown) => Promise<Array<{ startAt: Date; endAt: Date; staffId: string | null }>> },
  },
  org: { id: string; timezone: string; holidays: string },
  service: Service,
  staffId: string | null,
  startAt: Date,
  ignoreBookingId?: string
): Promise<void> {
  const tzOff = parseOffset(org.timezone)
  const start = startAt.getTime()
  const end = start + service.durationMin * 60_000
  const busyStart = start - service.bufferBeforeMin * 60_000
  const busyEnd = end + service.bufferAfterMin * 60_000

  const wall = new Date(start + tzOff * 60_000)
  const dayStr = wall.toISOString().slice(0, 10)
  const holidays = parseJson<string[]>(org.holidays, [])
  if (holidays.includes(dayStr)) throw new ApiError(409, 'That date is a business holiday.', 'holiday')

  const dow = wall.getUTCDay()
  const windows = await workingWindows(org.id, staffId, dow)
  const fits = windows.some((w) => {
    const wStart = atWallClock(dayStr, w.start, tzOff).getTime()
    const wEnd = atWallClock(dayStr, w.end, tzOff).getTime()
    return busyStart >= wStart && busyEnd <= wEnd
  })
  if (!fits) throw new ApiError(409, 'That time is outside working hours (including buffers).', 'outside_hours')

  const conflicting = await tx.booking.findMany({
    where: {
      orgId: org.id,
      status: { in: [...ACTIVE_BOOKING_STATUSES] },
      // staff-specific check: conflicts with that staff member's bookings.
      // pool check (no staff): conflicts with ANY booking (conservative shared-resource model).
      ...(staffId ? { staffId } : {}),
      ...(ignoreBookingId ? { id: { not: ignoreBookingId } } : {}),
    },
    select: { startAt: true, endAt: true, serviceId: true },
  })

  const svcIds = [...new Set(conflicting.map((c) => c.serviceId))]
  const svcMap = new Map(
    svcIds.length ? (await db.service.findMany({ where: { id: { in: svcIds } } })).map((s) => [s.id, s]) : []
  )

  const overlaps = conflicting.filter((c) => {
    const s = svcMap.get(c.serviceId)
    const cStart = c.startAt.getTime() - (s?.bufferBeforeMin ?? 0) * 60_000
    const cEnd = c.endAt.getTime() + (s?.bufferAfterMin ?? 0) * 60_000
    return cStart < busyEnd && cEnd > busyStart
  })

  if (staffId) {
    if (overlaps.length > 0) throw new ApiError(409, 'That time conflicts with an existing appointment.', 'slot_conflict')
  } else {
    // Pool model: count bookings for ANY staff member (see computeSlots) — conservative.
    if (overlaps.length >= service.maxPerSlot) throw new ApiError(409, 'That time is fully booked.', 'slot_conflict')
  }

  // External busy windows (Google Calendar free/busy, manual blocks) also make a
  // slot unbookable — the promise to the customer must match the real diary.
  const blockFinder = tx.calendarBlock ?? db.calendarBlock
  const blocks = await blockFinder.findMany({
    where: {
      orgId: org.id,
      startAt: { lt: new Date(busyEnd) },
      endAt: { gt: new Date(busyStart) },
      ...(staffId ? { OR: [{ staffId: null }, { staffId }] } : {}),
    },
    select: { startAt: true, endAt: true, staffId: true },
  })
  if (blocks.length > 0) {
    throw new ApiError(409, 'That time is blocked on the connected calendar — offer another slot.', 'slot_blocked')
  }
}
