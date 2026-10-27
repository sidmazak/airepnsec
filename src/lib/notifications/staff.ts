import { db } from '@/lib/db'
import { getSetting } from '@/lib/org'
import {
  NOTIFICATION_SETTING_KEY, normalizeNotificationConfig,
  type NotificationConfig, type NotificationChannel, type StaffEvent,
} from '@/lib/notifications/policy'

export async function readNotificationConfig(orgId: string): Promise<NotificationConfig> {
  return normalizeNotificationConfig(await getSetting<unknown>(orgId, NOTIFICATION_SETTING_KEY, null))
}

/** Whether the org's notification routing allows a staff alert on this channel. */
export function staffChannelEnabled(
  config: NotificationConfig,
  event: StaffEvent,
  channel: NotificationChannel,
): boolean {
  const rule = config.staff[event]
  return rule.enabled && rule.channels.includes(channel)
}

/**
 * Create the actual staff alert rows the notification matrix promises:
 * an in-app row (already "sent" because it is visible in the dashboard) and an
 * email row (queued for the outbox dispatcher). Respects the staff matrix.
 */
export async function notifyStaffEvent(input: {
  orgId: string
  event: StaffEvent
  subject: string
  body: string
  relatedType: string
  relatedId?: string
  dedupeKey: string
}): Promise<{ inapp: boolean; email: boolean }> {
  const org = await db.organization.findUnique({ where: { id: input.orgId }, select: { email: true } })
  if (!org) return { inapp: false, email: false }
  const config = await readNotificationConfig(input.orgId)
  let inapp = false
  let email = false

  if (staffChannelEnabled(config, input.event, 'inapp')) {
    await db.outboxMessage
      .create({
        data: {
          orgId: input.orgId,
          channel: 'inapp',
          recipient: 'staff',
          subject: input.subject,
          body: input.body,
          status: 'sent',
          sentAt: new Date(),
          relatedType: input.relatedType,
          relatedId: input.relatedId,
          dedupeKey: `${input.dedupeKey}:inapp`,
        },
      })
      .then(() => { inapp = true })
      .catch((err: { code?: string }) => { if (err?.code !== 'P2002') throw err })
  }

  if (org.email.includes('@') && staffChannelEnabled(config, input.event, 'email')) {
    await db.outboxMessage
      .create({
        data: {
          orgId: input.orgId,
          channel: 'email',
          recipient: org.email,
          subject: input.subject,
          body: input.body,
          status: 'queued',
          relatedType: input.relatedType,
          relatedId: input.relatedId,
          dedupeKey: `${input.dedupeKey}:email`,
        },
      })
      .then(() => { email = true })
      .catch((err: { code?: string }) => { if (err?.code !== 'P2002') throw err })
  }

  return { inapp, email }
}

/** Alert staff that a conversation needs a human, exactly once per conversation. */
export async function notifyEscalation(orgId: string, conversationId: string, detail = ''): Promise<void> {
  await notifyStaffEvent({
    orgId,
    event: 'escalation',
    subject: 'Conversation needs a human',
    body: `A conversation was escalated to staff${detail ? `: ${detail}` : '.'} Open the inbox to reply.`,
    relatedType: 'staff_escalation',
    relatedId: conversationId,
    dedupeKey: `escalation:${conversationId}`,
  })
}
