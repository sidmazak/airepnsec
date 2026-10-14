import { withAuth, json } from '@/lib/api'
import { db } from '@/lib/db'

/** GET /api/audit?limit= — latest audit events (default 100, max 500). */
export const GET = withAuth(async (req, ctx) => {
  const url = new URL(req.url)
  const limitRaw = Number(url.searchParams.get('limit') ?? '100')
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 500) : 100

  const events = await db.auditEvent.findMany({
    where: { orgId: ctx.org.id },
    orderBy: { ts: 'desc' },
    take: limit,
  })

  return json({ events })
})
