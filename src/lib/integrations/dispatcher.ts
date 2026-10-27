import { db } from '@/lib/db'
import { decryptSecrets, getEnabledIntegration, integrationConfig, sanitizeMessage, sendEmail, sendEmailViaApi, sendTwilio, signWebhookPayload, str } from '@/lib/integrations/connectors'
import { normalizePhone, sendSmsGateway } from '@/lib/integrations/sms'
import { getSetting } from '@/lib/org'
import {
  NOTIFICATION_SETTING_KEY, decideDelivery, eventForAutomation, eventForOutbox, normalizeCustomerPrefs, normalizeNotificationConfig,
} from '@/lib/notifications/policy'
import type { OutboxMessage } from '@prisma/client'
import { assertOutboundUrl } from '@/lib/security/outbound'

/**
 * Outbox dispatcher — turns queued OutboxMessages into REAL deliveries through
 * the org's configured integrations. Honest delivery states only:
 * - no channel integration configured → stays "queued" with an explicit reason
 *   and a 10-minute recheck (so it picks up configuration later without
 *   starving the queue);
 * - transient send error → attempts++, exponential backoff (2^n minutes, capped
 *   at 60); after 5 attempts the message is marked "failed" with the last error.
 */

export type DispatchStats = { processed: number; sent: number; failed: number; waiting: number; skipped: number }

const BATCH = 15
const MAX_ATTEMPTS = 5

let inFlight = false

/** Serialize the worker interval + manual triggers — a message must never be sent twice concurrently. */
function lockOk(): boolean {
  if (inFlight) return false
  inFlight = true
  return true
}

/**
 * @param orgId optional org filter used by the manual "flush now" button so an
 * admin only dispatches their own queue. The background worker omits it and
 * serves every org.
 */
export async function dispatchOutbox(orgId?: string): Promise<DispatchStats> {
  const stats: DispatchStats = { processed: 0, sent: 0, failed: 0, waiting: 0, skipped: 0 }
  if (!lockOk()) return stats

  try {
    const due = await db.outboxMessage.findMany({
      where: { status: 'queued', scheduledFor: { lte: new Date() }, ...(orgId ? { orgId } : {}) },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
    })

    for (const message of due) {
      stats.processed++
      try {
        const outcome = await deliver(message)
        if (outcome === 'sent') stats.sent++
        else if (outcome === 'failed') stats.failed++
        else if (outcome === 'skipped') stats.skipped++
        else stats.waiting++
      } catch (err) {
        // deliver() handles its own errors; this is a safety net.
        await markFailed(message, sanitizeMessage(err instanceof Error ? err.message : String(err)))
        stats.failed++
      }
    }
  } finally {
    inFlight = false
  }

  return stats
}

/**
 * Reset the 10-minute recheck backoff for queued messages affected by a
 * newly enabled/tested integration, so enabling a channel delivers pending
 * messages on the very next dispatch tick (instead of waiting out the backoff).
 */
export async function nudgeChannel(orgId: string, kind: string): Promise<void> {
  const channelByKind: Record<string, string[]> = {
    smtp: ['email'],
    email_api: ['email'],
    twilio_sms: ['sms'],
    sms_gateway: ['sms'],
    twilio_whatsapp: ['whatsapp'],
    meta_whatsapp: ['whatsapp'],
    webhook_out: ['webhook'],
  }
  const channels = channelByKind[kind]
  if (!channels) return
  await db.outboxMessage.updateMany({
    where: { orgId, status: 'queued', channel: { in: channels } },
    data: { scheduledFor: new Date(), statusReason: '' },
  })
}

type Outcome = 'sent' | 'failed' | 'waiting' | 'skipped'

async function deliver(message: OutboxMessage): Promise<Outcome> {
  const gated = await applyNotificationPolicy(message)
  if (gated !== 'allowed') return gated

  switch (message.channel) {
    case 'inapp':
      await markSent(message)
      return 'sent'
    case 'email':
      return deliverEmail(message)
    case 'sms':
      return deliverSms(message)
    case 'whatsapp':
      return deliverWhatsApp(message)
    case 'webhook':
      return deliverWebhook(message)
    default:
      await markFailed(message, `unknown channel "${message.channel}" — cannot dispatch`)
      return 'failed'
  }
}

/* ---------------- notification policy ---------------- */

async function customerForMessage(message: OutboxMessage) {
  if (message.channel === 'email') {
    const email = message.recipient.trim().toLowerCase()
    if (!email) return null
    return db.customer.findFirst({
      where: { orgId: message.orgId, email },
      select: { optOut: true, consentContact: true, commPrefs: true },
    })
  }

  if (message.channel === 'sms' || message.channel === 'whatsapp') {
    const target = normalizePhone(message.recipient)
    if (!target) return null
    const exact = await db.customer.findFirst({
      where: { orgId: message.orgId, phone: message.recipient.trim() },
      select: { optOut: true, consentContact: true, commPrefs: true },
    })
    if (exact) return exact

    const candidates = await db.customer.findMany({
      where: { orgId: message.orgId, NOT: { phone: '' } },
      select: { phone: true, optOut: true, consentContact: true, commPrefs: true },
      orderBy: { updatedAt: 'desc' },
      take: 300,
    })
    return candidates.find((row) => normalizePhone(row.phone) === target) ?? null
  }

  return null
}

async function applyNotificationPolicy(message: OutboxMessage): Promise<'allowed' | 'waiting' | 'skipped'> {
  if (message.channel === 'webhook' || message.channel === 'inapp') return 'allowed'

  const stored = await getSetting<unknown>(message.orgId, NOTIFICATION_SETTING_KEY, null)
  const config = normalizeNotificationConfig(stored)
  let event = eventForOutbox(message)
  if (message.relatedType === 'automation' && message.relatedId) {
    const automation = await db.automation.findFirst({
      where: { id: message.relatedId, orgId: message.orgId },
      select: { triggerType: true },
    })
    if (automation) event = { audience: 'customer', event: eventForAutomation(automation.triggerType) }
  }
  const customer = event.audience === 'customer' ? await customerForMessage(message) : null

  const decision = decideDelivery({
    config,
    event,
    channel: message.channel,
    customer: customer
      ? { optOut: customer.optOut, consentContact: customer.consentContact, prefs: normalizeCustomerPrefs(customer.commPrefs) }
      : null,
  })

  if (!decision.allowed) {
    await db.outboxMessage.update({
      where: { id: message.id },
      data: { status: 'skipped', statusReason: decision.reason },
    })
    return 'skipped'
  }

  if ('deferUntil' in decision && decision.deferUntil) {
    await db.outboxMessage.update({
      where: { id: message.id },
      data: {
        status: 'queued',
        statusReason: `quiet hours — scheduled for ${decision.deferUntil.toISOString()}`,
        scheduledFor: decision.deferUntil,
      },
    })
    return 'waiting'
  }

  return 'allowed'
}

/* ---------------- channel adapters ---------------- */

async function deliverEmail(message: OutboxMessage): Promise<Outcome> {
  // A native provider API (SendGrid/Mailgun/Postmark/Resend/Brevo) takes
  // precedence; SMTP remains the fallback when only SMTP is configured.
  const api = await getEnabledIntegration(message.orgId, 'email_api')
  const smtp = api ? null : await getEnabledIntegration(message.orgId, 'smtp')
  const integration = api ?? smtp
  if (!integration) return await waitForIntegration(message, 'email')

  try {
    const input = {
      to: message.recipient,
      subject: message.subject || '(no subject)',
      text: message.body,
      ...(message.html ? { html: message.html } : {}),
    }
    if (api) await sendEmailViaApi(api, input)
    else await sendEmail(integration, input)
    await markSent(message)
    return 'sent'
  } catch (err) {
    return await markFailed(message, sanitizeMessage(err instanceof Error ? err.message : String(err), integration))
  }
}

/**
 * SMS delivery: an enabled Twilio SMS integration takes precedence; otherwise
 * the org's enabled BYO SMS gateway (TextBee / httpSMS / android-sms-gateway /
 * any HTTP bridge). No SMS channel configured → honest "waiting" (never faked).
 */
async function deliverSms(message: OutboxMessage): Promise<Outcome> {
  const twilio = await getEnabledIntegration(message.orgId, 'twilio_sms')
  if (twilio) {
    try {
      await sendTwilio(twilio, { to: message.recipient, body: message.body })
      await markSent(message)
      return 'sent'
    } catch (err) {
      return await markFailed(message, sanitizeMessage(err instanceof Error ? err.message : String(err), twilio))
    }
  }

  const gateways = await db.integration.findMany({ where: { orgId: message.orgId, kind: 'sms_gateway', enabled: true }, orderBy: { createdAt: 'asc' } })
  const gateway = gateways[0]
  if (!gateway) return await waitForIntegration(message, 'sms')

  const config = integrationConfig(gateway)
  try {
    await sendSmsGateway(str(config, 'provider'), config, decryptSecrets(gateway), { to: message.recipient, body: message.body })
    await markSent(message)
    return 'sent'
  } catch (err) {
    return await markFailed(message, sanitizeMessage(err instanceof Error ? err.message : String(err), gateway))
  }
}

async function deliverWhatsApp(message: OutboxMessage): Promise<Outcome> {
  const twilio = await getEnabledIntegration(message.orgId, 'twilio_whatsapp')
  if (twilio) {
    try {
      await sendTwilio(twilio, { to: message.recipient, body: message.body })
      await markSent(message)
      return 'sent'
    } catch (err) {
      return await markFailed(message, sanitizeMessage(err instanceof Error ? err.message : String(err), twilio))
    }
  }
  const meta = await getEnabledIntegration(message.orgId, 'meta_whatsapp')
  if (meta) {
    try {
      const { sendMetaWhatsApp } = await import('@/lib/integrations/connectors')
      await sendMetaWhatsApp(meta, { to: message.recipient, body: message.body })
      await markSent(message)
      return 'sent'
    } catch (err) {
      return await markFailed(message, sanitizeMessage(err instanceof Error ? err.message : String(err), meta))
    }
  }
  return await waitForIntegration(message, 'whatsapp')
}

async function deliverTwilio(message: OutboxMessage, kind: 'twilio_sms' | 'twilio_whatsapp'): Promise<Outcome> {
  const integration = await getEnabledIntegration(message.orgId, kind)
  if (!integration) return await waitForIntegration(message, message.channel)

  try {
    await sendTwilio(integration, { to: message.recipient, body: message.body })
    await markSent(message)
    return 'sent'
  } catch (err) {
    return await markFailed(message, sanitizeMessage(err instanceof Error ? err.message : String(err), integration))
  }
}

/**
 * Outbound webhook: recipient IS the destination URL. subject carries the event
 * name (x-ais-event) and body carries the raw JSON payload. Signed with the
 * integration's `secret` when configured; unsigned deliveries carry
 * `x-signature: none` so receivers can distinguish them.
 */
async function deliverWebhook(message: OutboxMessage): Promise<Outcome> {
  const candidates = await db.integration.findMany({ where: { orgId: message.orgId, kind: 'webhook_out' } })
  const target = candidates.find((row) => {
    const url = str(integrationConfig(row), 'url')
    return url && url === message.recipient
  })
  if (!target) return await waitForIntegration(message, 'webhook')

  const secrets = decryptSecrets(target)
  const secret = (secrets.secret ?? '').trim()
  const config = integrationConfig(target)

  let destination: URL
  try {
    destination = await assertOutboundUrl(message.recipient, { allowPrivate: config.allowPrivate === true, label: 'Webhook URL' })
  } catch (err) {
    return await markFailed(message, sanitizeMessage(err instanceof Error ? err.message : String(err), target))
  }

  try {
    const res = await fetch(destination, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': signWebhookPayload(message.body, secret),
        'x-ais-event': message.subject || 'outbox.message',
      },
      body: message.body,
      signal: AbortSignal.timeout(8_000),
    })
    if (res.status >= 200 && res.status < 300) {
      await markSent(message)
      return 'sent'
    }
    return await markFailed(message, sanitizeMessage(`destination responded HTTP ${res.status} ${res.statusText}`, target))
  } catch (err) {
    return await markFailed(message, sanitizeMessage(err instanceof Error ? err.message : String(err), target))
  }
}

/* ---------------- state transitions ---------------- */

/** No integration configured yet — stay queued with an honest reason, recheck in 10 min. */
async function waitForIntegration(message: OutboxMessage, channel: string): Promise<'waiting'> {
  await db.outboxMessage.update({
    where: { id: message.id },
    data: {
      status: 'queued',
      statusReason: `waiting for ${channel} integration (configure in Integrations)`,
      scheduledFor: new Date(Date.now() + 10 * 60_000),
    },
  })
  return 'waiting'
}

async function markSent(message: OutboxMessage): Promise<void> {
  await db.outboxMessage.update({
    where: { id: message.id },
    data: { status: 'sent', sentAt: new Date(), statusReason: '' },
  })
}

/**
 * A real send error: backoff 2^attempts minutes (capped at 60); after 5 attempts
 * mark failed with the last error.
 */
async function markFailed(message: OutboxMessage, sanitizedError: string): Promise<'failed'> {
  const attempts = message.attempts + 1
  if (attempts >= MAX_ATTEMPTS) {
    await db.outboxMessage.update({
      where: { id: message.id },
      data: { attempts, status: 'failed', statusReason: sanitizedError },
    })
    if (message.relatedType !== 'integration_failure') {
      const { notifyStaffEvent } = await import('@/lib/notifications/staff')
      await notifyStaffEvent({
        orgId: message.orgId,
        event: 'integration_failure',
        subject: `Delivery failed: ${message.channel}`,
        body: `A queued ${message.channel} message could not be delivered after ${attempts} attempts.

${sanitizedError}

Check the integration settings and the outbox.`,
        relatedType: 'integration_failure',
        relatedId: message.id,
        dedupeKey: `outbox-failed:${message.id}`,
      })
    }
  } else {
    const backoffMin = Math.min(60, 2 ** attempts)
    await db.outboxMessage.update({
      where: { id: message.id },
      data: {
        attempts,
        status: 'queued',
        statusReason: `attempt ${attempts} failed: ${sanitizedError}; retrying`,
        scheduledFor: new Date(Date.now() + backoffMin * 60_000),
      },
    })
  }
  return 'failed'
}
