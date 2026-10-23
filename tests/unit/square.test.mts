import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  parseSquarePaymentLink,
  squareBase,
  squareHeaders,
  squarePaymentLinkBody,
  verifySquareSignature,
} from '../../src/lib/integrations/square-protocol.ts'

test('squareBase switches production and sandbox hosts', () => {
  assert.equal(squareBase('production'), 'https://connect.squareup.com')
  assert.equal(squareBase('sandbox'), 'https://connect.squareupsandbox.com')
  assert.equal(squareBase(undefined), 'https://connect.squareup.com')
})

test('squareHeaders carries bearer token, JSON and a pinned API version', () => {
  const h = squareHeaders('EAAA-token')
  assert.equal(h.authorization, 'Bearer EAAA-token')
  assert.equal(h['content-type'], 'application/json')
  assert.match(h['square-version'], /^\d{4}-\d{2}-\d{2}$/)
})

test('squarePaymentLinkBody uses integer minor units and invoice metadata', () => {
  const body = squarePaymentLinkBody({
    invoiceId: 'inv_1',
    invoiceNumber: 'INV-001',
    orgSlug: 'acme',
    orgName: 'Acme Co',
    currency: 'usd',
    amountCents: 12550,
    locationId: 'LOC1',
    idempotencyKey: 'idem-1',
  }) as any
  assert.equal(body.idempotency_key, 'idem-1')
  assert.equal(body.order.location_id, 'LOC1')
  assert.deepEqual(body.order.metadata, { org_slug: 'acme', invoice_id: 'inv_1', invoice_number: 'INV-001' })
  assert.deepEqual(body.order.line_items[0].base_price_money, { amount: 12550, currency: 'USD' })
})

test('parseSquarePaymentLink returns the link and order id', () => {
  assert.deepEqual(
    parseSquarePaymentLink({ payment_link: { url: 'https://square.link/u/abc', id: 'pl_1', order_id: 'ord_1' } }),
    { url: 'https://square.link/u/abc', id: 'pl_1', orderId: 'ord_1' }
  )
})

test('parseSquarePaymentLink throws the provider error detail', () => {
  assert.throws(() => parseSquarePaymentLink({ errors: [{ detail: 'Invalid location' }] }), /Invalid location/)
})

test('verifySquareSignature checks base64 HMAC over notificationUrl + body', () => {
  const raw = '{"type":"payment.updated"}'
  const key = 'sig-key'
  const url = 'https://example.com/api/square/webhook'
  const sig = crypto.createHmac('sha256', key).update(url + raw).digest('base64')
  assert.equal(verifySquareSignature(raw, sig, key, url), true)
  assert.equal(verifySquareSignature(raw, sig, key, 'https://example.com/other'), false)
  assert.equal(verifySquareSignature(raw, sig, 'wrong', url), false)
  assert.equal(verifySquareSignature(raw, null, key, url), false)
  assert.equal(verifySquareSignature(raw, 'not-base64!!', key, url), false)
})
