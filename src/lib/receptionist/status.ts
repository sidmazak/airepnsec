/**
 * Runtime lifecycle of the AI receptionist.
 *
 * - running  : the assistant answers inbound SMS/WhatsApp, phone calls and web chat.
 * - paused   : inbound is still received and stored for staff, but the assistant
 *              never replies and calls are answered with a short notice.
 * - stopped  : the app stops listening — inbound webhooks are acknowledged and
 *              audited, but no conversation, message or AI turn is created.
 *
 * The switch is organization-scoped and persisted, so it survives restarts and
 * applies to every channel at once.
 */

export const RECEPTIONIST_STATUSES = ['running', 'paused', 'stopped'] as const
export type ReceptionistStatus = (typeof RECEPTIONIST_STATUSES)[number]

export function normalizeReceptionistStatus(value: unknown): ReceptionistStatus {
  return (RECEPTIONIST_STATUSES as readonly string[]).includes(String(value))
    ? (value as ReceptionistStatus)
    : 'running'
}

/** True only when the assistant is allowed to talk to customers. */
export function isReceptionistRunning(status: unknown): boolean {
  return normalizeReceptionistStatus(status) === 'running'
}

export const RECEPTIONIST_STATUS_META: Record<ReceptionistStatus, { label: string; detail: string; tone: 'ok' | 'warn' | 'stop' }> = {
  running: {
    label: 'Running',
    detail: 'The assistant answers inbound SMS, WhatsApp, phone calls and web chat.',
    tone: 'ok',
  },
  paused: {
    label: 'Paused',
    detail: 'Inbound messages are recorded for staff, but the assistant does not reply. Calls get a short notice.',
    tone: 'warn',
  },
  stopped: {
    label: 'Stopped',
    detail: 'The app stops listening: inbound webhooks are acknowledged and audited, nothing is answered or stored.',
    tone: 'stop',
  },
}
