import test from 'node:test'
import assert from 'node:assert/strict'
import { isNewerDeliveryState, normalizeDeliveryStatus } from '../../src/lib/integrations/delivery-protocol.ts'

test('normalizes accepted/sent vocabulary', () => {
  for (const raw of ['queued', 'sent', 'accepted', 'submitted', 'pending', 'scheduled', 'SENT']) {
    assert.equal(normalizeDeliveryStatus(raw), 'accepted', raw)
  }
})

test('normalizes delivered vocabulary without stealing failed', () => {
  assert.equal(normalizeDeliveryStatus('delivered'), 'delivered')
  assert.equal(normalizeDeliveryStatus('delivered_to_handset'), 'delivered')
})

test('normalizes read/received vocabulary', () => {
  assert.equal(normalizeDeliveryStatus('read'), 'read')
  assert.equal(normalizeDeliveryStatus('READ'), 'read')
  assert.equal(normalizeDeliveryStatus('seen'), 'read')
})

test('normalizes failure vocabulary including neighbor statuses', () => {
  for (const raw of ['failed', 'undelivered', 'rejected', 'expired', 'error', 'aborted', 'canceled', 'blocked']) {
    assert.equal(normalizeDeliveryStatus(raw), 'failed', raw)
  }
})

test('unknown and empty statuses are ignored, not invented', () => {
  assert.equal(normalizeDeliveryStatus(''), null)
  assert.equal(normalizeDeliveryStatus('   '), null)
  assert.equal(normalizeDeliveryStatus('mystery'), null)
})

test('rank guard keeps the furthest receipt', () => {
  assert.equal(isNewerDeliveryState('', 'accepted'), true)
  assert.equal(isNewerDeliveryState('accepted', 'delivered'), true)
  assert.equal(isNewerDeliveryState('delivered', 'read'), true)
  assert.equal(isNewerDeliveryState('read', 'failed'), true)
  assert.equal(isNewerDeliveryState('delivered', 'accepted'), false)
  assert.equal(isNewerDeliveryState('failed', 'delivered'), false)
  assert.equal(isNewerDeliveryState('read', 'read'), true)
})
