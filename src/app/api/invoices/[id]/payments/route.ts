import { z } from 'zod'
import { withAuth, json, parseBody } from '@/lib/api'
import { recordVerifiedPayment } from '@/lib/business/payments'

const schema = z.object({
  amountCents: z.coerce.number().int().positive(),
  method: z.string().trim().max(50).optional(),
  reference: z.string().trim().max(200).optional(),
})

/**
 * POST /api/invoices/[id]/payments {amountCents, method?, reference?} (owner/admin)
 * Records a VERIFIED payment immediately (idempotent, ledger-posted, audited).
 */
export const POST = withAuth(
  async (req, ctx, params) => {
    const body = await parseBody(req, schema)

    const result = await recordVerifiedPayment(
      ctx.org.id,
      {
        invoiceId: params.id,
        amountCents: body.amountCents,
        method: body.method,
        reference: body.reference,
        source: 'manual',
        verifiedBy: ctx.user.id,
      },
      { type: 'user', id: ctx.user.id }
    )

    return json(result, 201)
  },
  { roles: ['owner', 'admin'] }
)
