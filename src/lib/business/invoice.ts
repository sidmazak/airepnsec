import { db } from '@/lib/db'
import { ApiError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { postEntry } from '@/lib/business/ledger'
import { effectiveInvoiceStatus, invoiceOutstanding, nextInvoiceState } from '@/lib/business/invoice-protocol'

export { effectiveInvoiceStatus, invoiceOutstanding }

export type InvoiceItemInput = { description: string; qty: number; unitPriceCents: number }

export type CreateInvoiceInput = {
  customerId: string
  items: InvoiceItemInput[]
  taxCents?: number
  dueInDays?: number
  issueDate?: string
  rentalPeriod?: { start: string; end: string; recurrence?: string } | null
  notes?: string
  draft?: boolean
  autoSend?: boolean
}

async function nextInvoiceNumber(orgId: string): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `INV-${year}-`
  const last = await db.invoice.findFirst({
    where: { orgId, number: { startsWith: prefix } },
    orderBy: { number: 'desc' },
    select: { number: true },
  })
  const lastSeq = last ? parseInt(last.number.slice(prefix.length), 10) || 0 : 0
  return `${prefix}${String(lastSeq + 1).padStart(4, '0')}`
}

export async function createInvoice(orgId: string, input: CreateInvoiceInput, actor: { type: 'user' | 'ai' | 'system'; id: string }) {
  const customer = await db.customer.findFirst({ where: { id: input.customerId, orgId } })
  if (!customer) throw new ApiError(404, 'Customer not found', 'customer_not_found')
  if (!input.items?.length) throw new ApiError(422, 'An invoice needs at least one line item', 'no_items')

  for (const item of input.items) {
    if (!item.description?.trim()) throw new ApiError(422, 'Every line item needs a description', 'item_description')
    if (!Number.isInteger(item.qty) || item.qty <= 0) throw new ApiError(422, 'Line item quantity must be a positive whole number', 'item_qty')
    if (!Number.isInteger(item.unitPriceCents) || item.unitPriceCents < 0) throw new ApiError(422, 'Line item price must be a non-negative integer (cents)', 'item_price')
  }

  const subtotal = input.items.reduce((sum, i) => sum + i.qty * i.unitPriceCents, 0)
  const tax = input.taxCents ?? 0
  if (!Number.isInteger(tax) || tax < 0) throw new ApiError(422, 'Tax must be a non-negative integer (cents)', 'tax')
  const total = subtotal + tax
  const issueDate = input.issueDate ? new Date(input.issueDate) : new Date()
  if (Number.isNaN(issueDate.getTime())) throw new ApiError(422, 'Issue date must be a valid date', 'issue_date')
  const dueDate = new Date(issueDate.getTime() + (input.dueInDays ?? 14) * 24 * 60 * 60 * 1000)
  const isDraft = Boolean(input.draft)
  // The invoice number is a per-org sequence guarded by a unique index. Two
  // parallel issuances can pick the same number, so retry on the unique
  // violation instead of failing the invoice.
  let invoice
  let allocatedNumber = ''
  for (let attempt = 0; attempt < 5; attempt++) {
    const number = await nextInvoiceNumber(orgId)
    try {
      invoice = await db.$transaction(async (tx) => {
        const inv = await tx.invoice.create({
          data: {
            orgId,
            customerId: input.customerId,
            number,
            status: isDraft ? 'draft' : 'sent',
            currency: customer ? (await db.organization.findUnique({ where: { id: orgId }, select: { currency: true } }))?.currency ?? 'USD' : 'USD',
            subtotalCents: subtotal,
            taxCents: tax,
            totalCents: total,
            paidCents: 0,
            issueDate,
            dueDate,
            rentalPeriod: input.rentalPeriod ? JSON.stringify(input.rentalPeriod) : '',
            notes: input.notes ?? '',
          },
        })
        for (const item of input.items) {
          await tx.invoiceItem.create({
            data: {
              invoiceId: inv.id,
              description: item.description.trim(),
              qty: item.qty,
              unitPriceCents: item.unitPriceCents,
              totalCents: item.qty * item.unitPriceCents,
            },
          })
        }
        if (!isDraft) {
          await postEntry(orgId, {
            type: 'charge',
            debitAccount: 'accounts_receivable',
            creditAccount: 'revenue',
            amountCents: total,
            invoiceId: inv.id,
            memo: `Invoice ${number} issued to ${customer.name}`,
            createdBy: actor.id,
          }, tx)
        }
        return inv
      })
      allocatedNumber = number
      break
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : ''
      if (code === 'P2002' && attempt < 4) continue
      throw err
    }
  }
  if (!invoice) throw new ApiError(409, 'Could not allocate a unique invoice number', 'invoice_number_conflict')

  await audit({
    orgId, actorType: actor.type, actorId: actor.id, action: 'invoice.created', entity: 'invoice', entityId: invoice.id,
    meta: { number: allocatedNumber, totalCents: total, dueDate: dueDate.toISOString(), draft: isDraft },
  })
  return invoice
}

/** Issue a draft: post the ledger charge once and move it to sent. Idempotent. */
export async function issueInvoice(orgId: string, invoiceId: string, actor: { type: 'user' | 'system'; id: string }) {
  const invoice = await db.invoice.findFirst({
    where: { id: invoiceId, orgId },
    include: { customer: { select: { name: true } } },
  })
  if (!invoice) throw new ApiError(404, 'Invoice not found', 'not_found')
  if (invoice.status !== 'draft') return invoice

  await db.$transaction(async (tx) => {
    const charge = await tx.ledgerEntry.findFirst({ where: { orgId, invoiceId, type: 'charge' } })
    if (!charge) {
      await postEntry(orgId, {
        type: 'charge',
        debitAccount: 'accounts_receivable',
        creditAccount: 'revenue',
        amountCents: invoice.totalCents,
        invoiceId,
        memo: `Invoice ${invoice.number} issued to ${invoice.customer.name}`,
        createdBy: actor.id,
      }, tx)
    }
    await tx.invoice.update({ where: { id: invoiceId }, data: { status: 'sent' } })
  })

  await audit({ orgId, actorType: actor.type, actorId: actor.id, action: 'invoice.issued', entity: 'invoice', entityId: invoiceId, meta: { number: invoice.number, totalCents: invoice.totalCents } })
  return db.invoice.findUnique({ where: { id: invoiceId } })
}

export async function voidInvoice(orgId: string, invoiceId: string, actor: { type: 'user' | 'system'; id: string }) {
  const invoice = await db.invoice.findFirst({ where: { id: invoiceId, orgId }, include: { payments: true } })
  if (!invoice) throw new ApiError(404, 'Invoice not found', 'not_found')
  const verifiedPayments = invoice.payments.filter((p) => p.status === 'verified')
  if (verifiedPayments.length > 0) {
    throw new ApiError(409, 'This invoice has verified payments — void it via recorded refunds/adjustments instead.', 'has_payments')
  }
  if (invoice.status === 'void') return invoice

  const chargeEntries = await db.ledgerEntry.findMany({ where: { invoiceId, orgId, type: 'charge' } })
  await db.$transaction(async (tx) => {
    for (const entry of chargeEntries) {
      const already = await tx.ledgerEntry.findFirst({ where: { reversalOfId: entry.id } })
      if (!already) {
        await tx.ledgerEntry.create({
          data: {
            orgId, type: 'reversal', debitAccount: entry.creditAccount, creditAccount: entry.debitAccount,
            amountCents: entry.amountCents, invoiceId, memo: `Void of invoice ${invoice.number}`, createdBy: actor.id, reversalOfId: entry.id,
          },
        })
      }
    }
    await tx.invoice.update({ where: { id: invoiceId }, data: { status: 'void' } })
  })

  await audit({ orgId, actorType: actor.type, actorId: actor.id, action: 'invoice.voided', entity: 'invoice', entityId: invoiceId, meta: { number: invoice.number } })
  return db.invoice.findUnique({ where: { id: invoiceId } })
}

/** Recompute paidCents and status from verified payments — single source of truth. */
export async function recalcInvoiceStatus(orgId: string, invoiceId: string): Promise<{ paidCents: number; status: string }> {
  const invoice = await db.invoice.findFirst({ where: { id: invoiceId, orgId } })
  if (!invoice) throw new ApiError(404, 'Invoice not found', 'not_found')
  const [verified, refunded] = await Promise.all([
    db.payment.aggregate({ where: { invoiceId, orgId, status: 'verified' }, _sum: { amountCents: true } }),
    db.payment.aggregate({ where: { invoiceId, orgId, source: 'refund', status: 'refunded' }, _sum: { amountCents: true } }),
  ])
  const state = nextInvoiceState({
    totalCents: invoice.totalCents,
    verifiedCents: verified._sum.amountCents ?? 0,
    refundedCents: refunded._sum.amountCents ?? 0,
    currentStatus: invoice.status,
  })
  await db.invoice.update({ where: { id: invoiceId }, data: state })
  return state
}
