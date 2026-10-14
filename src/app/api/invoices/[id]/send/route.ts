import { withAuth, json, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { invoiceOutstanding } from '@/lib/business/invoice'
import { getEnabledStripe, createStripePaymentLink } from '@/lib/integrations/stripe'
import { renderInvoiceEmail } from '@/lib/integrations/templates'

/**
 * POST /api/invoices/[id]/send (owner/admin) — queues a REAL invoice email.
 *
 * Honesty rules:
 * - If a Stripe integration is enabled we try to attach a payment link; a
 *   failure is reported back as `paymentLinkError` and never faked.
 * - The email is stored in the outbox (text + html). If no SMTP integration is
 *   enabled yet, the row is queued with the explicit reason "waiting for email
 *   integration (configure in Integrations)" — the dispatcher delivers it the
 *   moment SMTP is configured. Nothing is reported as sent here.
 * - Deduped per invoice per calendar day (re-sending is allowed the next day).
 */
export const POST = withAuth(
  async (req, ctx, params) => {
    const invoice = await db.invoice.findFirst({
      where: { id: params.id, orgId: ctx.org.id },
      include: {
        items: { orderBy: { id: 'asc' } },
        customer: { select: { id: true, name: true, email: true, optOut: true, consentContact: true } },
      },
    })
    if (!invoice) throw new ApiError(404, 'Invoice not found', 'not_found')
    if (invoice.status === 'void') throw new ApiError(409, 'Invoice is void', 'invoice_void')

    const customer = invoice.customer
    if (!customer.email) throw new ApiError(422, 'Customer has no email address on file', 'no_email')
    if (customer.optOut || !customer.consentContact) {
      throw new ApiError(409, 'Customer opted out of communications', 'opt_out')
    }

    const org = await db.organization.findUnique({ where: { id: ctx.org.id }, select: { name: true, email: true, phone: true } })
    if (!org) throw new ApiError(404, 'Organization not found', 'not_found')

    // 1) Best-effort payment link (only when Stripe is enabled).
    let paymentLink: string | undefined
    let paymentLinkError: string | undefined
    const stripe = await getEnabledStripe(ctx.org.id)
    if (stripe) {
      try {
        const outstanding = invoiceOutstanding(invoice.totalCents, invoice.paidCents)
        if (outstanding <= 0) {
          paymentLinkError = 'Invoice is already fully paid — no payment link created'
        } else {
          const link = await createStripePaymentLink(ctx.org.id, invoice, outstanding)
          paymentLink = link.url
        }
      } catch (err) {
        paymentLinkError = err instanceof Error ? err.message : 'Stripe payment link failed'
      }
    }

    // 2) Render + queue the email (honest state when SMTP is missing).
    const rendered = renderInvoiceEmail({
      invoice,
      items: invoice.items,
      customer: { name: customer.name },
      org,
      paymentLink,
    })

    const dayKey = new Date().toISOString().slice(0, 10)
    const dedupeKey = `invoice_send:${invoice.id}:${dayKey}`
    const existing = await db.outboxMessage.findUnique({ where: { dedupeKey } })
    if (existing) {
      throw new ApiError(409, `Invoice email was already queued today (${dayKey}) — try again tomorrow or send a reminder instead`, 'already_queued', {
        outboxId: existing.id,
      })
    }

    const smtp = await db.integration.findFirst({ where: { orgId: ctx.org.id, kind: 'smtp', enabled: true } })
    const smtpConfigured = Boolean(smtp?.secretsEnc)

    const outbox = await db.outboxMessage.create({
      data: {
        orgId: ctx.org.id,
        channel: 'email',
        recipient: customer.email,
        subject: rendered.subject,
        body: rendered.text,
        html: rendered.html,
        status: 'queued',
        statusReason: smtpConfigured ? '' : 'waiting for email integration (configure in Integrations)',
        relatedType: 'invoice',
        relatedId: invoice.id,
        dedupeKey,
      },
    })

    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'invoice.sent',
      entity: 'invoice',
      entityId: invoice.id,
      meta: {
        number: invoice.number,
        outboxId: outbox.id,
        recipient: customer.email,
        channel: 'email',
        hasPaymentLink: Boolean(paymentLink),
        paymentLinkError: paymentLinkError ?? null,
      },
    })

    return json({
      queued: true,
      outboxId: outbox.id,
      ...(paymentLink ? { paymentLink } : {}),
      ...(paymentLinkError ? { paymentLinkError } : {}),
      channel: 'email',
      recipient: customer.email,
    })
  },
  { roles: ['owner', 'admin'] }
)
