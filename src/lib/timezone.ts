/**
 * Fixed-offset timezone helpers (documented simplification — see ARCHITECTURE.md).
 *
 * The org timezone is stored as "UTC", "UTC+05:30" or "UTC-05:00". Business
 * wall-clock times (working hours, holidays, what a customer hears on the
 * phone) are interpreted in that fixed offset, while all persisted instants
 * remain real UTC Date values.
 *
 * Everything the assistant says or parses must go through these helpers so
 * that a slot shown to a customer is exactly the instant that gets booked.
 */

export const NAIVE_LOCAL_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d{1,3})?$/
export const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

/** Parse "UTC", "UTC+02:00", "UTC-05:30" (and bare "GMT+..") into minutes east of UTC. */
export function parseOffsetMinutes(timezone: string | null | undefined): number {
  const m = /^(?:UTC|GMT)([+-])(\d{2}):?(\d{2})?$/.exec((timezone || 'UTC').trim())
  if (!m) return 0
  const sign = m[1] === '+' ? 1 : -1
  return sign * (parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0))
}

/** "+05:30" / "-05:00" / "Z". */
export function offsetLabel(offsetMinutes: number): string {
  if (offsetMinutes === 0) return 'Z'
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(offsetMinutes)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  return `${sign}${hh}:${mm}`
}

/** Convert a real UTC instant into the org's wall clock. */
export function wallClockIn(timezone: string, instant: Date): Date {
  return new Date(instant.getTime() + parseOffsetMinutes(timezone) * 60_000)
}

/** Real UTC instant for a wall-clock time on a given local calendar day. */
export function wallClockToUtc(dayStr: string, minutes: number, offsetMinutes: number): Date {
  return new Date(Date.parse(`${dayStr}T00:00:00Z`) + (minutes - offsetMinutes) * 60_000)
}

/** "YYYY-MM-DD" of the org-local calendar day containing `instant`. */
export function localDateString(instant: Date, timezone: string): string {
  return wallClockIn(timezone, instant).toISOString().slice(0, 10)
}

/** "HH:MM" of the org-local wall clock for `instant`. */
export function localTimeString(instant: Date, timezone: string): string {
  return wallClockIn(timezone, instant).toISOString().slice(11, 16)
}

/** ISO-8601 instant for `instant` with the org's fixed offset (e.g. 2026-10-20T09:00:00+05:30). */
export function toZonedISOString(instant: Date, timezone: string): string {
  const shifted = wallClockIn(timezone, instant).toISOString().slice(0, 19)
  return `${shifted}${offsetLabel(parseOffsetMinutes(timezone))}`
}

/** "YYYY-MM-DD HH:MM (UTC+05:30)" — what a customer hears/reads. */
export function formatZonedDateTime(instant: Date, timezone: string): string {
  const wall = wallClockIn(timezone, instant)
  return `${wall.toISOString().slice(0, 10)} ${wall.toISOString().slice(11, 16)} (${timezone})`
}

/** Real UTC [start, end) bounds of a local calendar day "YYYY-MM-DD". */
export function localDayBounds(dateStr: string, timezone: string): { start: Date; end: Date } {
  const off = parseOffsetMinutes(timezone)
  const start = wallClockToUtc(dateStr, 0, off)
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) }
}

/** All calendar days (local "YYYY-MM-DD") touched by an inclusive range. */
export function localDaysBetween(from: Date, to: Date, timezone: string): string[] {
  const out: string[] = []
  const off = parseOffsetMinutes(timezone)
  // shift into wall-clock space, then walk UTC days
  let cursor = new Date(from.getTime() + off * 60_000)
  cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate()))
  const end = to.getTime() + off * 60_000
  while (cursor.getTime() <= end && out.length < 400) {
    out.push(cursor.toISOString().slice(0, 10))
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
  }
  return out
}

/**
 * Parse a datetime coming from an LLM (or a customer) into a real UTC instant.
 *
 * - Explicit zone info (Z / ±hh:mm) is trusted as-is.
 * - A naive "YYYY-MM-DD HH:mm" (what a local model usually emits) is interpreted
 *   as the ORG's wall clock — never the server's local timezone.
 * - A lone "YYYY-MM-DD" resolves to 00:00 org-local.
 */
export function parseOrgDateTime(input: string, timezone: string): Date | null {
  const raw = (input || '').trim()
  if (!raw) return null
  const off = parseOffsetMinutes(timezone)

  if (DATE_ONLY_RE.test(raw)) {
    return wallClockToUtc(raw, 0, off)
  }
  if (NAIVE_LOCAL_RE.test(raw)) {
    const normalized = raw.replace(' ', 'T')
    const withSeconds = normalized.length === 16 ? `${normalized}:00` : normalized
    const utcMs = Date.parse(`${withSeconds}Z`)
    if (Number.isNaN(utcMs)) return null
    return new Date(utcMs - off * 60_000)
  }
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** True when an input already carries explicit zone information. */
export function hasExplicitZone(input: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test((input || '').trim())
}
