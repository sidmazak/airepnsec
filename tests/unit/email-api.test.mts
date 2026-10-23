import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EMAIL_API_PROVIDER_IDS,
  buildEmailApiRequest,
  buildEmailApiTestRequest,
  extractEmailMessageId,
  isEmailApiProviderId,
  mailgunRequest,
  resendRequest,
  sendgridRequest,
} from '../../src/lib/integrations/emailApi.ts'

const message = { to: 'customer@example.com', subject: 'Your invoice', text: 'Amount due: $50', html: '<p>Amount due: $50</p>' }

test('provider ids are closed and labelled', () => {
  assert.deepEqual(EMAIL_API_PROVIDER_IDS, ['sendgrid', 'mailgun', 'postmark', 'resend', 'brevo'])
  assert.equal(isEmailApiProviderId('sendgrid'), true)
  assert.equal(isEmailApiProviderId('smtp'), false)
})

test('sendgridRequest builds a personalizations payload', () => {
  const req = sendgridRequest({ from: 'billing@example.com' }, 'SG.key', message)
  assert.equal(req.url, 'https://api.sendgrid.com/v3/mail/send')
  assert.equal(req.headers.authorization, 'Bearer SG.key')
  const body = JSON.parse(req.body!)
  assert.deepEqual(body.personalizations, [{ to: [{ email: 'customer@example.com' }] }])
  assert.deepEqual(body.from, { email: 'billing@example.com' })
  assert.equal(body.content.length, 2)
  assert.equal(body.content[1].type, 'text/html')
})

test('mailgunRequest uses the region host, domain and basic auth', () => {
  const req = mailgunRequest({ from: 'billing@example.com', domain: 'mg.example.com', region: 'eu' }, 'key-1', message)
  assert.equal(req.url, 'https://api.eu.mailgun.net/v3/mg.example.com/messages')
  assert.match(String(req.headers.authorization), /^Basic /)
  assert.equal(Buffer.from(String(req.headers.authorization).slice(6), 'base64').toString(), 'api:key-1')
  const form = new URLSearchParams(req.body!)
  assert.equal(form.get('to'), 'customer@example.com')
  assert.equal(form.get('html'), '<p>Amount due: $50</p>')
  assert.throws(() => mailgunRequest({ from: 'a@b.co' }, 'k', message), /domain/)
})

test('resendRequest sends JSON with the bearer key', () => {
  const req = resendRequest({ from: 'billing@example.com' }, 're_1', message)
  assert.equal(req.url, 'https://api.resend.com/emails')
  assert.equal(req.headers.authorization, 'Bearer re_1')
  const body = JSON.parse(req.body!)
  assert.deepEqual(body.to, ['customer@example.com'])
  assert.equal(body.html, '<p>Amount due: $50</p>')
})

test('buildEmailApiRequest validates provider, key and sender', () => {
  assert.throws(() => buildEmailApiRequest('unknown', {}, { apiKey: 'k' }, message), /Unknown email API/)
  assert.throws(() => buildEmailApiRequest('sendgrid', { from: 'a@b.co' }, {}, message), /apiKey/)
  assert.throws(() => buildEmailApiRequest('sendgrid', {}, { apiKey: 'k' }, message), /from/)
  assert.throws(() => buildEmailApiRequest('postmark', { from: 'a@b.co' }, { apiKey: 'k' }, { ...message, to: '' }), /recipient/)
})

test('buildEmailApiTestRequest uses read-only endpoints', () => {
  assert.equal(buildEmailApiTestRequest('sendgrid', {}, { apiKey: 'k' }).url, 'https://api.sendgrid.com/v3/scopes')
  assert.match(buildEmailApiTestRequest('mailgun', { region: 'eu' }, { apiKey: 'k' }).url, /^https:\/\/api\.eu\.mailgun\.net\/v3\/domains/)
  assert.equal(buildEmailApiTestRequest('postmark', {}, { apiKey: 'k' }).url, 'https://api.postmarkapp.com/server')
  assert.equal(buildEmailApiTestRequest('resend', {}, { apiKey: 'k' }).url, 'https://api.resend.com/domains')
  assert.equal(buildEmailApiTestRequest('brevo', {}, { apiKey: 'k' }).url, 'https://api.brevo.com/v3/account')
})

test('extractEmailMessageId prefers the header then common body keys', () => {
  const headers = { get: (name: string) => name === 'x-message-id' ? 'hdr-1' : null }
  assert.equal(extractEmailMessageId('sendgrid', {}, headers), 'hdr-1')
  assert.equal(extractEmailMessageId('resend', { id: 're_123' }), 're_123')
  assert.equal(extractEmailMessageId('postmark', { MessageID: 'pm-1' }), 'pm-1')
  assert.equal(extractEmailMessageId('brevo', { messageId: '<abc@example.com>' }), '<abc@example.com>')
  assert.equal(extractEmailMessageId('sendgrid', null), '')
})
