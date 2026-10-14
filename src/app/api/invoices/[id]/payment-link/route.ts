import { withAuth, json, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { invoiceOutstanding } from '@/lib/business/invoice'
import { getEnabledStripe, createStripePaymentLink } from '@/lib/integrations/stripe'

/**
 * POST /api/invoices/[id]/payment-link (owner/admin) — creates a REAL Stripe
 * Payment Link for the invoice's outstanding balance via the live Stripe API.
 * Requires an enabled stripe integration — 503 with an actionable message
 * otherwise. Outstanding <= 0 → 409 (nothing to pay for).
 */
export const POST = withAuth(
  async (req, ctx, params) => {
    const stripe = await getEnabledStripe(ctx.org.id)
    if (!stripe) {
      throw new ApiError(503, 'Stripe integration is not enabled — configure it in Integrations', 'stripe_not_enabled')
    }

    const invoice = await db.invoice.findFirst({ where: { id: params.id, orgId: ctx.org.id } })
    if (!invoice) throw new ApiError(404, 'Invoice not found', 'not_found')
    if (invoice.status === 'void') throw new ApiError(409, 'Invoice is void', 'invoice_void')

    const outstanding = invoiceOutstanding(invoice.totalCents, invoice.paidCents)
    if (outstanding <= 0) throw new ApiError(409, 'Invoice is already fully paid', 'already_paid')

    try {
      const link = await createStripePaymentLink(ctx.org.id, invoice, outstanding)
      await audit({
        orgId: ctx.org.id,
        actorType: 'user',
        actorId: ctx.user.id,
        action: 'invoice.payment_link_created',
        entity: 'invoice',
        entityId: invoice.id,
        meta: { number: invoice.number, amountCents: outstanding, linkId: link.id, url: link.url },
      })
      return json({ url: link.url, id: link.id })
    } catch (err) {
      throw new ApiError(502, err instanceof Error ? err.message : 'Stripe payment link could not be created', 'stripe_error')
    }
  },
  { roles: ['owner', 'admin'] }
)
