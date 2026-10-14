import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { withPublic } from '@/lib/api'
import { handleReceptionistTurn } from '@/lib/ai/receptionist'
import { emitEvent } from '@/lib/automation/engine'
import { getEnabledIntegration, sendTwilio } from '@/lib/integrations/connectors'
import {
  resolveTelephonyRoute, verifyTwilioSignature, candidateWebhookUrls, formParams,
  matchCustomerByPhone, logWebhook, plainResponse, twiml,
} from '@/lib/telephony/twiml'

export const pathname = '/api/telephony/sms/incoming'

function smsThreadKey(from: string): string {
  return `sms:${from.replace(/\D/g, '')}`
}

/**
 * POST /api/telephony/sms/incoming — Twilio inbound SMS webhook (signature-verified).
 * Threads one conversation per sender number, persists the inbound message immediately,
 * then answers with the real AI receptionist. The AI reply goes out through the Twilio
 * Messages API (REST); on send failure it is queued in the outbox for retry with backoff.
 * Opted-out customers never receive outbound messages.
 */
export const POST = withPublic(async (req: NextRequest) => {
  const params = await formParams(req)
  const messageSid = params.MessageSid ?? ''
  const from = params.From ?? ''
  const to = params.To ?? ''
  const body = (params.Body ?? '').slice(0, 4000)

  const route = await resolveTelephonyRoute(['twilio_sms', 'twilio_voice'], to)
  if (!route) return plainResponse(404, 'No enabled Twilio integration owns this number')

  const config = (() => { try { return JSON.parse(route.integration.configJson || '{}') as Record<string, unknown> } catch { return {} } })()
  const signature = req.headers.get('x-twilio-signature')
  const candidates = candidateWebhookUrls(req, config, pathname)
  const signatureValid = candidates.some((u) => verifyTwilioSignature(route.secrets.authToken ?? '', u, params, signature))
  if (!signatureValid) {
    await logWebhook({ orgId: route.orgId, provider: 'twilio_sms', eventId: messageSid, payload: params, signatureValid: false, result: 'rejected' })
    return plainResponse(403, 'Invalid Twilio signature')
  }

  const { duplicate } = await logWebhook({ orgId: route.orgId, provider: 'twilio_sms', eventId: messageSid, payload: params, signatureValid: true, result: 'received' })
  if (duplicate) return twiml('')

  const org = await db.organization.findUnique({ where: { id: route.orgId } })
  if (!org || !body.trim()) return twiml('')

  const customer = await matchCustomerByPhone(org.id, from)
  let conversation = await db.conversation.findFirst({
    where: { orgId: org.id, channel: 'sms', externalRef: smsThreadKey(from) },
  })
  if (!conversation) {
    conversation = await db.conversation.create({
      data: { orgId: org.id, channel: 'sms', status: 'open', contactName: customer?.name || from, customerId: customer?.id ?? null, externalRef: smsThreadKey(from) },
    })
  }

  await audit({
    orgId: org.id, actorType: 'webhook', actorId: 'twilio_sms',
    action: 'telephony.sms_received', entity: 'conversation', entityId: conversation.id,
    meta: { messageSid, from, to, customerMatched: Boolean(customer) },
  })

  // Persist the inbound text immediately so the transcript (and the async AI turn's
  // history) always contains what the customer actually sent — even if the AI fails.
  await db.message.create({
    data: { conversationId: conversation.id, orgId: org.id, role: 'customer', content: body, meta: JSON.stringify({ source: 'sms', messageSid }) },
  })

  // Opt-out is honored absolutely: inbound is recorded, but no outbound is ever sent.
  if (customer?.optOut) return twiml('')
  if (!conversation.aiEnabled) return twiml('')

  const conversationId = conversation.id
  // Answer asynchronously — Twilio only needs a fast 200. Reply is sent via REST + outbox retry.
  void (async () => {
    try {
      const result = await handleReceptionistTurn(org, conversationId, body, { skipInboundPersist: true })
      const fresh = await db.conversation.findUnique({ where: { id: conversationId } })
      if (fresh?.status === 'waiting_human') {
        await emitEvent(org.id, 'conversation_escalated', { conversationId, entityId: conversationId })
      }
      if (!result.reply) return

      const sender = await getEnabledIntegration(org.id, 'twilio_sms')
      if (!sender) {
        // Keep the reply in the outbox with an honest status instead of dropping it.
        await db.outboxMessage.create({
          data: {
            orgId: org.id, channel: 'sms', recipient: from, body: result.reply,
            status: 'skipped', statusReason: 'AI reply generated but no enabled twilio_sms integration — enable one in Integrations to deliver SMS replies',
            relatedType: 'conversation', relatedId: conversationId,
          },
        })
        return
      }
      try {
        await sendTwilio(sender, { to: from, body: result.reply })
        await audit({ orgId: org.id, actorType: 'system', actorId: 'sms-receptionist', action: 'telephony.sms_reply_sent', entity: 'conversation', entityId: conversationId, meta: { to: from, chars: result.reply.length } })
      } catch (sendErr) {
        await db.outboxMessage.create({
          data: {
            orgId: org.id, channel: 'sms', recipient: from, body: result.reply,
            status: 'queued', statusReason: `initial send failed: ${sendErr instanceof Error ? sendErr.message.slice(0, 200) : 'unknown'}`,
            relatedType: 'conversation', relatedId: conversationId,
          },
        })
        console.error('[telephony] SMS reply send failed (queued for retry):', sendErr instanceof Error ? sendErr.message : sendErr)
      }
    } catch (err) {
      console.error('[telephony] SMS turn failed:', err instanceof Error ? err.message : err)
    }
  })()

  return twiml('')
})
