import { withAuth, json } from '@/lib/api'
import { db } from '@/lib/db'

/** GET /api/ai/logs?limit= — recent AI call metrics (no content, only telemetry). */
export const GET = withAuth(async (req, ctx) => {
  const url = new URL(req.url)
  const limitRaw = Number(url.searchParams.get('limit') ?? '100')
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 500) : 100

  const logs = await db.aiLog.findMany({
    where: { orgId: ctx.org.id },
    orderBy: { ts: 'desc' },
    take: limit,
  })

  return json({ logs })
})
