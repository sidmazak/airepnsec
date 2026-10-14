import { NextRequest, NextResponse } from 'next/server'
import { getCtx, fail, rateLimit } from '@/lib/api'
import type { ApiCtx } from '@/lib/api'
import { db } from '@/lib/db'
import { buildIcs } from '@/lib/integrations/ics'

/**
 * GET /api/calendar/bookings/<id>.ics — a single booking as an iCalendar event
 * (404 when it does not belong to the caller's org or does not exist).
 *
 * NOTE: implemented as a catch-all because the Next.js App Router does not
 * support partial dynamic segments (`[id].ics`); the public URL contract is
 * unchanged. Accepts both `<id>.ics` and `booking-<id>.ics` filenames.
 *
 * Auth is handled locally (cookie session via getCtx) because the shared
 * withAuth wrapper types route params as Record<string, string>, which is
 * incompatible with catch-all params ({ file: string[] }).
 */
async function serve(req: NextRequest, ctx: ApiCtx, file: string[]): Promise<NextResponse> {
  if (file.length !== 1 || !file[0].endsWith('.ics')) {
    return fail(404, 'Not found — use /api/calendar/bookings.ics for the feed', { code: 'not_found' })
  }

  const id = file[0].replace(/\.ics$/, '').replace(/^booking-/, '')
  const booking = await db.booking.findFirst({
    where: { id, orgId: ctx.org.id },
    include: {
      customer: { select: { name: true } },
      service: { select: { name: true } },
    },
  })
  if (!booking) return fail(404, 'Booking not found', { code: 'not_found' })

  const ics = buildIcs([
    {
      uid: `${booking.id}@${ctx.org.slug}`,
      start: booking.startAt,
      end: booking.endAt,
      summary: `${booking.service.name} — ${booking.customer.name}`,
      description: [
        `Service: ${booking.service.name}`,
        `Customer: ${booking.customer.name}`,
        `Status: ${booking.status}`,
        booking.notes ? `Notes: ${booking.notes}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      location: ctx.org.address || undefined,
      status: booking.status === 'confirmed' ? 'CONFIRMED' : 'TENTATIVE',
      organizer: ctx.org.email ? { name: ctx.org.name, email: ctx.org.email } : undefined,
    },
  ])

  return new NextResponse(ics, {
    status: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `inline; filename="booking-${booking.id}.ics"`,
      'cache-control': 'no-store',
    },
  })
}

export async function GET(req: NextRequest, route: { params: Promise<{ file: string[] }> }) {
  if (!rateLimit(`${req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local'}:/api/calendar/bookings/file`, 120, 60_000)) {
    return fail(429, 'Too many requests. Please slow down.')
  }
  const ctx = await getCtx(req)
  if (!ctx) return fail(401, 'Not signed in', { code: 'unauthenticated' })
  const params = route?.params ? await route.params : { file: [] as string[] }
  try {
    return await serve(req, ctx, params.file)
  } catch (err) {
    console.error('[api] calendar booking ics:', err instanceof Error ? err.message : err)
    return fail(500, 'Something went wrong on the server. Check server logs for details.')
  }
}
