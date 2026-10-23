import { withAuth, json, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { invoiceOutstanding } from '@/lib/business/invoice'
import { getEnabledPaymentLinkProvider, createInvoicePaymentLink } from '@/lib/integrations/paymentLinks'

/**
 * POST /api/invoices/[id]/payment-link (owner/admin) — creates a REAL payment
 * link (Stripe preferred, then Square) for the invoice's outstanding balance.
 * Requires an enabled payment integration — 503 with an actionable message
 * otherwise. Outstanding <= 0 → 409 (nothing to pay for).
 */
export const POST = withAuth(
  async (req, ctx, params) => {
    const provider = await getEnabledPaymentLinkProvider(ctx.org.id)
    if (!provider) {
      throw new ApiError(503, 'No payment integration is enabled — configure Stripe or Square in Integrations', 'payment_not_enabled')
    }

    const invoice = await db.invoice.findFirst({ where: { id: params.id, orgId: ctx.org.id } })
    if (!invoice) throw new ApiError(404, 'Invoice not found', 'not_found')
    if (invoice.status === 'void') throw new ApiError(409, 'Invoice is void', 'invoice_void')

    const outstanding = invoiceOutstanding(invoice.totalCents, invoice.paidCents)
    if (outstanding <= 0) throw new ApiError(409, 'Invoice is already fully paid', 'already_paid')

    try {
      const link = await createInvoicePaymentLink(ctx.org.id, invoice, outstanding)
      await audit({
        orgId: ctx.org.id,
        actorType: 'user',
        actorId: ctx.user.id,
        action: 'invoice.payment_link_created',
        entity: 'invoice',
        entityId: invoice.id,
        meta: { number: invoice.number, amountCents: outstanding, linkId: link.id, url: link.url, provider: link.provider },
      })
      return json({ url: link.url, id: link.id, provider: link.provider })
    } catch (err) {
      throw new ApiError(502, err instanceof Error ? err.message : 'Payment link could not be created', 'payment_link_error')
    }
  },
  { roles: ['owner', 'admin'] }
)
