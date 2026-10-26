import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CUSTOMER_PREFS,
  DEFAULT_NOTIFICATION_CONFIG,
  decideDelivery,
  eventForAutomation,
  eventForOutbox,
  inQuietHours,
  normalizeCustomerPrefs,
  normalizeNotificationConfig,
  parseCustomerPrefs,
  parseNotificationConfig,
  quietHoursEnd,
} from '../../src/lib/notifications/policy.ts'

const customer = (overrides: Partial<typeof DEFAULT_CUSTOMER_PREFS> = {}, consentContact = true, optOut = false) => ({
  optOut,
  consentContact,
  prefs: { ...DEFAULT_CUSTOMER_PREFS, ...overrides },
})

test('normalizes partial notification config onto defaults', () => {
  const parsed = parseNotificationConfig(JSON.stringify({ customer: { marketing: { enabled: true, channels: ['email', 'fax'] } } }))
  assert.equal(parsed.customer.marketing.enabled, true)
  assert.deepEqual(parsed.customer.marketing.channels, ['email'])
  assert.equal(parsed.customer.booking.enabled, true)
  assert.equal(parsed.staff.missed_call.enabled, true)
  assert.equal(parsed.quietHours.start, DEFAULT_NOTIFICATION_CONFIG.quietHours.start)
})

test('normalizes garbage without throwing', () => {
  assert.deepEqual(normalizeNotificationConfig(null), DEFAULT_NOTIFICATION_CONFIG)
  assert.deepEqual(normalizeCustomerPrefs('nope'), DEFAULT_CUSTOMER_PREFS)
  assert.deepEqual(parseCustomerPrefs('{broken'), DEFAULT_CUSTOMER_PREFS)
  assert.deepEqual(parseCustomerPrefs(JSON.stringify({ sms: false })).sms, false)
})

test('customer opt-out and channel preferences block external delivery', () => {
  const event = { audience: 'customer' as const, event: 'booking' as const }
  const optedOut = decideDelivery({ config: DEFAULT_NOTIFICATION_CONFIG, event, channel: 'email', customer: customer({}, true, true) })
  assert.equal(optedOut.allowed, false)
  if (!optedOut.allowed) assert.match(optedOut.reason, /opted out/)

  const noEmail = decideDelivery({ config: DEFAULT_NOTIFICATION_CONFIG, event, channel: 'email', customer: customer({ email: false }) })
  assert.equal(noEmail.allowed, false)
  if (!noEmail.allowed) assert.match(noEmail.reason, /email/)

  const noBooking = decideDelivery({ config: DEFAULT_NOTIFICATION_CONFIG, event, channel: 'sms', customer: customer({ booking: false }) })
  assert.equal(noBooking.allowed, false)
})

test('marketing requires both an enabled rule and contact consent', () => {
  const event = { audience: 'customer' as const, event: 'marketing' as const }
  const offByDefault = decideDelivery({ config: DEFAULT_NOTIFICATION_CONFIG, event, channel: 'email', customer: customer({ marketing: true }) })
  assert.equal(offByDefault.allowed, false)

  const config = normalizeNotificationConfig({ ...DEFAULT_NOTIFICATION_CONFIG, customer: { ...DEFAULT_NOTIFICATION_CONFIG.customer, marketing: { enabled: true, channels: ['email'] } } })
  const noConsent = decideDelivery({ config, event, channel: 'email', customer: customer({ marketing: true }, false) })
  assert.equal(noConsent.allowed, false)
  if (!noConsent.allowed) assert.match(noConsent.reason, /consent/)

  const allowed = decideDelivery({ config, event, channel: 'email', customer: customer({ marketing: true }, true), now: new Date('2026-01-01T12:00:00') })
  assert.equal(allowed.allowed, true)
})

test('quiet hours defer reminders but not transactional messages', () => {
  const atNight = new Date('2026-01-01T23:30:00')
  const reminder = decideDelivery({
    config: DEFAULT_NOTIFICATION_CONFIG, event: { audience: 'customer', event: 'reminder' }, channel: 'sms', customer: customer(), now: atNight,
  })
  assert.equal(reminder.allowed, true)
  if (reminder.allowed) assert.ok(reminder.deferUntil)
  if (reminder.allowed && reminder.deferUntil) assert.equal(reminder.deferUntil.getHours(), 8)

  const invoice = decideDelivery({
    config: DEFAULT_NOTIFICATION_CONFIG, event: { audience: 'customer', event: 'invoice' }, channel: 'email', customer: customer(), now: atNight,
  })
  assert.equal(invoice.allowed, true)
  if (invoice.allowed) assert.equal(invoice.deferUntil, undefined)
})

test('quiet hours wrap midnight and ignore equal start/end', () => {
  assert.equal(inQuietHours(new Date('2026-01-01T23:00:00'), '21:00', '08:00'), true)
  assert.equal(inQuietHours(new Date('2026-01-01T03:00:00'), '21:00', '08:00'), true)
  assert.equal(inQuietHours(new Date('2026-01-01T12:00:00'), '21:00', '08:00'), false)
  assert.equal(inQuietHours(new Date('2026-01-01T12:00:00'), '08:00', '08:00'), false)
  const end = quietHoursEnd(new Date('2026-01-01T23:00:00'), '08:00')
  assert.equal(end.getDate(), 2)
  assert.equal(end.getHours(), 8)
})

test('staff alerts are not blocked by customer opt-out or quiet hours', () => {
  const decision = decideDelivery({
    config: DEFAULT_NOTIFICATION_CONFIG,
    event: { audience: 'staff', event: 'missed_call' },
    channel: 'email',
    customer: customer({ marketing: false }, false, true),
    now: new Date('2026-01-01T23:30:00'),
  })
  assert.equal(decision.allowed, true)
})

test('channel not allowed by routing is skipped, but disabled event has priority', () => {
  const config = normalizeNotificationConfig({
    ...DEFAULT_NOTIFICATION_CONFIG,
    customer: { ...DEFAULT_NOTIFICATION_CONFIG.customer, invoice: { enabled: false, channels: ['email'] } },
  })
  const decision = decideDelivery({ config, event: { audience: 'customer', event: 'invoice' }, channel: 'email', customer: customer() })
  assert.equal(decision.allowed, false)
  if (!decision.allowed) assert.match(decision.reason, /disabled/)
})

test('maps outbox rows to notification events', () => {
  assert.deepEqual(eventForOutbox({ channel: 'email', subject: 'Appointment reminder — Cut', relatedType: 'booking' }), { audience: 'customer', event: 'reminder' })
  assert.deepEqual(eventForOutbox({ channel: 'email', subject: 'Your invoice', relatedType: 'invoice', dedupeKey: 'invoice_sent:1' }), { audience: 'customer', event: 'invoice' })
  assert.deepEqual(eventForOutbox({ channel: 'sms', subject: 'Re: question', relatedType: 'conversation' }), { audience: 'customer', event: 'service' })
  assert.deepEqual(eventForOutbox({ channel: 'email', subject: 'Missed call from +1555', relatedType: 'telephony_call', dedupeKey: 'missed_call:1' }), { audience: 'staff', event: 'missed_call' })
  assert.deepEqual(eventForOutbox({ channel: 'email', subject: 'New voicemail', relatedType: 'telephony_call', dedupeKey: 'voicemail:1' }), { audience: 'staff', event: 'voicemail' })
})

test('maps automation triggers to customer events', () => {
  assert.equal(eventForAutomation('invoice_overdue'), 'reminder')
  assert.equal(eventForAutomation('booking_created'), 'booking')
  assert.equal(eventForAutomation('conversation_escalated'), 'service')
  assert.equal(eventForAutomation('manual'), 'marketing')
})
