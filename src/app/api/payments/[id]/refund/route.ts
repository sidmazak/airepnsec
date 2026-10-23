import { z } from 'zod'
import { withAuth, json, parseBody } from '@/lib/api'
import { refundPayment } from '@/lib/business/payments'

const schema = z.object({
  amountCents: z.coerce.number().int().positive(),
  reason: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
})

/**
 * POST /api/payments/[id]/refund {amountCents, reason?, idempotencyKey?} (owner/admin)
 * Refunds a verified payment (partial or full). The original payment stays in the
 * history; a linked refund row and ledger reversal reduce paidCents idempotently.
 */
export const POST = withAuth(
  async (req, ctx, params) => {
    const body = await parseBody(req, schema)
    const result = await refundPayment(
      ctx.org.id,
      params.id,
      { amountCents: body.amountCents, reason: body.reason, idempotencyKey: body.idempotencyKey },
      ctx.user.id
    )
    return json(result, result.duplicate ? 200 : 201)
  },
  { roles: ['owner', 'admin'] }
)
