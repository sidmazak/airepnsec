import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api'
import { db } from '@/lib/db'

function csvEscape(value: unknown): string {
  const s = String(value ?? '')
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** GET /api/ledger/export — full ledger as a text/csv attachment. */
export const GET = withAuth(async (req, ctx) => {
  const entries = await db.ledgerEntry.findMany({
    where: { orgId: ctx.org.id },
    orderBy: { ts: 'desc' },
    take: 10_000,
  })

  const header = ['ts', 'type', 'debitAccount', 'creditAccount', 'amountCents', 'invoiceId', 'memo']
  const rows = [
    header.join(','),
    ...entries.map((e) =>
      [e.ts.toISOString(), e.type, e.debitAccount, e.creditAccount, e.amountCents, e.invoiceId ?? '', e.memo]
        .map(csvEscape)
        .join(',')
    ),
  ]

  return new NextResponse(rows.join('\n'), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="ledger-export.csv"',
      'cache-control': 'no-store',
    },
  })
})
