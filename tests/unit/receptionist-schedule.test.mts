import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_RECEPTIONIST_SCHEDULE,
  isWithinSchedule,
  nextScheduleOpen,
  normalizeReceptionistSchedule,
  parseReceptionistSchedule,
  timezoneOffsetMinutes,
  type ReceptionistSchedule,
} from '../../src/lib/receptionist/schedule.ts'

const weekday: ReceptionistSchedule = {
  enabled: true,
  days: {
    '0': null,
    '1': { start: '09:00', end: '17:00' },
    '2': { start: '09:00', end: '17:00' },
    '3': { start: '09:00', end: '17:00' },
    '4': { start: '09:00', end: '17:00' },
    '5': { start: '09:00', end: '17:00' },
    '6': null,
  },
}

// 2026-10-26 is a Monday.
const mondayAt = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 26, h, m, 0, 0))

test('disabled schedule always allows traffic', () => {
  const schedule = { ...DEFAULT_RECEPTIONIST_SCHEDULE, enabled: false }
  assert.equal(isWithinSchedule(schedule, mondayAt(3)), true)
})

test('weekday window includes start, excludes end', () => {
  assert.equal(isWithinSchedule(weekday, mondayAt(8, 59)), false)
  assert.equal(isWithinSchedule(weekday, mondayAt(9, 0)), true)
  assert.equal(isWithinSchedule(weekday, mondayAt(12, 30)), true)
  assert.equal(isWithinSchedule(weekday, mondayAt(17, 0)), false)
})

test('weekend stays closed', () => {
  const saturday = new Date(Date.UTC(2026, 9, 31, 12, 0, 0))
  assert.equal(isWithinSchedule(weekday, saturday), false)
})

test('overnight window spills into the next day', () => {
  const overnight: ReceptionistSchedule = {
    enabled: true,
    days: { ...weekday.days, '1': { start: '22:00', end: '06:00' } },
  }
  assert.equal(isWithinSchedule(overnight, mondayAt(23, 0)), true)
  const tuesday = new Date(Date.UTC(2026, 9, 27, 2, 0, 0))
  assert.equal(isWithinSchedule(overnight, tuesday), true)
  const tuesdayMorning = new Date(Date.UTC(2026, 9, 27, 7, 0, 0))
  assert.equal(isWithinSchedule(overnight, tuesdayMorning), false)
})

test('fixed-offset timezone shifts the evaluation', () => {
  // UTC 03:30 = 09:00 in UTC+05:30; UTC 11:30 = 17:00.
  assert.equal(isWithinSchedule(weekday, mondayAt(3, 29), 'UTC+05:30'), false)
  assert.equal(isWithinSchedule(weekday, mondayAt(3, 30), 'UTC+05:30'), true)
  assert.equal(isWithinSchedule(weekday, mondayAt(11, 29), 'UTC+05:30'), true)
  assert.equal(isWithinSchedule(weekday, mondayAt(11, 30), 'UTC+05:30'), false)
})

test('timezoneOffsetMinutes parses fixed offsets safely', () => {
  assert.equal(timezoneOffsetMinutes('UTC+05:30'), 330)
  assert.equal(timezoneOffsetMinutes('UTC-08:00'), -480)
  assert.equal(timezoneOffsetMinutes('+02:00'), 120)
  assert.equal(timezoneOffsetMinutes('UTC'), 0)
  assert.equal(timezoneOffsetMinutes('Europe/London'), 0)
  assert.equal(timezoneOffsetMinutes('UTC+15:00'), 0)
})

test('normalize fills safe defaults and drops zero-length windows', () => {
  const raw = normalizeReceptionistSchedule({
    enabled: true,
    days: { '1': { start: '08:00', end: '08:00' }, '2': { start: '25:00', end: '18:00' } },
    timezone: ' UTC+02:00 ',
  })
  assert.equal(raw.enabled, true)
  assert.equal(raw.timezone, 'UTC+02:00')
  assert.equal(raw.days['1'], null)
  assert.deepEqual(raw.days['2'], { start: '09:00', end: '18:00' })
  assert.deepEqual(raw.days['0'], null)
})

test('parse tolerates missing or malformed JSON', () => {
  assert.equal(parseReceptionistSchedule(null).enabled, false)
  assert.equal(parseReceptionistSchedule('{nope').enabled, false)
  assert.equal(parseReceptionistSchedule(JSON.stringify(weekday)).enabled, true)
})

test('nextScheduleOpen skips the weekend', () => {
  const saturday = new Date(Date.UTC(2026, 9, 31, 12, 0, 0))
  const next = nextScheduleOpen(weekday, saturday)
  assert.ok(next)
  assert.equal(next.toISOString(), '2026-11-02T09:00:00.000Z')
})

test('nextScheduleOpen returns null when disabled and the next window when closed', () => {
  assert.equal(nextScheduleOpen({ ...weekday, enabled: false }, mondayAt(12)), null)
  assert.equal(nextScheduleOpen(weekday, mondayAt(7))?.toISOString(), '2026-10-26T09:00:00.000Z')
})
