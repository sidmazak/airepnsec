import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BOOKING_EXT_PROPERTY,
  buildBookingEvent,
  eventRange,
  isAccessTokenFresh,
  parseTokenResponse,
  readBookingId,
} from '../../src/lib/integrations/googleCalendar.ts'

test('BOOKING_EXT_PROPERTY is a stable key', () => {
  assert.equal(typeof BOOKING_EXT_PROPERTY, 'string')
  assert.ok(BOOKING_EXT_PROPERTY.length > 0)
})

test('parseTokenResponse normalizes expiresIn to ISO', () => {
  const t = parseTokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: '3600' })
  assert.equal(t.accessToken, 'at')
  assert.equal(t.refreshToken, 'rt')
  assert.ok(/^\d{4}-/.test(t.accessTokenExpiresAt), t.accessTokenExpiresAt)
})

test('parseTokenResponse throws without access_token', () => {
  assert.throws(() => parseTokenResponse({ refresh_token: 'rt', expires_in: '3600' }))
})

test('isAccessTokenFresh returns false when expired or missing', () => {
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  assert.equal(isAccessTokenFresh('', new Date()), false)
  assert.equal(isAccessTokenFresh('x', new Date(), 60_000), false)
  assert.equal(isAccessTokenFresh(past, new Date(), 60_000), false)
})

test('isAccessTokenFresh returns true when just-in-time', () => {
  const fresh = new Date(Date.now() + 5 * 60_000).toISOString()
  assert.equal(isAccessTokenFresh(fresh, new Date(), 60_000), true)
})

test('isAccessTokenFresh treats unparseable expiry strings as expired', () => {
  // an unreadable timestamp must trigger a refresh instead of reusing a stale token
  assert.equal(isAccessTokenFresh('not-a-date', new Date()), false)
})

test('readBookingId reads the pushed booking id', () => {
  const ev = {
    id: 'evt1',
    extendedProperties: { private: { [BOOKING_EXT_PROPERTY]: 'booking-abc123' } },
  }
  assert.equal(readBookingId(ev), 'booking-abc123')
})

test('readBookingId returns null for foreign events', () => {
  const ev = { id: 'evt2' }
  assert.equal(readBookingId(ev), null)
  assert.equal(readBookingId({ ...ev, extendedProperties: {} }), null)
})

test('buildBookingEvent stamps the booking id and UTC times', () => {
  const start = new Date('2026-01-01T09:00:00Z')
  const end = new Date('2026-01-01T09:30:00Z')
  const ev = buildBookingEvent({
    bookingId: 'b9',
    title: 'Haircut',
    description: 'done',
    location: 'Studio',
    startAt: start,
    endAt: end,
    attendeeEmail: 'c@example.com',
  })
  assert.equal(ev.summary, 'Haircut')
  assert.deepEqual(ev.start, { dateTime: '2026-01-01T09:00:00.000Z' })
  assert.deepEqual(ev.end, { dateTime: '2026-01-01T09:30:00.000Z' })
  assert.deepEqual(ev.extendedProperties.private[BOOKING_EXT_PROPERTY], 'b9')
  assert.equal(ev.attendees?.[0].email, 'c@example.com')
})

test('eventRange parses RFC3339 instrences and falls back to dates', () => {
  const ms = new Date('2026-03-01T10:00:00Z').getTime()
  assert.deepEqual(eventRange({ id: 'a', start: { dateTime: '2026-03-01T10:00:00Z' }, end: { dateTime: '2026-03-01T11:00:00Z' } }), { start: new Date(ms), end: new Date(ms + 3600_000) })
  assert.deepEqual(eventRange({ id: 'a', start: { date: '2026-03-01' }, end: { date: '2026-03-02' } }), { start: new Date(Date.UTC(2026, 2, 1)), end: new Date(Date.UTC(2026, 2, 2)) })
  assert.equal(eventRange({ id: 'a' }), null)
})

test('eventRange rejects unparseable values', () => {
  assert.equal(eventRange({ id: 'a', start: { dateTime: 'nope' }, end: { dateTime: 'also-no' } }), null)
})
