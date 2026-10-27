import { getSetting } from '@/lib/org'
import { normalizeReceptionistStatus, type ReceptionistStatus } from '@/lib/receptionist/status'
import {
  SCHEDULE_SETTING_KEY,
  isWithinSchedule,
  nextScheduleOpen,
  normalizeReceptionistSchedule,
  type ReceptionistSchedule,
} from '@/lib/receptionist/schedule'

export type ResolvedReceptionistStatus = {
  /** Effective state used by every inbound channel. */
  status: ReceptionistStatus
  /** Stored operator switch, ignoring the schedule. */
  baseStatus: ReceptionistStatus
  /** True when the schedule (not the operator) is keeping the assistant off. */
  scheduledOff: boolean
  schedule: ReceptionistSchedule
  nextOpenAt: Date | null
}

export async function readReceptionistSchedule(orgId: string): Promise<ReceptionistSchedule> {
  return normalizeReceptionistSchedule(await getSetting<unknown>(orgId, SCHEDULE_SETTING_KEY, null))
}

/**
 * Combine the operator switch with the weekly schedule. A stopped/paused switch
 * always wins; otherwise an enabled schedule outside its windows behaves like
 * `paused` (inbound is still recorded, the assistant does not reply).
 */
export async function resolveReceptionistStatus(
  org: { id: string; receptionistStatus: string; timezone?: string | null },
  now: Date = new Date()
): Promise<ResolvedReceptionistStatus> {
  const baseStatus = normalizeReceptionistStatus(org.receptionistStatus)
  const schedule = await readReceptionistSchedule(org.id)
  const scheduledOff =
    baseStatus === 'running' && schedule.enabled && !isWithinSchedule(schedule, now, org.timezone)

  return {
    status: scheduledOff ? 'paused' : baseStatus,
    baseStatus,
    scheduledOff,
    schedule,
    nextOpenAt: scheduledOff ? nextScheduleOpen(schedule, now, org.timezone) : null,
  }
}
