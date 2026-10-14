import { z } from 'zod'
import { withAuth, json, parseBody } from '@/lib/api'
import { recordPaymentClaim } from '@/lib/business/payments'

const schema = z.object({
  amountCents: z.coerce.number().int().positive(),
  method: z.string().trim().max(50).optional(),
  reference: z.string().trim().max(200).optional(),
  note: z.string().trim().max(2000).optional(),
})

/**
 * POST /api/invoices/[id]/claims {amountCents, method?, reference?, note?}
 * Any authenticated role can record a claim (receptionists take customer claims);
 * the payment lands in pending_verification — only owner/admin can verify.
 * Claims NEVER settle the invoice.
 */
export const POST = withAuth(async (req, ctx, params) => {
  const body = await parseBody(req, schema)

  const result = await recordPaymentClaim(
    ctx.org.id,
    {
      invoiceId: params.id,
      amountCents: body.amountCents,
      method: body.method,
      reference: body.reference,
      note: body.note,
    },
    { type: 'user', id: ctx.user.id }
  )

  return json(result, 201)
})
