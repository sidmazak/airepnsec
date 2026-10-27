/**
 * Pure helpers for the receptionist's weekly schedule.
 *
 * The schedule is stored as an org AppSetting (`receptionist_schedule`) so it
 * needs no schema migration. Times are local to the organization's fixed-offset
 * timezone (e.g. `UTC+05:30`), matching the rest of the app.
 */

export const SCHEDULE_SETTING_KEY = 'receptionist_schedule'

export type DayWindow = { start: string; end: string }

export type ReceptionistSchedule = {
  enabled: boolean
  /** Keys are JS day numbers: 0 = Sunday … 6 = Saturday. Missing/null = closed. */
  days: Record<string, DayWindow | null>
  /** Optional override; otherwise the organization timezone is used. */
  timezone?: string
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

export const DEFAULT_DAY_WINDOWS: Record<string, DayWindow | null> = {
  '0': null,
  '1': { start: '09:00', end: '17:00' },
  '2': { start: '09:00', end: '17:00' },
  '3': { start: '09:00', end: '17:00' },
  '4': { start: '09:00', end: '17:00' },
  '5': { start: '09:00', end: '17:00' },
  '6': null,
}

export const DEFAULT_RECEPTIONIST_SCHEDULE: ReceptionistSchedule = {
  enabled: false,
  days: DEFAULT_DAY_WINDOWS,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cleanTime(value: unknown, fallback: string): string {
  return typeof value === 'string' && HHMM.test(value.trim()) ? value.trim() : fallback
}

/** Parse/normalize stored or user-supplied schedule JSON onto safe defaults. */
export function normalizeReceptionistSchedule(raw: unknown): ReceptionistSchedule {
  const value = isRecord(raw) ? raw : {}
  const daysRaw = isRecord(value.days) ? value.days : {}
  const days: Record<string, DayWindow | null> = {}

  for (const key of Object.keys(DEFAULT_DAY_WINDOWS)) {
    const fallback = DEFAULT_DAY_WINDOWS[key]
    const entry = daysRaw[key]
    if (entry === null || entry === undefined) {
      days[key] = fallback ? { ...fallback } : null
      continue
    }
    if (!isRecord(entry)) {
      days[key] = fallback ? { ...fallback } : null
      continue
    }
    const start = cleanTime(entry.start, fallback?.start ?? '09:00')
    const end = cleanTime(entry.end, fallback?.end ?? '17:00')
    days[key] = start === end ? null : { start, end }
  }

  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_RECEPTIONIST_SCHEDULE.enabled,
    days,
    ...(typeof value.timezone === 'string' && value.timezone.trim() ? { timezone: value.timezone.trim() } : {}),
  }
}

export function parseReceptionistSchedule(raw: string | null | undefined): ReceptionistSchedule {
  if (!raw) return normalizeReceptionistSchedule(null)
  try {
    return normalizeReceptionistSchedule(JSON.parse(raw))
  } catch {
    return normalizeReceptionistSchedule(null)
  }
}

/** Parse a fixed-offset timezone (`UTC+05:30`, `UTC-08:00`, `+05:30`) to minutes. */
export function timezoneOffsetMinutes(timezone: string | undefined | null): number {
  if (!timezone) return 0
  const match = /^(?:UTC)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(timezone.trim())
  if (!match) return 0
  const sign = match[1] === '-' ? -1 : 1
  const hours = Number(match[2])
  const minutes = Number(match[3] ?? '0')
  if (hours > 14 || minutes > 59) return 0
  return sign * (hours * 60 + minutes)
}

function minutesOfDay(value: string): number {
  const [h, m] = value.split(':').map(Number)
  return h * 60 + m
}

/**
 * Is `now` inside an enabled weekly window? A disabled schedule always passes.
 * Overnight windows (`22:00–06:00`) are supported.
 */
export function isWithinSchedule(
  schedule: ReceptionistSchedule,
  now: Date,
  timezone?: string | null
): boolean {
  if (!schedule.enabled) return true
  const offset = timezoneOffsetMinutes(schedule.timezone ?? timezone)
  const local = new Date(now.getTime() + offset * 60_000)
  const day = local.getUTCDay()
  const current = local.getUTCHours() * 60 + local.getUTCMinutes()

  const today = schedule.days[String(day)] ?? null
  if (today) {
    const start = minutesOfDay(today.start)
    const end = minutesOfDay(today.end)
    if (start <= end) {
      if (current >= start && current < end) return true
    } else if (current >= start || current < end) {
      return true
    }
  }

  // An overnight window from the previous day may still be open.
  const previous = schedule.days[String((day + 6) % 7)] ?? null
  if (previous) {
    const start = minutesOfDay(previous.start)
    const end = minutesOfDay(previous.end)
    if (start > end && current < end) return true
  }
  return false
}

export function nextScheduleOpen(schedule: ReceptionistSchedule, now: Date, timezone?: string | null): Date | null {
  if (!schedule.enabled) return null
  const offset = timezoneOffsetMinutes(schedule.timezone ?? timezone)
  const local = new Date(now.getTime() + offset * 60_000)
  for (let addDays = 0; addDays <= 7; addDays++) {
    const window = schedule.days[String((local.getUTCDay() + addDays) % 7)] ?? null
    if (!window) continue
    const [h, m] = window.start.split(':').map(Number)
    const candidate = new Date(local)
    candidate.setUTCDate(candidate.getUTCDate() + addDays)
    candidate.setUTCHours(h, m, 0, 0)
    if (candidate > local) return new Date(candidate.getTime() - offset * 60_000)
  }
  return null
}
