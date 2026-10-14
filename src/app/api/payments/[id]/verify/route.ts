import { withAuth, json } from '@/lib/api'
import { verifyPayment } from '@/lib/business/payments'

/** POST /api/payments/[id]/verify (owner/admin) — verify a pending payment. */
export const POST = withAuth(
  async (req, ctx, params) => {
    const result = await verifyPayment(ctx.org.id, params.id, ctx.user.id)
    return json(result)
  },
  { roles: ['owner', 'admin'] }
)
