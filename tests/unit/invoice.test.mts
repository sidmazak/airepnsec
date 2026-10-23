import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  effectiveInvoiceStatus,
  invoiceOutstanding,
  nextInvoiceState,
} from '../../src/lib/business/invoice-protocol.ts'

test('invoiceOutstanding clamps overpaid balances to zero', () => {
  assert.equal(invoiceOutstanding(10_000, 4_000), 6_000)
  assert.equal(invoiceOutstanding(10_000, 10_000), 0)
  assert.equal(invoiceOutstanding(10_000, 12_000), 0)
})

test('nextInvoiceState derives paid, partial and sent from money', () => {
  assert.deepEqual(
    nextInvoiceState({ totalCents: 10_000, verifiedCents: 10_000, refundedCents: 0, currentStatus: 'sent' }),
    { paidCents: 10_000, status: 'paid' }
  )
  assert.deepEqual(
    nextInvoiceState({ totalCents: 10_000, verifiedCents: 4_000, refundedCents: 0, currentStatus: 'sent' }),
    { paidCents: 4_000, status: 'partial' }
  )
  assert.deepEqual(
    nextInvoiceState({ totalCents: 10_000, verifiedCents: 0, refundedCents: 0, currentStatus: 'partial' }),
    { paidCents: 0, status: 'sent' }
  )
})

test('nextInvoiceState subtracts refunds and reopens the invoice', () => {
  assert.deepEqual(
    nextInvoiceState({ totalCents: 10_000, verifiedCents: 10_000, refundedCents: 4_000, currentStatus: 'paid' }),
    { paidCents: 6_000, status: 'partial' }
  )
  assert.deepEqual(
    nextInvoiceState({ totalCents: 10_000, verifiedCents: 10_000, refundedCents: 10_000, currentStatus: 'paid' }),
    { paidCents: 0, status: 'sent' }
  )
})

test('nextInvoiceState keeps draft, void and uncollectible statuses', () => {
  for (const status of ['draft', 'void', 'uncollectible']) {
    assert.deepEqual(
      nextInvoiceState({ totalCents: 10_000, verifiedCents: 0, refundedCents: 0, currentStatus: status }),
      { paidCents: 0, status }
    )
  }
})

test('effectiveInvoiceStatus marks past-due sent/partial invoices overdue', () => {
  const now = new Date('2026-10-23T12:00:00Z')
  assert.equal(effectiveInvoiceStatus('sent', '2026-10-22T12:00:00Z', 5_000, now), 'overdue')
  assert.equal(effectiveInvoiceStatus('partial', '2026-10-22T12:00:00Z', 5_000, now), 'overdue')
  assert.equal(effectiveInvoiceStatus('sent', '2026-10-24T12:00:00Z', 5_000, now), 'sent')
})

test('effectiveInvoiceStatus never rewrites settled or draft states', () => {
  const now = new Date('2026-10-23T12:00:00Z')
  assert.equal(effectiveInvoiceStatus('sent', '2026-10-22T12:00:00Z', 0, now), 'sent')
  assert.equal(effectiveInvoiceStatus('draft', '2026-10-22T12:00:00Z', 5_000, now), 'draft')
  assert.equal(effectiveInvoiceStatus('paid', '2026-10-22T12:00:00Z', 0, now), 'paid')
  assert.equal(effectiveInvoiceStatus('void', '2026-10-22T12:00:00Z', 5_000, now), 'void')
})
