import { withAuth, json, requireCustomer } from '@/lib/api'
import { db } from '@/lib/db'
import { parseJson } from '@/lib/org'
import { invoiceOutstanding } from '@/lib/business/invoice'

/**
 * GET /api/customers/[id]/statement
 * Customer account statement: profile, every invoice with its outstanding
 * balance, and the full ledger trail for those invoices (chronological).
 */
export const GET = withAuth(async (req, ctx, params) => {
  const customer = await requireCustomer(ctx.org.id, params.id)

  const invoices = await db.invoice.findMany({
    where: { orgId: ctx.org.id, customerId: customer.id },
    orderBy: { issueDate: 'desc' },
    select: {
      id: true,
      number: true,
      status: true,
      currency: true,
      totalCents: true,
      paidCents: true,
      issueDate: true,
      dueDate: true,
    },
  })

  const invoiceIds = invoices.map((inv) => inv.id)
  const ledgerRows = invoiceIds.length
    ? await db.ledgerEntry.findMany({
        where: { orgId: ctx.org.id, invoiceId: { in: invoiceIds } },
        orderBy: { ts: 'asc' },
        select: {
          id: true,
          ts: true,
          type: true,
          debitAccount: true,
          creditAccount: true,
          amountCents: true,
          invoiceId: true,
          memo: true,
          createdBy: true,
        },
      })
    : []

  const totalOutstanding = invoices.reduce(
    (sum, inv) => sum + invoiceOutstanding(inv.totalCents, inv.paidCents),
    0
  )

  return json({
    customer: { ...customer, tags: parseJson<string[]>(customer.tags, []) },
    invoices: invoices.map((inv) => ({
      ...inv,
      outstandingCents: invoiceOutstanding(inv.totalCents, inv.paidCents),
    })),
    totalOutstandingCents: totalOutstanding,
    ledgerRows,
  })
})
