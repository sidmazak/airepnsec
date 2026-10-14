/**
 * RFC 5545 (iCalendar) generator — plain string building, no dependencies.
 * Proper CRLF line endings, 75-octet folding, text escaping, VALARM reminders.
 */

export type IcsEvent = {
  uid: string
  start: Date
  end: Date
  summary: string
  description?: string
  location?: string
  status?: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED'
  organizer?: { name?: string; email: string }
}

const CRLF = '\r\n'

/** RFC 5545 text escaping: backslash, semicolon, comma, literal newlines. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/** UTC timestamp: YYYYMMDDTHHMMSSZ */
function icsUtc(date: Date): string {
  return (
    `${String(date.getUTCFullYear()).padStart(4, '0')}` +
    `${String(date.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(date.getUTCDate()).padStart(2, '0')}` +
    'T' +
    `${String(date.getUTCHours()).padStart(2, '0')}` +
    `${String(date.getUTCMinutes()).padStart(2, '0')}` +
    `${String(date.getUTCSeconds()).padStart(2, '0')}` +
    'Z'
  )
}

/**
 * Fold a content line at 75 octets (UTF-8 bytes): the first line at most 75
 * octets, continuation lines start with a single space and carry at most 74
 * octets. Folding never splits a multi-byte UTF-8 character.
 */
function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) return line

  const parts: string[] = []
  let first = true
  let offset = 0
  while (offset < bytes.length) {
    const limit = first ? 75 : 74
    let end = Math.min(offset + limit, bytes.length)
    // Step back over continuation bytes of a multi-byte UTF-8 sequence.
    while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
    parts.push((first ? '' : ' ') + bytes.subarray(offset, end).toString('utf8'))
    first = false
    offset = end
  }
  return parts.join(CRLF)
}

function contentLine(name: string, value: string, params = ''): string {
  return foldLine(params ? `${name};${params}:${value}` : `${name}:${value}`)
}

function eventLines(event: IcsEvent): string[] {
  const lines = [
    'BEGIN:VEVENT',
    contentLine('UID', escapeText(event.uid)),
    contentLine('DTSTAMP', icsUtc(new Date())),
    contentLine('DTSTART', icsUtc(event.start)),
    contentLine('DTEND', icsUtc(event.end)),
    contentLine('SUMMARY', escapeText(event.summary)),
  ]
  if (event.description) lines.push(contentLine('DESCRIPTION', escapeText(event.description)))
  if (event.location) lines.push(contentLine('LOCATION', escapeText(event.location)))
  lines.push(contentLine('STATUS', event.status ?? 'CONFIRMED'))
  if (event.organizer?.email) {
    const cn = event.organizer.name ? `CN="${event.organizer.name.replace(/"/g, '')}"` : ''
    lines.push(contentLine('ORGANIZER', escapeText(`mailto:${event.organizer.email}`), cn))
  }
  // 1 hour before — reminders fire in the subscriber's calendar client.
  lines.push('BEGIN:VALARM')
  lines.push('ACTION:DISPLAY')
  lines.push(contentLine('DESCRIPTION', escapeText(event.summary)))
  lines.push('TRIGGER:-PT60M')
  lines.push('END:VALARM')
  lines.push('END:VEVENT')
  return lines
}

/** Build a complete VCALENDAR document for the given events. */
export function buildIcs(events: IcsEvent[]): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AI Secretary//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ]
  for (const event of events) lines.push(...eventLines(event))
  lines.push('END:VCALENDAR')
  return lines.join(CRLF) + CRLF
}
