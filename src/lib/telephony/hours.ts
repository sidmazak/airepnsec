import { parseOffsetMinutes } from '@/lib/timezone'

/**
 * Pure opening-hours helpers for the phone receptionist. The org timezone is a
 * fixed UTC offset (documented simplification), so "is the business open right
 * now?" is computed without a timezone database.
 */

export type OpeningHours = Record<string, Array<[string, string]>>

export function parseHhMm(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 24 || minute < 0 || minute > 59) return null
  return hour * 60 + minute
}

export function parseOpeningHours(raw: string | null | undefined): OpeningHours {
  try {
    const parsed: unknown = JSON.parse(raw || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: OpeningHours = {}
    for (const [dow, windows] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(windows)) continue
      out[dow] = windows
        .map((window) => (Array.isArray(window) && window.length >= 2 ? [String(window[0]), String(window[1])] : null))
        .filter((window): window is [string, string] => window !== null)
    }
    return out
  } catch {
    return {}
  }
}

export function parseHolidays(raw: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed.filter((day): day is string => typeof day === 'string') : []
  } catch {
    return []
  }
}

export type OpenState = {
  open: boolean
  reason: 'open' | 'outside_hours' | 'holiday' | 'no_hours'
  localDay: string
  localTime: string
}

/**
 * Decide whether the org is open at `now`. When no hours are configured for the
 * day the business is treated as closed (safer: an unattended line takes a
 * message instead of pretending the AI is a receptionist all night).
 */
export function orgOpenState(input: {
  openingHours: string | null | undefined
  holidays?: string | null
  timezone: string
  now?: Date
}): OpenState {
  const now = input.now ?? new Date()
  const offset = parseOffsetMinutes(input.timezone || 'UTC')
  const local = new Date(now.getTime() + offset * 60_000)
  const localDay = local.toISOString().slice(0, 10)
  const dow = String(local.getUTCDay())
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes()
  const localTime = `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`

  if (parseHolidays(input.holidays).includes(localDay)) {
    return { open: false, reason: 'holiday', localDay, localTime }
  }

  const hours = parseOpeningHours(input.openingHours)
  const windows = hours[dow] ?? []
  if (windows.length === 0) return { open: false, reason: 'no_hours', localDay, localTime }

  for (const [startRaw, endRaw] of windows) {
    const start = parseHhMm(startRaw)
    const end = parseHhMm(endRaw)
    if (start === null || end === null || end <= start) continue
    if (minutes >= start && minutes < end) return { open: true, reason: 'open', localDay, localTime }
  }
  return { open: false, reason: 'outside_hours', localDay, localTime }
}
