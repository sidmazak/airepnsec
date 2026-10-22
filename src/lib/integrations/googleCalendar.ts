/**
 * Google Calendar adapter (BYOK, OAuth 2.0 authorization-code flow).
 *
 * The module is intentionally free of database imports so it stays unit-testable;
 * persistence of tokens is the caller's job (routes under /api/integrations/**).
 *
 * Endpoints are fixed Google URLs — no user-controlled host, so the outbound
 * SSRF guard does not apply here (unlike webhooks/SMS gateways where the
 * destination is user-supplied).
 */

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_API_BASE = 'https://www.googleapis.com/calendar/v3'

/** Events (read/write) + read-only calendar access for free/busy queries. */
export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ')

export type GoogleTokens = {
  accessToken: string
  refreshToken: string
  /** ISO timestamp — the access token is refreshed when this is in the past. */
  accessTokenExpiresAt: string
}

export type GoogleCalendarConfig = {
  clientId: string
  clientSecret: string
  calendarId: string
  redirectUri: string
}

export type GoogleEvent = {
  id: string
  status?: string
  summary?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  extendedProperties?: { private?: Record<string, string> }
}

/** Consent URL. `state` must be a server-side nonce tied to the org + user. */
export function googleAuthUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT)
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', GOOGLE_CALENDAR_SCOPES)
  url.searchParams.set('access_type', 'offline') // ask for a refresh token
  url.searchParams.set('prompt', 'consent') // always return a refresh token
  url.searchParams.set('include_granted_scopes', 'true')
  url.searchParams.set('state', input.state)
  return url.toString()
}

/** Parse a Google token endpoint response into our token shape. Throws on malformed payloads. */
export function parseTokenResponse(body: unknown, now: Date = new Date()): GoogleTokens {
  const data = (body ?? {}) as Record<string, unknown>
  const accessToken = typeof data.access_token === 'string' ? data.access_token : ''
  if (!accessToken) {
    const desc = typeof data.error_description === 'string' ? data.error_description : typeof data.error === 'string' ? data.error : 'no access_token in response'
    throw new Error(`Google token endpoint did not return an access token (${desc})`)
  }
  const expiresIn = Number(data.expires_in ?? 3600)
  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : ''
  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: new Date(now.getTime() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000).toISOString(),
  }
}

export function isAccessTokenFresh(expiresAt: string, now: Date = new Date(), skewMs = 60_000): boolean {
  if (!expiresAt) return false
  const t = Date.parse(expiresAt)
  if (Number.isNaN(t)) return false
  return t - skewMs > now.getTime()
}

/** Exchange an authorization code for tokens (first connect). */
export async function exchangeCodeForTokens(input: {
  clientId: string
  clientSecret: string
  code: string
  redirectUri: string
}): Promise<{ accessToken: string; refreshToken: string; accessTokenExpiresAt: string }> {
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const desc = (body as Record<string, unknown>)?.error_description ?? `HTTP ${res.status}`
    throw new Error(`Google rejected the authorization code: ${String(desc).slice(0, 200)}`)
  }
  return parseTokenResponse(body)
}

/** Refresh an expired access token using the stored refresh token. */
export async function refreshAccessToken(input: {
  clientId: string
  clientSecret: string
  refreshToken: string
}): Promise<{ accessToken: string; accessTokenExpiresAt: string }> {
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const desc = (body as Record<string, unknown>)?.error_description ?? `HTTP ${res.status}`
    throw new Error(`Google rejected the refresh token: ${String(desc).slice(0, 200)}`)
  }
  const parsed = parseTokenResponse(body)
  return { accessToken: parsed.accessToken, accessTokenExpiresAt: parsed.accessTokenExpiresAt }
}

/* ---------------- calendar API ---------------- */

async function googleFetch(token: string, path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${GOOGLE_API_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  })
  const body = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, body }
}

export type BusyInterval = { calendarId: string; start: Date; end: Date }

/**
 * Free/busy query. Google returns busy intervals without event titles or ids —
 * that is exactly what the availability engine needs.
 */
export async function queryFreeBusy(input: {
  token: string
  calendarIds: string[]
  timeMin: Date
  timeMax: Date
}): Promise<{ busy: BusyInterval[]; errors: string[] }> {
  const calendars = Object.fromEntries(input.calendarIds.map((id) => [id, { timeMin: input.timeMin.toISOString(), timeMax: input.timeMax.toISOString() }]))
  const res = await googleFetch(input.token, '/freeBusy', {
    method: 'POST',
    body: JSON.stringify({ timeMin: input.timeMin.toISOString(), timeMax: input.timeMax.toISOString(), items: calendars }),
  })
  if (!res.ok) {
    const err = (res.body as Record<string, unknown>)?.error
    const desc = (err as Record<string, unknown> | undefined)?.message ?? `HTTP ${res.status}`
    throw new Error(`Google free/busy query failed: ${String(desc).slice(0, 200)}`)
  }
  const body = res.body as { calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: Array<{ reason: string }> }> }
  const busy: BusyInterval[] = []
  const errors: string[] = []
  for (const [calendarId, entry] of Object.entries(body.calendars ?? {})) {
    for (const e of entry.errors ?? []) errors.push(`${calendarId}: ${e.reason}`)
    for (const b of entry.busy ?? []) {
      const start = new Date(b.start)
      const end = new Date(b.end)
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue
      busy.push({ calendarId, start, end })
    }
  }
  return { busy, errors }
}

/** List events in a window (expanded, single instances) — used to pull remote changes back. */
export async function listEvents(input: {
  token: string
  calendarId: string
  timeMin: Date
  timeMax: Date
  maxResults?: number
}): Promise<{ events: GoogleEvent[]; error: string | null }> {
  const params = new URLSearchParams({
    timeMin: input.timeMin.toISOString(),
    timeMax: input.timeMax.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    // Deleted events come back with status "cancelled" — that is how a remote
    // cancellation becomes visible to the pull step.
    showDeleted: 'true',
    maxResults: String(input.maxResults ?? 250),
  })
  const res = await googleFetch(input.token, `/calendars/${encodeURIComponent(input.calendarId)}/events?${params.toString()}`)
  if (!res.ok) {
    const err = (res.body as Record<string, unknown>)?.error
    const desc = (err as Record<string, unknown> | undefined)?.message ?? `HTTP ${res.status}`
    return { events: [], error: String(desc).slice(0, 200) }
  }
  const body = res.body as { items?: GoogleEvent[] }
  return { events: body.items ?? [], error: null }
}

/** Private extended-property key we stamp on every event we push, so pushes stay idempotent. */
export const BOOKING_EXT_PROPERTY = 'aisBookingId'

/** Read the booking id we stamped on a pushed event (null for foreign events). */
export function readBookingId(event: GoogleEvent): string | null {
  const value = event.extendedProperties?.private?.[BOOKING_EXT_PROPERTY]
  return typeof value === 'string' && value ? value : null
}

/** Build the event payload for a booking (times are RFC 3339 UTC). */
export function buildBookingEvent(input: {
  bookingId: string
  title: string
  description?: string
  location?: string
  startAt: Date
  endAt: Date
  attendeeEmail?: string
  attendeeName?: string
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    summary: input.title,
    description: input.description ?? '',
    start: { dateTime: input.startAt.toISOString() },
    end: { dateTime: input.endAt.toISOString() },
    extendedProperties: { private: { [BOOKING_EXT_PROPERTY]: input.bookingId } },
  }
  if (input.location) payload.location = input.location
  if (input.attendeeEmail) {
    payload.attendees = [{ email: input.attendeeEmail, displayName: input.attendeeName ?? input.attendeeEmail }]
  }
  return payload
}

/**
 * Insert or update the event for a booking. Uses the private extended property
 * to find the previously created event, so re-pushing is idempotent.
 */
export async function upsertBookingEvent(input: {
  token: string
  calendarId: string
  bookingId: string
  event: Record<string, unknown>
}): Promise<{ ok: boolean; eventId: string | null; detail: string }> {
  const prop = BOOKING_EXT_PROPERTY
  const find = new URLSearchParams({ privateExtendedProperty: `${prop}=${input.bookingId}`, maxResults: '5' })
  const existing = await googleFetch(input.token, `/calendars/${encodeURIComponent(input.calendarId)}/events?${find.toString()}`)
  const found = existing.ok ? ((existing.body as { items?: GoogleEvent[] })?.items ?? [])[0] : undefined
  const path = found?.id
    ? `/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(found.id)}`
    : `/calendars/${encodeURIComponent(input.calendarId)}/events`
  const res = await googleFetch(input.token, path, {
    method: found?.id ? 'PATCH' : 'POST',
    body: JSON.stringify(input.event),
  })
  if (!res.ok) {
    const err = (res.body as Record<string, unknown>)?.error
    const desc = (err as Record<string, unknown> | undefined)?.message ?? `HTTP ${res.status}`
    return { ok: false, eventId: null, detail: `Google rejected the event: ${String(desc).slice(0, 200)}` }
  }
  const body = res.body as { id?: string }
  return { ok: true, eventId: body.id ?? found?.id ?? null, detail: found?.id ? 'updated existing event' : 'created event' }
}

/** Delete a previously pushed event (used when a booking is cancelled). */
export async function deleteBookingEvent(input: { token: string; calendarId: string; eventId: string }): Promise<{ ok: boolean; detail: string }> {
  const res = await googleFetch(input.token, `/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`, { method: 'DELETE' })
  if (res.ok) return { ok: true, detail: 'event removed' }
  if (res.status === 404 || res.status === 410) return { ok: true, detail: 'event already gone' }
  const err = (res.body as Record<string, unknown>)?.error
  const desc = (err as Record<string, unknown> | undefined)?.message ?? `HTTP ${res.status}`
  return { ok: false, detail: `Google rejected the delete: ${String(desc).slice(0, 200)}` }
}

/**
 * Real connection test: authenticates and reads the calendar list.
 * Reports honest failures — never claims success without a real API answer.
 */
export async function testGoogleCalendar(input: {
  token: string
  calendarId: string
}): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await googleFetch(input.token, `/calendars/${encodeURIComponent(input.calendarId)}`)
    if (!res.ok) {
      const err = (res.body as Record<string, unknown>)?.error
      const desc = (err as Record<string, unknown> | undefined)?.message ?? `HTTP ${res.status}`
      return { ok: false, detail: `Google Calendar rejected the request: ${String(desc).slice(0, 200)}` }
    }
    const body = res.body as { id?: string; summary?: string; accessRole?: string }
    return {
      ok: true,
      detail: `Google Calendar verified — calendar "${body.summary ?? body.id ?? input.calendarId}" (access: ${body.accessRole ?? 'unknown'})`,
    }
  } catch (err) {
    return { ok: false, detail: `Google Calendar test failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** Normalize an event's start/end into UTC dates (handles all-day events). */
export function eventRange(event: GoogleEvent): { start: Date; end: Date } | null {
  const rawStart = event.start?.dateTime ?? event.start?.date
  const rawEnd = event.end?.dateTime ?? event.end?.date
  if (!rawStart || !rawEnd) return null
  const start = new Date(rawStart)
  const end = new Date(rawEnd)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null
  return { start, end }
}
