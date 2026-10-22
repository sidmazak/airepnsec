import { NextRequest, after } from 'next/server'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { withPublic } from '@/lib/api'
import { handleReceptionistTurn } from '@/lib/ai/receptionist'
import { emitEvent } from '@/lib/automation/engine'
import { getEnabledIntegration, sendTwilio, sanitizeMessage } from '@/lib/integrations/connectors'
import { normalizeReceptionistStatus } from '@/lib/receptionist/status'
import {
  resolveTelephonyRoute, verifyTwilioSignature, candidateWebhookUrls, formParams,
  matchCustomerByPhone, logWebhook, plainResponse, twiml,
} from '@/lib/telephony/twiml'

export const pathname = '/api/telephony/whatsapp/incoming'

function waThreadKey(from: string): string {
  return `whatsapp:${from.replace(/\D/g, '')}`
}

/** Strip emoji/control chars from the WhatsApp profile name so it is safe as a contact label. */
function cleanProfileName(raw: string): string {
  return raw
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[\u0000-\u001F]/g, '')
    .trim()
    .slice(0, 80)
}

/**
 * POST /api/telephony/whatsapp/incoming — Twilio inbound WhatsApp webhook (signature-verified).
 * Threads one conversation per sender number (channel `whatsapp`), persists the inbound
 * message immediately, then answers with the real AI receptionist after the Twilio
 * response is flushed. Replies go out through the Twilio WhatsApp sender (REST); on
 * failure they queue in the outbox (`whatsapp` channel) for retry with backoff.
 * Opted-out customers never receive outbound messages.
 */
export const POST = withPublic(async (req: NextRequest) => {
  const params = await formParams(req)
  const messageSid = params.MessageSid ?? ''
  const from = params.From ?? ''
  const to = params.To ?? ''
  const body = (params.Body ?? '').slice(0, 4000)
  const profileName = cleanProfileName(params.ProfileName ?? '')

  const route = await resolveTelephonyRoute(['twilio_whatsapp'], to)
  if (!route) return plainResponse(404, 'No enabled Twilio WhatsApp integration owns this number')

  const config = (() => { try { return JSON.parse(route.integration.configJson || '{}') as Record<string, unknown> } catch { return {} } })()
  const signature = req.headers.get('x-twilio-signature')
  const candidates = candidateWebhookUrls(req, config, pathname)
  const signatureValid = candidates.some((u) => verifyTwilioSignature(route.secrets.authToken ?? '', u, params, signature))
  if (!signatureValid) {
    await logWebhook({ orgId: route.orgId, provider: 'twilio_whatsapp', eventId: messageSid, payload: params, signatureValid: false, result: 'rejected' })
    return plainResponse(403, 'Invalid Twilio signature')
  }

  const { duplicate } = await logWebhook({ orgId: route.orgId, provider: 'twilio_whatsapp', eventId: messageSid, payload: params, signatureValid: true, result: 'received' })
  if (duplicate) return twiml('')

  const org = await db.organization.findUnique({ where: { id: route.orgId } })
  if (!org || !body.trim()) return twiml('')

  // "stopped" means the app does not listen: acknowledge the webhook, audit a
  // short preview of what arrived, and open no conversation at all.
  const receptionistStatus = normalizeReceptionistStatus(org.receptionistStatus)
  if (receptionistStatus === 'stopped') {
    await audit({
      orgId: org.id, actorType: 'webhook', actorId: 'twilio_whatsapp',
      action: 'telephony.whatsapp_ignored', entity: 'organization', entityId: org.id,
      meta: { messageSid, from, to, reason: 'receptionist_stopped', preview: body.slice(0, 160) },
    })
    return twiml('')
  }

  const customer = await matchCustomerByPhone(org.id, from)
  let conversation = await db.conversation.findFirst({
    where: { orgId: org.id, channel: 'whatsapp', externalRef: waThreadKey(from) },
  })
  if (!conversation) {
    conversation = await db.conversation.create({
      data: { orgId: org.id, channel: 'whatsapp', status: 'open', contactName: customer?.name || profileName || from, customerId: customer?.id ?? null, externalRef: waThreadKey(from) },
    })
  }

  await audit({
    orgId: org.id, actorType: 'webhook', actorId: 'twilio_whatsapp',
    action: 'telephony.whatsapp_received', entity: 'conversation', entityId: conversation.id,
    meta: { messageSid, from, to, customerMatched: Boolean(customer) },
  })

  // Persist the inbound text immediately so the transcript (and the async AI turn's
  // history) always contains what the customer actually sent — even if the AI fails.
  await db.message.create({
    data: { conversationId: conversation.id, orgId: org.id, role: 'customer', content: body, meta: JSON.stringify({ source: 'whatsapp', messageSid }) },
  })

  // Opt-out is honored absolutely: inbound is recorded, but no outbound is ever sent.
  if (customer?.optOut) return twiml('')
  if (!conversation.aiEnabled) return twiml('')

  const conversationId = conversation.id
  const statusBefore = conversation.status
  after(async () => {
    try {
      const result = await handleReceptionistTurn(org, conversationId, body, { skipInboundPersist: true, channel: 'whatsapp' })
      const fresh = await db.conversation.findUnique({ where: { id: conversationId } })
      // Escalation automations fire only on the transition into waiting_human.
      if (statusBefore !== 'waiting_human' && fresh?.status === 'waiting_human') {
        await emitEvent(org.id, 'conversation_escalated', { conversationId, entityId: conversationId })
      }
      if (!result.reply) return

      const sender = await getEnabledIntegration(org.id, 'twilio_whatsapp')
      if (!sender) {
        await db.outboxMessage.create({
          data: {
            orgId: org.id, channel: 'whatsapp', recipient: from, body: result.reply,
            status: 'skipped', statusReason: 'AI reply generated but the Twilio WhatsApp integration is not enabled — enable it in Integrations to deliver replies',
            relatedType: 'conversation', relatedId: conversationId,
          },
        })
        return
      }
      try {
        await sendTwilio(sender, { to: from, body: result.reply })
        await audit({ orgId: org.id, actorType: 'system', actorId: 'whatsapp-receptionist', action: 'telephony.whatsapp_reply_sent', entity: 'conversation', entityId: conversationId, meta: { to: from, chars: result.reply.length } })
      } catch (sendErr) {
        await db.outboxMessage.create({
          data: {
            orgId: org.id, channel: 'whatsapp', recipient: from, body: result.reply,
            status: 'queued', statusReason: `initial send failed: ${sanitizeMessage(sendErr instanceof Error ? sendErr.message : String(sendErr), sender).slice(0, 200)}`,
            relatedType: 'conversation', relatedId: conversationId,
          },
        })
        console.error('[telephony] WhatsApp reply send failed (queued for retry):', sendErr instanceof Error ? sendErr.message : sendErr)
      }
    } catch (err) {
      console.error('[telephony] WhatsApp turn failed:', err instanceof Error ? err.message : err)
    }
  })

  return twiml('')
}, { rateLimit: { limit: 300 } })
