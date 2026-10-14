import { db } from '@/lib/db'
import { ApiError } from '@/lib/api'
import { audit } from '@/lib/audit'
import type { Prisma } from '@prisma/client'

export type LedgerAccount = 'accounts_receivable' | 'cash' | 'revenue' | 'refunds' | 'fees' | 'bad_debt' | 'other'

export type PostEntryInput = {
  type: 'charge' | 'payment' | 'refund' | 'adjustment' | 'reversal'
  debitAccount: LedgerAccount
  creditAccount: LedgerAccount
  amountCents: number
  invoiceId?: string | null
  paymentId?: string | null
  bookingId?: string | null
  memo?: string
  createdBy?: string
  reversalOfId?: string | null
  ts?: Date
}

/**
 * Append a ledger entry. Financial history is append-only — corrections are new entries.
 * `client` lets callers participate in an existing transaction (SQLite runs each
 * connection in isolation; using the global db inside a tx would not see uncommitted rows).
 */
export async function postEntry(orgId: string, input: PostEntryInput, client: Prisma.TransactionClient = db) {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ApiError(422, 'Ledger amount must be a positive integer number of cents', 'ledger_amount')
  }
  return client.ledgerEntry.create({
    data: {
      orgId,
      type: input.type,
      debitAccount: input.debitAccount,
      creditAccount: input.creditAccount,
      amountCents: input.amountCents,
      invoiceId: input.invoiceId ?? null,
      paymentId: input.paymentId ?? null,
      bookingId: input.bookingId ?? null,
      memo: input.memo ?? '',
      createdBy: input.createdBy ?? 'system',
      reversalOfId: input.reversalOfId ?? null,
      ...(input.ts ? { ts: input.ts } : {}),
    },
  })
}

/** Reverse an existing entry by posting an equal-and-opposite entry. Originals are never mutated. */
export async function reverseEntry(orgId: string, entryId: string, actor: { type: string; id: string }, memo?: string) {
  const original = await db.ledgerEntry.findFirst({ where: { id: entryId, orgId } })
  if (!original) throw new ApiError(404, 'Ledger entry not found', 'not_found')

  const alreadyReversed = await db.ledgerEntry.findFirst({ where: { reversalOfId: original.id, orgId } })
  if (alreadyReversed) throw new ApiError(409, 'This entry has already been reversed', 'already_reversed')

  const reversal = await postEntry(orgId, {
    type: 'reversal',
    debitAccount: original.creditAccount as LedgerAccount,
    creditAccount: original.debitAccount as LedgerAccount,
    amountCents: original.amountCents,
    invoiceId: original.invoiceId,
    paymentId: original.paymentId,
    bookingId: original.bookingId,
    memo: memo ?? `Reversal of ${original.id}`,
    createdBy: actor.id,
    reversalOfId: original.id,
  })

  await audit({ orgId, actorType: actor.type as 'user', actorId: actor.id, action: 'ledger.reversed', entity: 'ledger_entry', entityId: reversal.id, meta: { originalId: original.id, amountCents: original.amountCents } })
  return reversal
}

export type AccountBalance = { account: string; debitCents: number; creditCents: number; netCents: number }

export async function accountBalances(orgId: string, from?: Date, to?: Date): Promise<AccountBalance[]> {
  const entries = await db.ledgerEntry.findMany({
    where: { orgId, ...(from || to ? { ts: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}) },
    select: { debitAccount: true, creditAccount: true, amountCents: true },
  })
  const map = new Map<string, AccountBalance>()
  const touch = (account: string): AccountBalance => {
    let b = map.get(account)
    if (!b) {
      b = { account, debitCents: 0, creditCents: 0, netCents: 0 }
      map.set(account, b)
    }
    return b
  }
  for (const e of entries) {
    touch(e.debitAccount).debitCents += e.amountCents
    touch(e.creditAccount).creditCents += e.amountCents
  }
  for (const b of map.values()) b.netCents = b.debitCents - b.creditCents
  return [...map.values()].sort((a, b) => a.account.localeCompare(b.account))
}

export async function outstandingReceivables(orgId: string): Promise<number> {
  const invoices = await db.invoice.findMany({
    where: { orgId, status: { in: ['sent', 'partial', 'uncollectible'] } },
    select: { totalCents: true, paidCents: true },
  })
  return invoices.reduce((sum, inv) => sum + Math.max(0, inv.totalCents - inv.paidCents), 0)
}
