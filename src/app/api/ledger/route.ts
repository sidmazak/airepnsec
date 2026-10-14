import { withAuth, json, fail } from '@/lib/api'
import { db } from '@/lib/db'
import { accountBalances } from '@/lib/business/ledger'

function parseDate(value: string | null): Date | undefined {
  if (!value) return undefined
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d
}

/** GET /api/ledger?from&to — last 500 entries (desc) + account balances for the window. */
export const GET = withAuth(async (req, ctx) => {
  const url = new URL(req.url)
  const from = parseDate(url.searchParams.get('from'))
  const to = parseDate(url.searchParams.get('to'))

  if (url.searchParams.get('from') && !from) return fail(422, 'Invalid `from` date', { code: 'validation' })
  if (url.searchParams.get('to') && !to) return fail(422, 'Invalid `to` date', { code: 'validation' })

  const [entries, balances] = await Promise.all([
    db.ledgerEntry.findMany({
      where: {
        orgId: ctx.org.id,
        ...(from || to ? { ts: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      orderBy: { ts: 'desc' },
      take: 500,
      include: { invoice: { select: { number: true } } },
    }),
    accountBalances(ctx.org.id, from, to),
  ])

  return json({
    entries: entries.map((e) => ({
      id: e.id,
      ts: e.ts,
      type: e.type,
      debitAccount: e.debitAccount,
      creditAccount: e.creditAccount,
      amountCents: e.amountCents,
      invoiceId: e.invoiceId,
      invoiceNumber: e.invoice?.number ?? null,
      paymentId: e.paymentId,
      memo: e.memo,
      reversalOfId: e.reversalOfId,
      createdBy: e.createdBy,
    })),
    balances,
  })
})
