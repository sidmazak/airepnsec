import { withAuth, json } from '@/lib/api'
import { db } from '@/lib/db'

const STATUSES = ['pending_verification', 'verified', 'failed', 'refunded']

/**
 * GET /api/payments?status=pending_verification — verification queue.
 * Joins invoice number/totals and customer name for the review UI.
 */
export const GET = withAuth(async (req, ctx) => {
  const url = new URL(req.url)
  const status = url.searchParams.get('status') ?? 'pending_verification'

  const payments = await db.payment.findMany({
    where: { orgId: ctx.org.id, status: STATUSES.includes(status) ? status : 'pending_verification' },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: {
      invoice: {
        select: {
          number: true,
          totalCents: true,
          paidCents: true,
          customer: { select: { name: true } },
        },
      },
    },
  })

  return json({
    payments: payments.map((p) => ({
      id: p.id,
      invoiceId: p.invoiceId,
      amountCents: p.amountCents,
      method: p.method,
      reference: p.reference,
      status: p.status,
      source: p.source,
      note: p.note,
      verifiedAt: p.verifiedAt,
      verifiedBy: p.verifiedBy,
      createdAt: p.createdAt,
      invoiceNumber: p.invoice.number,
      invoiceTotalCents: p.invoice.totalCents,
      invoicePaidCents: p.invoice.paidCents,
      customerName: p.invoice.customer.name,
    })),
  })
})
