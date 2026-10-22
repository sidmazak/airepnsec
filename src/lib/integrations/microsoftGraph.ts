/**
 * Microsoft 365 / Graph calendar client.
 *
 * OAuth 2.0 authorization-code flow against the Microsoft identity platform
 * (v2.0 endpoints) plus the Graph calendar API:
 *
 *   authorize: https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize
 *   token:     https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
 *   graph:     https://graph.microsoft.com/v1.0
 *
 * The booking marker is written into the event body (`ais-booking-id: <id>`) so
 * a pushed event can be matched back to its booking when it is read again.
 * Everything here is server-side: tokens never leave the server.
 */

export const MICROSOFT_TENANT_DEFAULT = 'common'
export const MICROSOFT_SCOPES = ['offline_access', 'User.Read', 'Calendars.ReadWrite']
export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
export const BOOKING_MARKER_PREFIX = 'ais-booking-id:'

export type MicrosoftTokens = {
  accessToken: string
  refreshToken: string
  accessTokenExpiresAt: string
}

export type MicrosoftGraphEvent = {
  id?: string
  subject?: string
  body?: { content?: string; contentType?: string }
  start?: { dateTime?: string; timeZone?: string }
  end?: { dateTime?: string; timeZone?: string }
  isCancelled?: boolean
  showAs?: string
}

export function microsoftAuthUrl(input: { clientId: string; redirectUri: string; state: string; tenant?: string }): string {
  const tenant = input.tenant || MICROSOFT_TENANT_DEFAULT
  const params = new URLSearchParams({
    client_id: input.clientId,
    response_type: 'code',
    redirect_uri: input.redirectUri,
    response_mode: 'query',
    scope: MICROSOFT_SCOPES.join(' '),
    state: input.state,
  })
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize?${params.toString()}`
}

export function parseTokenResponse(body: unknown, now: Date = new Date()): MicrosoftTokens {
  const b = (body ?? {}) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string }
  if (!b.access_token) {
    throw new Error(b.error_description || 'Microsoft did not return an access token')
  }
  const expiresIn = Number(b.expires_in ?? 3600)
  return {
    accessToken: b.access_token,
    refreshToken: b.refresh_token ?? '',
    accessTokenExpiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
  }
}

export function isAccessTokenFresh(expiresAt: string, now: Date = new Date(), skewMs = 60_000): boolean {
  if (!expiresAt) return false
  const t = new Date(expiresAt).getTime()
  if (!Number.isFinite(t)) return false
  return t - skewMs > now.getTime()
}

async function tokenRequest(params: Record<string, string>, tenant: string): Promise<MicrosoftTokens> {
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant || MICROSOFT_TENANT_DEFAULT)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20_000),
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const desc = (body.error_description as string) || (body.error as string) || `HTTP ${res.status}`
    throw new Error(`Microsoft token request failed: ${desc}`)
  }
  return parseTokenResponse(body)
}

export async function exchangeCodeForTokens(input: {
  clientId: string
  clientSecret: string
  code: string
  redirectUri: string
  tenant?: string
}): Promise<MicrosoftTokens> {
  return tokenRequest(
    {
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
      scope: MICROSOFT_SCOPES.join(' '),
    },
    input.tenant ?? MICROSOFT_TENANT_DEFAULT
  )
}

export async function refreshAccessToken(input: {
  clientId: string
  clientSecret: string
  refreshToken: string
  tenant?: string
}): Promise<MicrosoftTokens> {
  return tokenRequest(
    {
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
      grant_type: 'refresh_token',
      scope: MICROSOFT_SCOPES.join(' '),
    },
    input.tenant ?? MICROSOFT_TENANT_DEFAULT
  )
}

async function graphFetch(token: string, path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(25_000),
  })
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { ok: res.ok, status: res.status, body }
}

/** Calendar view (events in a time window) for the signed-in user. */
export async function listGraphEvents(input: { token: string; timeMin: Date; timeMax: Date }): Promise<{ events: MicrosoftGraphEvent[]; error: string }> {
  const params = new URLSearchParams({
    startDateTime: input.timeMin.toISOString(),
    endDateTime: input.timeMax.toISOString(),
    '$select': 'id,subject,body,start,end,isCancelled,showAs',
    '$top': '500',
    '$orderby': 'start/dateTime',
  })
  const res = await graphFetch(input.token, `/me/calendarView?${params.toString()}`)
  if (!res.ok) {
    const err = (res.body as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`
    return { events: [], error: err }
  }
  const value = (res.body as { value?: MicrosoftGraphEvent[] })?.value ?? []
  return { events: value, error: '' }
}

/** Free/busy schedule for the signed-in user's calendar. */
export async function queryGraphSchedule(input: {
  token: string
  timeMin: Date
  timeMax: Date
  email: string
}): Promise<{ busy: Array<{ start: Date; end: Date }>; errors: string[] }> {
  const res = await graphFetch(input.token, '/me/calendar/getSchedule', {
    method: 'POST',
    body: JSON.stringify({
      schedules: [input.email],
      startTime: { dateTime: input.timeMin.toISOString(), timeZone: 'UTC' },
      endTime: { dateTime: input.timeMax.toISOString(), timeZone: 'UTC' },
      availabilityViewInterval: 30,
    }),
  })
  if (!res.ok) {
    const err = (res.body as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`
    return { busy: [], errors: [err] }
  }
  const items = (res.body as { value?: Array<{ scheduleItems?: Array<{ start?: { dateTime?: string }; end?: { dateTime?: string } }> }> })?.value ?? []
  const busy: Array<{ start: Date; end: Date }> = []
  for (const item of items) {
    for (const slot of item.scheduleItems ?? []) {
      const start = slot.start?.dateTime ? new Date(slot.start.dateTime) : null
      const end = slot.end?.dateTime ? new Date(slot.end.dateTime) : null
      if (start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) busy.push({ start, end })
    }
  }
  return { busy, errors: [] }
}

export function buildGraphEvent(input: {
  bookingId: string
  title: string
  description: string
  startAt: Date
  endAt: Date
  attendeeEmail?: string
  attendeeName?: string
}): Record<string, unknown> {
  return {
    subject: input.title,
    body: { contentType: 'text', content: `${input.description}\n\n${BOOKING_MARKER_PREFIX} ${input.bookingId}` },
    start: { dateTime: input.startAt.toISOString(), timeZone: 'UTC' },
    end: { dateTime: input.endAt.toISOString(), timeZone: 'UTC' },
    showAs: 'busy',
    ...(input.attendeeEmail
      ? { attendees: [{ emailAddress: { address: input.attendeeEmail, name: input.attendeeName || input.attendeeEmail }, type: 'required' }] }
      : {}),
  }
}

export function readBookingId(event: MicrosoftGraphEvent): string | null {
  const content = event.body?.content ?? ''
  const match = new RegExp(`${BOOKING_MARKER_PREFIX}\\s*([A-Za-z0-9_-]+)`).exec(content)
  return match ? match[1] : null
}

/** Create or update the Graph event that mirrors a booking. */
export async function upsertGraphEvent(input: {
  token: string
  bookingId: string
  event: Record<string, unknown>
  existingEventId?: string
}): Promise<{ ok: boolean; detail: string; eventId: string }> {
  if (input.existingEventId) {
    const res = await graphFetch(input.token, `/me/events/${encodeURIComponent(input.existingEventId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input.event),
    })
    if (!res.ok) {
      const err = (res.body as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`
      return { ok: false, detail: `Graph update failed: ${err}`, eventId: input.existingEventId }
    }
    return { ok: true, detail: 'event updated', eventId: input.existingEventId }
  }
  const res = await graphFetch(input.token, '/me/events', {
    method: 'POST',
    body: JSON.stringify(input.event),
  })
  if (!res.ok) {
    const err = (res.body as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`
    return { ok: false, detail: `Graph create failed: ${err}`, eventId: '' }
  }
  const id = (res.body as { id?: string })?.id ?? ''
  return { ok: true, detail: 'event created', eventId: id }
}

export async function deleteGraphEvent(input: { token: string; eventId: string }): Promise<{ ok: boolean; detail: string }> {
  const res = await graphFetch(input.token, `/me/events/${encodeURIComponent(input.eventId)}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) {
    const err = (res.body as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`
    return { ok: false, detail: `Graph delete failed: ${err}` }
  }
  return { ok: true, detail: 'event removed' }
}

/** Real connection test — asks Graph for the user's calendar view. */
export async function testMicrosoftCalendar(input: { token: string }): Promise<{ ok: boolean; detail: string }> {
  const now = new Date()
  const res = await graphFetch(
    input.token,
    `/me/calendarView?startDateTime=${encodeURIComponent(now.toISOString())}&endDateTime=${encodeURIComponent(new Date(now.getTime() + 7 * 86400_000).toISOString())}&$top=1`
  )
  if (!res.ok) {
    const err = (res.body as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`
    return { ok: false, detail: `Microsoft 365 calendar test failed: ${err}` }
  }
  return { ok: true, detail: 'Connected to Microsoft 365 — the calendar view was read successfully.' }
}
