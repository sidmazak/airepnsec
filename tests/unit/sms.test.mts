import test from 'node:test'
import assert from 'node:assert/strict'
import * as sms from '../../src/lib/integrations/sms.ts'

test('normalizePhone strips formatting and converts 00 to +', () => {
  assert.equal(sms.normalizePhone('+1 (555) 123-4567'), '+15551234567')
  assert.equal(sms.normalizePhone('  +1 (555) 123-4567  '), '+15551234567')
  assert.equal(sms.normalizePhone('00 1 555'), '+1555')
  assert.equal(sms.normalizePhone('00123'), '+123')
})

test('isSmsProviderId accepts known providers only', () => {
  for (const p of ['textbee','httpsms','android_sms_gateway','generic_http']) {
    assert.equal((sms as any).isSmsProviderId(p), true)
  }
  assert.equal((sms as any).isSmsProviderId('twilio'), false)
  assert.equal((sms as any).isSmsProviderId(123), false)
})

test('buildSendRequest textbee has recipients array and gateway/send-sms path', () => {
  const req = sms.buildSendRequest('textbee', { deviceId: 'dev1' }, { apiKey: 'k' }, { to: '+1 555 111 0000', body: 'hi' })
  assert.equal(req.method, 'POST')
  assert.ok(req.url.endsWith('/gateway/send-sms'))
  assert.match(req.headers['x-api-key'], /^k$/)
  const body = JSON.parse(req.body!)
  assert.deepEqual(body.recipients, ['+15551110000'])
  assert.equal(body.message, 'hi')
  assert.equal(body.deviceId, 'dev1')
})

test('buildSendRequest httpsms requires from', () => {
  assert.throws(() => sms.buildSendRequest('httpsms', {}, { apiKey: 'k' }, { to: '1', body: 'hi' }))
})

test('buildSendRequest generic_http templating + auth header', () => {
  const req = sms.buildSendRequest('generic_http', {
    url: 'http://example.com/sms',
    authHeaderName: 'X-Api-Key',
    bodyTemplate: '{"to":"{{to}}","message":"{{message}}"}',
  }, { authValue: 'secret' }, { to: '+11', body: 'a"b' })
  assert.equal(req.method, 'POST')
  assert.equal(req.headers['X-Api-Key'], 'secret')
  const body = JSON.parse(req.body!)
  assert.equal(body.to, '+11')
  assert.equal(body.message, 'a"b')
})

test('buildSendRequest generic_http allows PUT', () => {
  const req = sms.buildSendRequest('generic_http', { url: 'http://example.com/sms', method: 'PUT' }, {}, { to: '1', body: 'b' })
  assert.equal(req.method, 'PUT')
})

test('extractMessageId finds common ids', () => {
  assert.equal(sms.extractMessageId('textbee', { smsBatchId: 'abc' }), 'abc')
  assert.equal(sms.extractMessageId('x', { data: { id: 'nested' } }), 'nested')
  assert.equal(sms.extractMessageId('x', null), '')
})

test('normalizeDeliveryState never maps HTTP success to delivered via adapter', () => {
  assert.equal(sms.normalizeDeliveryState('any', 'DELIVERED'), 'delivered')
  assert.equal(sms.normalizeDeliveryState('any', 'sent'), 'sent')
  assert.equal(sms.normalizeDeliveryState('any', 'queued'), 'queued')
  assert.equal(sms.normalizeDeliveryState('any', 'failed'), 'failed')
  assert.equal(sms.normalizeDeliveryState('any', 'bogus-xyz'), 'unknown')
  assert.equal(sms.normalizeDeliveryState('any', null), 'unknown')
})

test('buildTestRequest returns null for generic_http', () => {
  const r = sms.buildTestRequest('generic_http', {}, {})
  assert.equal(r, null)
})

test('buildTestRequest textbee hits devices', () => {
  const r = sms.buildTestRequest('textbee', {}, { apiKey: 'k' })
  assert.ok(r)
  assert.ok(r!.url.endsWith('/gateway/devices'))
})
