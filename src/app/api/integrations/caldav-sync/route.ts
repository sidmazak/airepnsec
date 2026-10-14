import { z } from 'zod'
import { withAuth, json, parseBody, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { caldavCreds, bookingToVEvent, putBookingEvent, testCaldav } from '@/lib/integrations/caldav'

const bodySchema = z.object({
  days: z.coerce.number().int().min(1).max(120).optional(),
  verifyFirst: z.boolean().optional(),
})

/**
 * POST /api/integrations/caldav-sync (owner/admin)
 * Real push sync: upcoming bookings are written to the CalDAV collection as
 * {uid}.ics (idempotent PUT). Returns per-item results — never a fake success.
 */
export const POST = withAuth(async (req, ctx) => {
  const body = await parseBody(req, bodySchema).catch(() => ({ days: 45, verifyFirst: true }))
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

  const now = new Date()
  const horizon = new Date(now.getTime() + (body.days ?? 45) * 24 * 60 * 60 * 1000)
  const bookings = await db.booking.findMany({
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

  await db.appSetting.upsert({
    where: { orgId_key: { orgId: ctx.org.id, key: `caldav_sync:${integration.id}` } },
    create: { orgId: ctx.org.id, key: `caldav_sync:${integration.id}`, value: JSON.stringify({ at: now.toISOString(), pushed, failed, total: results.length }) },
    update: { value: JSON.stringify({ at: now.toISOString(), pushed, failed, total: results.length }) },
  })

  await audit({
    orgId: ctx.org.id, actorType: 'user', actorId: ctx.user.id,
    action: 'integrations.caldav_sync', entity: 'integration', entityId: integration.id,
    meta: { pushed, failed, total: results.length },
  })

  return json({
    pushed,
    failed,
    total: results.length,
    results: results.slice(0, 100),
    syncedAt: now.toISOString(),
  })
})

/** GET — last sync summary for the UI. */
export const GET = withAuth(async (_req, ctx) => {
  const integration = await db.integration.findFirst({ where: { orgId: ctx.org.id, kind: 'caldav' } })
  if (!integration) return json({ configured: false })
  const row = await db.appSetting.findUnique({ where: { orgId_key: { orgId: ctx.org.id, key: `caldav_sync:${integration.id}` } } })
  const last = row ? (() => { try { return JSON.parse(row.value) as { at: string; pushed: number; failed: number; total: number } } catch { return null } })() : null
  return json({ configured: true, enabled: integration.enabled, lastSync: last, lastTestOk: integration.lastTestOk, lastTestError: integration.lastTestError })
})
