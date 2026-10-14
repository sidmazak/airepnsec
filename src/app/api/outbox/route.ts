import { withAuth, json } from '@/lib/api'
import { db } from '@/lib/db'

const STATUSES = ['queued', 'sent', 'failed', 'skipped']

/** GET /api/outbox?status= — outbound messages with honest status + statusReason. */
export const GET = withAuth(async (req, ctx) => {
  const url = new URL(req.url)
  const status = url.searchParams.get('status') ?? ''

  const messages = await db.outboxMessage.findMany({
    where: { orgId: ctx.org.id, ...(status && STATUSES.includes(status) ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })

  return json({ messages })
})
