import { z } from 'zod'
import { withAuth, json, parseBody, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { cancelBooking, rescheduleBooking } from '@/lib/business/booking'
import { ensureMicrosoftAccessToken, findMicrosoftIntegration } from '@/lib/integrations/microsoftAuth'
import {
  buildGraphEvent,
  deleteGraphEvent,
  listGraphEvents,
  queryGraphSchedule,
  readBookingId,
  upsertGraphEvent,
  type MicrosoftGraphEvent,
} from '@/lib/integrations/microsoftGraph'

const bodySchema = z.object({
  days: z.coerce.number().int().min(1).max(120).optional(),
  direction: z.enum(['push', 'pull', 'both']).optional(),
})

type PullResult = {
  bookingId: string
  action: 'cancelled' | 'rescheduled' | 'unchanged' | 'removed' | 'failed'
  detail: string
}

function graphEventRange(ev: MicrosoftGraphEvent): { start: Date; end: Date } | null {
  const start = ev.start?.dateTime ? new Date(ev.start.dateTime) : null
  const end = ev.end?.dateTime ? new Date(ev.end.dateTime) : null
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null
  return { start, end }
}

/**
 * POST /api/integrations/microsoft-calendar/sync (owner/admin)
 * Two-way sync with Microsoft 365 through the Graph API — the same behaviour as
 * the Google Calendar sync:
 *  - pull: remote events that carry our booking marker are read back (a cancelled
 *    remote event cancels the booking, a moved event reschedules it through the
 *    validated booking service, events of cancelled bookings are removed);
 *  - pull: the free/busy schedule becomes CalendarBlock rows so busy diary time
 *    is never offered;
 *  - push: upcoming bookings are written as Graph events (idempotent through the
 *    booking marker in the event body).
 * Every item carries a real result — never a fake success.
 */
export const POST = withAuth(
  async (req, ctx) => {
    const body = await parseBody(req, bodySchema).catch(() => ({ days: 45, direction: 'both' as const }))
    if (!['owner', 'admin'].includes(ctx.role)) throw new ApiError(403, 'Requires owner or admin role', 'forbidden')

    const integration = await findMicrosoftIntegration(ctx.org.id)
    if (!integration) throw new ApiError(404, 'No Microsoft 365 integration configured yet — add one in Integrations first', 'not_found')
    if (!integration.enabled) throw new ApiError(409, 'The Microsoft 365 integration is disabled — enable it before syncing', 'disabled')

    const origin = new URL(req.url).origin
    const { token, state } = await ensureMicrosoftAccessToken(integration, origin)

    const direction = body.direction ?? 'both'
    const days = body.days ?? 45
    const now = new Date()
    const horizon = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)

    const pullResults: PullResult[] = []
    const errors: string[] = []
    let blocksAdded = 0
    let blocksRemoved = 0
    let blocksKept = 0

    /* ---------- 1. read our own events back (cancel / move / cleanup) ---------- */
    const eventIds = new Map<string, string>() // bookingId -> graph event id
    if (direction !== 'push') {
      const { events, error } = await listGraphEvents({ token, timeMin: now, timeMax: horizon })
      if (error) errors.push(`event list failed: ${error}`)
      for (const ev of events) {
        const bookingId = readBookingId(ev)
        if (!bookingId) continue
        if (ev.id) eventIds.set(bookingId, ev.id)
        const booking = await db.booking.findFirst({ where: { id: bookingId, orgId: ctx.org.id } })
        if (!booking) continue
        if (booking.status === 'cancelled') {
          if (!ev.id) continue
          const removed = await deleteGraphEvent({ token, eventId: ev.id })
          pullResults.push({ bookingId, action: 'removed', detail: removed.detail })
          continue
        }
        if (ev.isCancelled) {
          await cancelBooking(ctx.org.id, booking.id, 'Cancelled in Microsoft 365', { type: 'system', id: 'microsoft-calendar-sync' })
          pullResults.push({ bookingId, action: 'cancelled', detail: 'remote event cancelled → booking cancelled' })
          continue
        }
        const range = graphEventRange(ev)
        if (range && Math.abs(range.start.getTime() - booking.startAt.getTime()) > 60_000) {
          try {
            await rescheduleBooking(ctx.org.id, ctx.org, booking.id, range.start.toISOString(), { type: 'system', id: 'microsoft-calendar-sync' })
            pullResults.push({ bookingId, action: 'rescheduled', detail: `remote time changed → ${range.start.toISOString()}` })
          } catch (err) {
            pullResults.push({ bookingId, action: 'failed', detail: err instanceof Error ? err.message : 'unknown error' })
          }
          continue
        }
        pullResults.push({ bookingId, action: 'unchanged', detail: 'no remote changes' })
      }
    }

    /* ---------- 2. free/busy → CalendarBlock rows ---------- */
    if (direction !== 'push') {
      const email = state.calendarEmail || (await primaryCalendarEmail(token))
      if (!email) {
        errors.push('no calendar address known — set "calendarEmail" in the integration config to read the free/busy schedule')
      } else {
        const { busy, errors: scheduleErrors } = await queryGraphSchedule({ token, timeMin: now, timeMax: horizon, email })
        errors.push(...scheduleErrors)

        const localBookings = await db.booking.findMany({
          where: { orgId: ctx.org.id, startAt: { gte: now, lt: horizon } },
          select: { startAt: true, endAt: true },
        })
        const isOwnEvent = (start: Date, end: Date) =>
          localBookings.some((b) => Math.abs(b.startAt.getTime() - start.getTime()) < 90_000 && Math.abs(b.endAt.getTime() - end.getTime()) < 90_000)

        const existing = await db.calendarBlock.findMany({
          where: { orgId: ctx.org.id, source: 'microsoft_calendar', endAt: { gt: now }, startAt: { lt: horizon } },
          select: { id: true, externalId: true, endAt: true },
        })
        const keep = new Set<string>()
        for (const interval of busy) {
          if (isOwnEvent(interval.start, interval.end)) continue
          const externalId = `freebusy:${email}:${interval.start.toISOString()}`
          keep.add(externalId)
          const match = existing.find((b) => b.externalId === externalId)
          if (match) {
            if (Math.abs(match.endAt.getTime() - interval.end.getTime()) > 1000) {
              await db.calendarBlock.update({ where: { id: match.id }, data: { endAt: interval.end } })
            }
            blocksKept++
          } else {
            await db.calendarBlock.create({
              data: {
                orgId: ctx.org.id,
                source: 'microsoft_calendar',
                externalId,
                title: 'Busy (Microsoft 365)',
                startAt: interval.start,
                endAt: interval.end,
              },
            })
            blocksAdded++
          }
        }
        for (const block of existing) {
          if (keep.has(block.externalId)) continue
          await db.calendarBlock.delete({ where: { id: block.id } })
          blocksRemoved++
        }
      }
    }

    /* ---------- 3. push upcoming bookings as Graph events ---------- */
    const pushResults: Array<{ bookingId: string; ok: boolean; detail: string; title: string }> = []
    if (direction !== 'pull') {
      const bookings = await db.booking.findMany({
        where: { orgId: ctx.org.id, startAt: { gte: now, lt: horizon }, status: { in: ['confirmed', 'pending'] } },
        include: {
          customer: { select: { name: true, email: true } },
          service: { select: { name: true } },
          staff: { select: { name: true } },
        },
        orderBy: { startAt: 'asc' },
        take: 500,
      })
      for (const booking of bookings) {
        const title = `${booking.service.name} — ${booking.customer.name}${booking.staff?.name ? ` (${booking.staff.name})` : ''}`
        const event = buildGraphEvent({
          bookingId: booking.id,
          title,
          description: `Booked via AI Secretary. Status: ${booking.status}. Notes: ${booking.notes || '—'}`,
          startAt: booking.startAt,
          endAt: booking.endAt,
          attendeeEmail: booking.customer.email || undefined,
          attendeeName: booking.customer.name,
        })
        const res = await upsertGraphEvent({ token, bookingId: booking.id, event, existingEventId: eventIds.get(booking.id) })
        pushResults.push({ bookingId: booking.id, ok: res.ok, detail: res.detail, title })
      }
    }

    const pulled = {
      cancelled: pullResults.filter((r) => r.action === 'cancelled').length,
      rescheduled: pullResults.filter((r) => r.action === 'rescheduled').length,
      unchanged: pullResults.filter((r) => r.action === 'unchanged').length,
      removed: pullResults.filter((r) => r.action === 'removed').length,
      failed: pullResults.filter((r) => r.action === 'failed').length,
      total: pullResults.length,
    }
    const pushed = pushResults.filter((r) => r.ok).length
    const failed = pushResults.length - pushed

    const summary = {
      at: now.toISOString(),
      direction,
      pushed,
      failed,
      total: pushResults.length,
      blocksAdded,
      blocksRemoved,
      blocksKept,
      pulled,
      errors,
    }
    await db.appSetting.upsert({
      where: { orgId_key: { orgId: ctx.org.id, key: `microsoft_sync:${integration.id}` } },
      create: { orgId: ctx.org.id, key: `microsoft_sync:${integration.id}`, value: JSON.stringify(summary) },
      update: { value: JSON.stringify(summary) },
    })

    await audit({
      orgId: ctx.org.id, actorType: 'user', actorId: ctx.user.id,
      action: 'integrations.microsoft_calendar_sync', entity: 'integration', entityId: integration.id,
      meta: { direction, pushed, failed, total: pushResults.length, blocksAdded, blocksRemoved, pulled },
    })

    return json({
      direction,
      pushed,
      failed,
      total: pushResults.length,
      results: pushResults.slice(0, 100),
      pulled,
      pullResults: pullResults.slice(0, 100),
      blocks: { added: blocksAdded, removed: blocksRemoved, kept: blocksKept },
      errors,
      syncedAt: now.toISOString(),
    })
  },
  { roles: ['owner', 'admin'] }
)

/** The signed-in user's primary mailbox address (used for the free/busy query). */
async function primaryCalendarEmail(token: string): Promise<string> {
  try {
    const res = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return ''
    const data = (await res.json()) as { mail?: string; userPrincipalName?: string }
    return data.mail || data.userPrincipalName || ''
  } catch {
    return ''
  }
}

/** GET — last sync summary for the UI. */
export const GET = withAuth(async (_req, ctx) => {
  const integration = await findMicrosoftIntegration(ctx.org.id)
  if (!integration) return json({ configured: false })
  const row = await db.appSetting.findUnique({ where: { orgId_key: { orgId: ctx.org.id, key: `microsoft_sync:${integration.id}` } } })
  const last = row ? (() => { try { return JSON.parse(row.value) as Record<string, unknown> } catch { return null } })() : null
  const blocks = await db.calendarBlock.count({ where: { orgId: ctx.org.id, source: 'microsoft_calendar', endAt: { gt: new Date() } } })
  return json({
    configured: true,
    enabled: integration.enabled,
    lastSync: last,
    activeBlocks: blocks,
    lastTestOk: integration.lastTestAt ? integration.lastTestOk : false,
    lastTestError: integration.lastTestError,
  })
})
