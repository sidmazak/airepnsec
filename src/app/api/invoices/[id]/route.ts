import { z } from 'zod'
import { withAuth, json, parseBody, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { voidInvoice, issueInvoice, effectiveInvoiceStatus, invoiceOutstanding } from '@/lib/business/invoice'

/** GET /api/invoices/[id] — invoice with items, payments and customer name. */
export const GET = withAuth(async (req, ctx, params) => {
  const invoice = await db.invoice.findFirst({
    where: { id: params.id, orgId: ctx.org.id },
    include: {
      customer: { select: { id: true, name: true, email: true, phone: true } },
      items: { orderBy: { id: 'asc' } },
      payments: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!invoice) throw new ApiError(404, 'Invoice not found', 'not_found')

  const outstandingCents = invoiceOutstanding(invoice.totalCents, invoice.paidCents)
  return json({ ...invoice, status: effectiveInvoiceStatus(invoice.status, invoice.dueDate, outstandingCents), outstandingCents })
})

const patchSchema = z.object({
  action: z.enum(['void', 'mark_uncollectible', 'issue']),
})

/**
 * PATCH /api/invoices/[id] {action: 'void' | 'mark_uncollectible'} (owner/admin)
 * void → reverses the ledger charge via voidInvoice (audited there).
 * mark_uncollectible → write-off flag; audited here.
 */
export const PATCH = withAuth(
  async (req, ctx, params) => {
    const { action } = await parseBody(req, patchSchema)
    const actor = { type: 'user' as const, id: ctx.user.id }

    if (action === 'void') {
      const invoice = await voidInvoice(ctx.org.id, params.id, actor)
      return json(invoice)
    }

    if (action === 'issue') {
      const invoice = await issueInvoice(ctx.org.id, params.id, actor)
      if (!invoice) throw new ApiError(404, 'Invoice not found', 'not_found')
      const outstandingCents = invoiceOutstanding(invoice.totalCents, invoice.paidCents)
      return json({ ...invoice, status: effectiveInvoiceStatus(invoice.status, invoice.dueDate, outstandingCents), outstandingCents })
    }

    const invoice = await db.invoice.findFirst({ where: { id: params.id, orgId: ctx.org.id } })
    if (!invoice) throw new ApiError(404, 'Invoice not found', 'not_found')
    if (invoice.status === 'uncollectible') return json(invoice)
    if (invoice.status === 'void') throw new ApiError(409, 'Invoice is void', 'invoice_void')
    if (invoice.status === 'draft') throw new ApiError(409, 'Issue the invoice before marking it uncollectible', 'invoice_draft')
    if (invoice.status === 'paid') {
      throw new ApiError(409, 'Invoice is fully paid — record a refund instead', 'invoice_paid')
    }

    const updated = await db.invoice.update({
      where: { id: invoice.id },
      data: { status: 'uncollectible' },
    })

    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'invoice.marked_uncollectible',
      entity: 'invoice',
      entityId: invoice.id,
      meta: { number: invoice.number, totalCents: invoice.totalCents, paidCents: invoice.paidCents },
    })

    return json(updated)
  },
  { roles: ['owner', 'admin'] }
)
