import { z } from 'zod'
import { withAuth, json, parseBody } from '@/lib/api'
import { rejectPayment } from '@/lib/business/payments'

const schema = z.object({
  reason: z.string().trim().min(1, 'A rejection reason is required').max(1000),
})

/** POST /api/payments/[id]/reject {reason} (owner/admin) — reject a claim/webhook payment. */
export const POST = withAuth(
  async (req, ctx, params) => {
    const body = await parseBody(req, schema)
    const payment = await rejectPayment(ctx.org.id, params.id, ctx.user.id, body.reason)
    return json({ payment })
  },
  { roles: ['owner', 'admin'] }
)
