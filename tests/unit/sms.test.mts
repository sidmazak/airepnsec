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
  for (const p of ['textbee','httpsms','android_sms_gateway','telnyx','vonage','messagebird','plivo','generic_http']) {
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

test('buildSendRequest telnyx, vonage, messagebird and plivo shapes', () => {
  const telnyx = sms.buildSendRequest('telnyx', { from: '+15550001111' }, { apiKey: 'tk' }, { to: '+1 555 222 3333', body: 'hi' })
  assert.equal(telnyx.url, 'https://api.telnyx.com/v2/messages')
  assert.equal(telnyx.headers.Authorization, 'Bearer tk')
  assert.deepEqual(JSON.parse(telnyx.body!), { from: '+15550001111', to: '+15552223333', text: 'hi' })

  const vonage = sms.buildSendRequest('vonage', { from: 'AI' }, { apiKey: 'vk', apiSecret: 'vs' }, { to: '+1 555 222 3333', body: 'hi' })
  assert.equal(vonage.url, 'https://rest.nexmo.com/sms/json')
  assert.match(vonage.headers['content-type'], /x-www-form-urlencoded/)
  assert.match(vonage.body!, /api_key=vk/)
  assert.match(vonage.body!, /api_secret=vs/)
  assert.match(vonage.body!, /to=%2B15552223333/)

  const bird = sms.buildSendRequest('messagebird', { from: 'AI' }, { apiKey: 'bk' }, { to: '+1 555 222 3333', body: 'hi' })
  assert.equal(bird.url, 'https://rest.messagebird.com/messages')
  assert.equal(bird.headers.Authorization, 'AccessKey bk')
  assert.deepEqual(JSON.parse(bird.body!), { originator: 'AI', recipients: ['15552223333'], body: 'hi' })

  const plivo = sms.buildSendRequest('plivo', { from: '+15550001111' }, { accountId: 'MA123', apiSecret: 'pt' }, { to: '+1 555 222 3333', body: 'hi' })
  assert.equal(plivo.url, 'https://api.plivo.com/v1/Account/MA123/Message/')
  assert.match(String(plivo.headers.Authorization), /^Basic /)
  assert.deepEqual(JSON.parse(plivo.body!), { src: '+15550001111', dst: '+15552223333', text: 'hi' })
})

test('buildSendRequest new providers require their sender', () => {
  assert.throws(() => sms.buildSendRequest('telnyx', {}, { apiKey: 'k' }, { to: '1', body: 'hi' }), /from/)
  assert.throws(() => sms.buildSendRequest('vonage', {}, { apiKey: 'k' }, { to: '1', body: 'hi' }), /from/)
  assert.throws(() => sms.buildSendRequest('vonage', { from: 'AI' }, {}, { to: '1', body: 'hi' }), /apiKey/)
  assert.throws(() => sms.buildSendRequest('messagebird', {}, { apiKey: 'k' }, { to: '1', body: 'hi' }), /from/)
  assert.throws(() => sms.buildSendRequest('plivo', { from: '+1' }, {}, { to: '1', body: 'hi' }), /accountId/)
})

test('extractMessageId finds common ids', () => {
  assert.equal(sms.extractMessageId('textbee', { smsBatchId: 'abc' }), 'abc')
  assert.equal(sms.extractMessageId('x', { data: { id: 'nested' } }), 'nested')
  assert.equal(sms.extractMessageId('plivo', { message_uuid: 'uuid-1' }), 'uuid-1')
  assert.equal(sms.extractMessageId('vonage', { messages: [{ 'message-id': 'v-1', status: '0' }] }), 'v-1')
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

test('buildTestRequest probes the new providers read-only', () => {
  assert.match(sms.buildTestRequest('telnyx', {}, { apiKey: 'k' })!.url, /\/messages\?page/)
  assert.match(sms.buildTestRequest('messagebird', {}, { apiKey: 'k' })!.url, /\/messages\?limit=1/)
  assert.match(sms.buildTestRequest('vonage', {}, { apiKey: 'k', apiSecret: 's' })!.url, /get-balance/)
  assert.match(sms.buildTestRequest('plivo', {}, { accountId: 'MA1', apiSecret: 's' })!.url, /\/Account\/MA1\//)
  assert.equal(sms.buildTestRequest('vonage', {}, {}), null)
})
