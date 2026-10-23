export function invoiceOutstanding(totalCents: number, paidCents: number): number {
  return Math.max(0, totalCents - paidCents)
}

export type InvoiceStateInput = {
  totalCents: number
  verifiedCents: number
  refundedCents: number
  currentStatus: string
}

/**
 * Derive paidCents and the persisted status from verified payments minus refunds.
 * Draft, void and uncollectible invoices keep their status. Everything else is
 * recomputed from the money, so a refund reopens an invoice honestly.
 */
export function nextInvoiceState(input: InvoiceStateInput): { paidCents: number; status: string } {
  const paidCents = Math.max(0, input.verifiedCents - input.refundedCents)
  if (['draft', 'void', 'uncollectible'].includes(input.currentStatus)) {
    return { paidCents, status: input.currentStatus }
  }
  if (input.totalCents > 0 && paidCents >= input.totalCents) return { paidCents, status: 'paid' }
  if (paidCents > 0) return { paidCents, status: 'partial' }
  return { paidCents, status: 'sent' }
}

/**
 * Overdue is a presentation state derived from the due date, never stored, so it
 * cannot go stale when an invoice is paid, voided or refunded.
 */
export function effectiveInvoiceStatus(
  status: string,
  dueDate: Date | string,
  outstandingCents: number,
  now: Date = new Date()
): string {
  if (!['sent', 'partial'].includes(status)) return status
  if (outstandingCents <= 0) return status
  const due = dueDate instanceof Date ? dueDate : new Date(dueDate)
  if (Number.isNaN(due.getTime())) return status
  return due.getTime() < now.getTime() ? 'overdue' : status
}
