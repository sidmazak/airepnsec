import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BOOKING_MARKER_PREFIX,
  MICROSOFT_SCOPES,
  MICROSOFT_TENANT_DEFAULT,
  buildGraphEvent,
  isAccessTokenFresh,
  microsoftAuthUrl,
  parseTokenResponse,
  readBookingId,
} from '../../src/lib/integrations/microsoftGraph.ts'

test('microsoftAuthUrl targets the default tenant and encodes every parameter', () => {
  const url = new URL(
    microsoftAuthUrl({ clientId: 'client-123', redirectUri: 'http://localhost:3000/cb', state: 'st-1' }),
  )
  assert.equal(url.host, 'login.microsoftonline.com')
  assert.equal(url.pathname, `/common/oauth2/v2.0/authorize`)
  assert.equal(url.searchParams.get('client_id'), 'client-123')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('response_mode'), 'query')
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3000/cb')
  assert.equal(url.searchParams.get('state'), 'st-1')
  assert.equal(url.searchParams.get('scope'), MICROSOFT_SCOPES.join(' '))
})

test('microsoftAuthUrl honours a tenant id', () => {
  const url = new URL(microsoftAuthUrl({ clientId: 'c', redirectUri: 'https://x/cb', state: 's', tenant: '11111111-2222-3333-4444-555555555555' }))
  assert.equal(url.pathname, `/11111111-2222-3333-4444-555555555555/oauth2/v2.0/authorize`)
  assert.notEqual(MICROSOFT_TENANT_DEFAULT, 'organizations')
})

test('parseTokenResponse maps the token payload and derives the expiry', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const tokens = parseTokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }, now)
  assert.equal(tokens.accessToken, 'at')
  assert.equal(tokens.refreshToken, 'rt')
  assert.equal(tokens.accessTokenExpiresAt, '2026-01-01T01:00:00.000Z')
})

test('parseTokenResponse keeps a missing refresh token empty instead of failing', () => {
  const tokens = parseTokenResponse({ access_token: 'at' }, new Date('2026-01-01T00:00:00.000Z'))
  assert.equal(tokens.refreshToken, '')
  assert.equal(tokens.accessTokenExpiresAt, '2026-01-01T01:00:00.000Z')
})

test('parseTokenResponse throws with the provider description', () => {
  assert.throws(() => parseTokenResponse({ error_description: 'invalid_client' }), /invalid_client/)
  assert.throws(() => parseTokenResponse({}), /did not return an access token/)
})

test('isAccessTokenFresh respects the skew window', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  assert.equal(isAccessTokenFresh('2026-01-01T00:30:00.000Z', now), true)
  assert.equal(isAccessTokenFresh('2026-01-01T00:00:30.000Z', now), false)
  assert.equal(isAccessTokenFresh('2026-01-01T00:10:00.000Z', now, 0), true)
  assert.equal(isAccessTokenFresh('', now), false)
  assert.equal(isAccessTokenFresh('not-a-date', now), false)
})

test('buildGraphEvent writes the booking marker into the body', () => {
  const event = buildGraphEvent({
    bookingId: 'bk_123',
    title: 'Consultation — Ann',
    description: 'Booked via AI Secretary',
    startAt: new Date('2026-01-02T10:00:00.000Z'),
    endAt: new Date('2026-01-02T11:00:00.000Z'),
    attendeeEmail: 'ann@example.com',
    attendeeName: 'Ann',
  })
  const body = event.body as { content: string; contentType: string }
  assert.equal(event.subject, 'Consultation — Ann')
  assert.equal(event.showAs, 'busy')
  assert.ok(body.content.includes(`${BOOKING_MARKER_PREFIX} bk_123`))
  assert.deepEqual(event.start, { dateTime: '2026-01-02T10:00:00.000Z', timeZone: 'UTC' })
  assert.deepEqual(event.end, { dateTime: '2026-01-02T11:00:00.000Z', timeZone: 'UTC' })
  const attendees = event.attendees as Array<{ emailAddress: { address: string; name: string }; type: string }>
  assert.equal(attendees[0].emailAddress.address, 'ann@example.com')
  assert.equal(attendees[0].type, 'required')
})

test('buildGraphEvent omits attendees when no email is known', () => {
  const event = buildGraphEvent({
    bookingId: 'bk_9',
    title: 'Walk-in',
    description: 'd',
    startAt: new Date('2026-01-02T10:00:00.000Z'),
    endAt: new Date('2026-01-02T11:00:00.000Z'),
  })
  assert.equal('attendees' in event, false)
})

test('readBookingId recovers the booking id from a marked event', () => {
  assert.equal(readBookingId({ body: { content: 'hello\n\nais-booking-id: cmvabc123' } }), 'cmvabc123')
  assert.equal(readBookingId({ body: { content: 'ais-booking-id:bk-42' } }), 'bk-42')
  assert.equal(readBookingId({ body: { content: 'no marker here' } }), null)
  assert.equal(readBookingId({}), null)
})
