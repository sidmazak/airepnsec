import { NextResponse, type NextRequest } from 'next/server'
import { withAuth } from '@/lib/api'
import { db } from '@/lib/db'
import { buildIcs, type IcsEvent } from '@/lib/integrations/ics'

/**
 * GET /api/calendar/bookings.ics?from=&to= — subscribable calendar feed.
 * Defaults to the next 30 days, pending + confirmed bookings only.
 * Cookie auth works for browser navigation; served as text/calendar.
 */
export const GET = withAuth(async (req: NextRequest, ctx) => {
  const url = new URL(req.url)

  const parseDateOrUndefined = (raw: string | null): Date | undefined => {
    if (!raw) return undefined
    const d = new Date(raw)
    return isNaN(d.getTime()) ? undefined : d
  }

  const now = new Date()
  const from = parseDateOrUndefined(url.searchParams.get('from')) ?? now
  const to = parseDateOrUndefined(url.searchParams.get('to')) ?? new Date(now.getTime() + 30 * 86_400_000)

  const bookings = await db.booking.findMany({
    where: {
      orgId: ctx.org.id,
      startAt: { gte: from, lte: to },
      status: { in: ['pending', 'confirmed'] },
    },
    orderBy: { startAt: 'asc' },
    take: 500,
    include: {
      customer: { select: { name: true } },
      service: { select: { name: true } },
    },
  })

  const events: IcsEvent[] = bookings.map((booking) => ({
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
  }))

  return new NextResponse(buildIcs(events), {
    status: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'inline; filename="bookings.ics"',
      'cache-control': 'no-store',
    },
  })
})
