import { integrationConfig, decryptSecrets, str, sanitizeMessage, type TestResult } from '@/lib/integrations/connectors'
import type { Organization } from '@prisma/client'

/**
 * Real CalDAV client (push sync of bookings as VEVENTs).
 * Uses raw HTTP verbs — PROPFIND for health/capability discovery, PUT/DELETE for
 * event upsert/removal — with HTTP Basic auth. Works with Radicale, Nextcloud,
 * Fastmail, iCloud (app-specific password), and other standard CalDAV servers.
 */

export type CalDavCreds = { url: string; username: string; password: string }

export function caldavCreds(integration: { configJson: string; secretsEnc: string }): CalDavCreds | null {
  const config = integrationConfig(integration)
  const secrets = decryptSecrets(integration)
  const url = str(config, 'url')
  if (!/^https?:\/\//i.test(url)) return null
  return { url: url.replace(/\/$/, ''), username: str(config, 'username'), password: str(secrets, 'password') }
}

async function davFetch(creds: CalDavCreds, path: string, method: string, body?: string, contentType = 'application/xml; charset=utf-8'): Promise<Response> {
  const url = path.startsWith('http') ? path : `${creds.url}${path.startsWith('/') ? '' : '/'}${path}`
  const auth = creds.username
    ? `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`
    : undefined
  return fetch(url, {
    method,
    headers: { ...(auth ? { authorization: auth } : {}), ...(body ? { 'content-type': contentType } : {}) },
    body,
    signal: AbortSignal.timeout(15_000),
  })
}

const PROPFIND_BODY = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>`

/** Health check: real PROPFIND against the calendar collection. 207 (or 200) = alive. */
export async function testCaldav(integration: { configJson: string; secretsEnc: string }): Promise<TestResult> {
  const creds = caldavCreds(integration)
  if (!creds) return { ok: false, detail: 'CalDAV config needs a calendar URL starting with http:// or https://' }
  try {
    const res = await davFetch(creds, '', 'PROPFIND', PROPFIND_BODY)
    if (res.status === 401) return { ok: false, detail: 'CalDAV server rejected the credentials (HTTP 401 — check username/app-password)' }
    if (res.status === 403) return { ok: false, detail: 'CalDAV server denied access to this collection (HTTP 403)' }
    if (res.status === 404) return { ok: false, detail: 'CalDAV calendar URL not found (HTTP 404) — point at the calendar collection, e.g. https://host/user/calendar/' }
    if (res.status !== 207 && res.status !== 200) {
      return { ok: false, detail: `CalDAV server responded HTTP ${res.status} to PROPFIND — is this a CalDAV collection?` }
    }
    const xml = await res.text().catch(() => '')
    const isCalendar = xml.includes('calendar')
    return {
      ok: true,
      detail: `CalDAV collection verified (${res.status}${isCalendar ? ', calendar collection' : ''}) at ${creds.url}`,
    }
  } catch (err) {
    return { ok: false, detail: `CalDAV test failed: ${sanitizeMessage(err instanceof Error ? err.message : String(err), integration)}` }
  }
}

/* ---------------- VEVENT generation ---------------- */

function icsEscape(v: string): string {
  return (v || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

function icsFold(line: string): string {
  // RFC 5545 §3.1 — lines ≤ 75 octets, continuation lines prefixed with a space
  if (line.length <= 73) return line
  const parts: string[] = []
  let rest = line
  while (rest.length > 73) {
    parts.push(rest.slice(0, 73))
    rest = ' ' + rest.slice(73)
  }
  parts.push(rest)
  return parts.join('\r\n')
}

function utcStamp(d: Date): string {
  return `${d.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`
}

function foldEvent(lines: string[]): string {
  return lines.map(icsFold).join('\r\n')
}

export function bookingToVEvent(input: {
  uid: string
  org: Pick<Organization, 'name' | 'timezone' | 'slug'>
  title: string
  startAt: Date
  endAt: Date
  description?: string
  location?: string
  status: string
}): string {
  const stamp = new Date()
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AI Secretary//CalDAV Sync//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${icsEscape(input.uid)}`,
    `DTSTAMP:${utcStamp(stamp)}`,
    `DTSTART:${utcStamp(input.startAt)}`,
    `DTEND:${utcStamp(input.endAt)}`,
    `SUMMARY:${icsEscape(input.title)}`,
    `STATUS:${input.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
    ...(input.description ? [`DESCRIPTION:${icsEscape(input.description)}`] : []),
    ...(input.location ? [`LOCATION:${icsEscape(input.location)}`] : []),
    `X-AIS-ORG:${icsEscape(input.org.slug)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return foldEvent(lines) + '\r\n'
}

/* ---------------- sync ---------------- */

export type SyncItemResult = { bookingId: string; uid: string; ok: boolean; detail: string }

/**
 * Push one booking to the CalDAV collection as {uid}.ics.
 * PUT is an idempotent upsert per RFC 5547/iCalendar semantics.
 */
export async function putBookingEvent(creds: CalDavCreds, uid: string, ics: string): Promise<{ ok: boolean; status: number; detail: string }> {
  try {
    const res = await davFetch(creds, `${encodeURIComponent(uid)}.ics`, 'PUT', ics, 'text/calendar; charset=utf-8')
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, detail: `stored (HTTP ${res.status})` }
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, detail: 'server rejected credentials for the PUT' }
    return { ok: false, status: res.status, detail: `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, status: 0, detail: sanitizeMessage(err instanceof Error ? err.message : String(err)) }
  }
}

export async function deleteRemoteEvent(creds: CalDavCreds, uid: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await davFetch(creds, `${encodeURIComponent(uid)}.ics`, 'DELETE')
    if ((res.status >= 200 && res.status < 300) || res.status === 404) return { ok: true, detail: `removed (HTTP ${res.status})` }
    return { ok: false, detail: `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, detail: sanitizeMessage(err instanceof Error ? err.message : String(err)) }
  }
}
