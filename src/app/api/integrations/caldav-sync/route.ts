import { z } from 'zod'
import { withAuth, json, parseBody, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { caldavCreds, bookingToVEvent, putBookingEvent, fetchRemoteEvent, testCaldav } from '@/lib/integrations/caldav'
import { cancelBooking, rescheduleBooking } from '@/lib/business/booking'

const bodySchema = z.object({
  days: z.coerce.number().int().min(1).max(120).optional(),
  verifyFirst: z.boolean().optional(),
  direction: z.enum(['push', 'pull', 'both']).optional(),
})

type PullResult = {
  bookingId: string
  uid: string
  action: 'cancelled' | 'rescheduled' | 'unchanged' | 'missing' | 'failed'
  detail: string
}

/**
 * POST /api/integrations/caldav-sync (owner/admin)
 * Real two-way sync by default:
 * - push: upcoming bookings are written to the CalDAV collection as {uid}.ics (idempotent PUT);
 * - pull: previously pushed events are read back — remote STATUS:CANCELLED cancels the
 *   booking, a moved DTSTART reschedules it through the validated booking service. Remotely
 *   deleted events are reported as `missing` and deliberately do NOT cancel local bookings.
 * Every item carries a real result — never a fake success.
 */
export const POST = withAuth(async (req, ctx) => {
  const body = await parseBody(req, bodySchema).catch(() => ({ days: 45, verifyFirst: true, direction: 'both' as const }))
  if (!['owner', 'admin'].includes(ctx.role)) throw new ApiError(403, 'Requires owner or admin role', 'forbidden')

  const integration = await db.integration.findFirst({ where: { orgId: ctx.org.id, kind: 'caldav' } })
  if (!integration) throw new ApiError(404, 'No CalDAV integration configured yet — add one in Integrations first', 'not_found')
  if (!integration.enabled) throw new ApiError(409, 'The CalDAV integration is disabled — enable it before syncing', 'disabled')

  const creds = caldavCreds(integration)
  if (!creds) throw new ApiError(422, 'CalDAV integration is missing its calendar URL', 'bad_config')

  if (body.verifyFirst !== false) {
    const health = await testCaldav(integration)
    await db.integration.update({
      where: { id: integration.id },
      data: { lastTestAt: new Date(), lastTestOk: health.ok, lastTestError: health.ok ? '' : health.detail },
    })
    if (!health.ok) throw new ApiError(502, `CalDAV is not reachable: ${health.detail}`, 'health_check_failed')
  }

  const direction = body.direction ?? 'both'
  const now = new Date()
  const horizon = new Date(now.getTime() + (body.days ?? 45) * 24 * 60 * 60 * 1000)

  const pullResults: PullResult[] = []
  if (direction !== 'push') {
    const pullBookings = await db.booking.findMany({
      where: { orgId: ctx.org.id, startAt: { gte: now, lte: horizon }, status: { in: ['confirmed', 'pending'] } },
      orderBy: { startAt: 'asc' },
      take: 200,
    })
    for (const booking of pullBookings) {
      const uid = `booking-${booking.id}@${ctx.org.slug}`
      const remote = await fetchRemoteEvent(creds, uid)
      if (remote.kind === 'missing') {
        // Deliberate: a missing remote object may mean "never pushed" or "deleted there".
        // Cancelling on deletion alone would let an accidental calendar wipe cancel real
        // bookings, so this is reported for the operator and left to a human decision.
        pullResults.push({ bookingId: booking.id, uid, action: 'missing', detail: 'not on the remote calendar (never pushed, or deleted there) — local booking left unchanged' })
        continue
      }
      if (remote.kind === 'error') {
        pullResults.push({ bookingId: booking.id, uid, action: 'failed', detail: remote.detail })
        continue
      }
      const event = remote.event
      if (event.status === 'CANCELLED') {
        await cancelBooking(ctx.org.id, booking.id, 'Cancelled in the external calendar (CalDAV pull)', { type: 'system', id: 'caldav-sync' })
        pullResults.push({ bookingId: booking.id, uid, action: 'cancelled', detail: 'remote STATUS:CANCELLED → booking cancelled' })
        continue
      }
      if (event.dtstart && Math.abs(event.dtstart.getTime() - booking.startAt.getTime()) > 60_000) {
        try {
          await rescheduleBooking(ctx.org.id, ctx.org, booking.id, event.dtstart.toISOString(), { type: 'system', id: 'caldav-sync' })
          pullResults.push({ bookingId: booking.id, uid, action: 'rescheduled', detail: `remote DTSTART moved → ${event.dtstart.toISOString()}` })
        } catch (err) {
          pullResults.push({ bookingId: booking.id, uid, action: 'failed', detail: `remote time change could not be applied: ${err instanceof Error ? err.message : 'unknown error'}` })
        }
        continue
      }
      pullResults.push({ bookingId: booking.id, uid, action: 'unchanged', detail: 'no remote changes' })
    }
  }

  const pulled = {
    cancelled: pullResults.filter((r) => r.action === 'cancelled').length,
    rescheduled: pullResults.filter((r) => r.action === 'rescheduled').length,
    unchanged: pullResults.filter((r) => r.action === 'unchanged').length,
    missing: pullResults.filter((r) => r.action === 'missing').length,
    failed: pullResults.filter((r) => r.action === 'failed').length,
    total: pullResults.length,
  }

  const bookings = direction === 'pull' ? [] : await db.booking.findMany({
    where: { orgId: ctx.org.id, startAt: { gte: now, lte: horizon }, status: { in: ['confirmed', 'pending'] } },
    include: { customer: { select: { name: true } }, service: { select: { name: true } }, staff: { select: { name: true } } },
    orderBy: { startAt: 'asc' },
    take: 500,
  })

  const results: Array<{ bookingId: string; uid: string; ok: boolean; detail: string; title: string }> = []
  for (const booking of bookings) {
    const uid = `booking-${booking.id}@${ctx.org.slug}`
    const title = `${booking.service.name} — ${booking.customer.name}${booking.staff?.name ? ` (${booking.staff.name})` : ''}`
    const ics = bookingToVEvent({
      uid,
      org: ctx.org,
      title,
      startAt: booking.startAt,
      endAt: booking.endAt,
      description: `Booked via AI Secretary. Status: ${booking.status}. Notes: ${booking.notes || '—'}`,
      status: booking.status,
    })
    const res = await putBookingEvent(creds, uid, ics)
    results.push({ bookingId: booking.id, uid, ok: res.ok, detail: res.detail, title })
  }

  const pushed = results.filter((r) => r.ok).length
  const failed = results.length - pushed

  const summary = { at: now.toISOString(), direction, pushed, failed, total: results.length, pulled }
  await db.appSetting.upsert({
    where: { orgId_key: { orgId: ctx.org.id, key: `caldav_sync:${integration.id}` } },
    create: { orgId: ctx.org.id, key: `caldav_sync:${integration.id}`, value: JSON.stringify(summary) },
    update: { value: JSON.stringify(summary) },
  })

  await audit({
    orgId: ctx.org.id, actorType: 'user', actorId: ctx.user.id,
    action: 'integrations.caldav_sync', entity: 'integration', entityId: integration.id,
    meta: { direction, pushed, failed, total: results.length, pulled },
  })

  return json({
    direction,
    pushed,
    failed,
    total: results.length,
    results: results.slice(0, 100),
    pulled,
    pullResults: pullResults.slice(0, 100),
    syncedAt: now.toISOString(),
  })
})

/** GET — last sync summary for the UI. */
export const GET = withAuth(async (_req, ctx) => {
  const integration = await db.integration.findFirst({ where: { orgId: ctx.org.id, kind: 'caldav' } })
  if (!integration) return json({ configured: false })
  const row = await db.appSetting.findUnique({ where: { orgId_key: { orgId: ctx.org.id, key: `caldav_sync:${integration.id}` } } })
  const last = row ? (() => { try { return JSON.parse(row.value) as Record<string, unknown> } catch { return null } })() : null
  return json({ configured: true, enabled: integration.enabled, lastSync: last, lastTestOk: integration.lastTestOk, lastTestError: integration.lastTestError })
})
