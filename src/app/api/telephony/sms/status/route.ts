import { NextRequest } from 'next/server'
import { audit } from '@/lib/audit'
import { withPublic } from '@/lib/api'
import { db } from '@/lib/db'
import { applyDeliveryReceipt } from '@/lib/integrations/delivery'
import {
  candidateWebhookUrls, formParams, logWebhook, plainResponse, resolveTelephonyRoute, verifyTwilioSignature,
} from '@/lib/telephony/twiml'

export const pathname = '/api/telephony/sms/status'

/**
 * POST /api/telephony/sms/status — Twilio message status callback (SMS + WhatsApp).
 *
 * Twilio signs the callback with the account auth token. We resolve the owning
 * integration from the sender number, verify the signature, then apply the real
 * handset outcome to the matching outbox row by MessageSid. A 2xx here only
 * acknowledges Twilio; the outbox only says "delivered" after Twilio says so.
 */
export const POST = withPublic(async (req: NextRequest) => {
  const params = await formParams(req)
  const messageSid = params.MessageSid ?? ''
  const rawStatus = params.MessageStatus ?? ''
  const sender = params.From ?? params.To ?? ''
  if (!messageSid || !rawStatus) return plainResponse(400, 'Missing MessageSid or MessageStatus')

  const route = await resolveTelephonyRoute(['twilio_sms', 'twilio_whatsapp'], sender)
  if (!route) return plainResponse(404, 'No enabled Twilio integration owns this number')
  const integration = await db.integration.findUnique({ where: { id: route.integration.id } })
  if (!integration) return plainResponse(404, 'Integration not found')

  const signature = req.headers.get('x-twilio-signature')
  const candidates = candidateWebhookUrls(req, JSON.parse(integration.configJson || '{}'), pathname)
  const valid = candidates.some((url) => verifyTwilioSignature(route.secrets.authToken ?? '', url, params, signature))
  const eventId = `twilio-status:${messageSid}:${rawStatus}`.slice(0, 180)
  if (!valid) {
    await logWebhook({
      orgId: route.orgId, provider: 'twilio_status', eventId,
      payload: { MessageSid: messageSid, MessageStatus: rawStatus, From: sender },
      signatureValid: false, result: 'rejected',
    })
    return plainResponse(403, 'Invalid Twilio signature')
  }

  const { duplicate } = await logWebhook({
    orgId: route.orgId, provider: 'twilio_status', eventId,
    payload: { MessageSid: messageSid, MessageStatus: rawStatus, From: sender, ErrorCode: params.ErrorCode ?? '' },
    signatureValid: true, result: 'received',
  })
  if (duplicate) return plainResponse(200, 'OK')

  const providerKind = route.integration.kind === 'twilio_whatsapp' ? 'twilio_whatsapp' : 'twilio_sms'
  const detail = [params.ErrorCode ? `error ${params.ErrorCode}` : '', params.ErrorMessage ?? ''].filter(Boolean).join(': ')
  const result = await applyDeliveryReceipt({
    orgId: route.orgId, providerKind, providerMessageId: messageSid,
    rawStatus, detail,
  })

  if (result.state === 'failed') {
    await audit({
      orgId: route.orgId, actorType: 'webhook', actorId: 'twilio_status',
      action: 'telephony.delivery_failed', entity: 'outbox_message', entityId: messageSid,
      meta: { providerKind, status: rawStatus, detail: detail.slice(0, 200) },
    })
  }

  await db.webhookEvent.updateMany({
    where: { orgId: route.orgId, provider: 'twilio_status', eventId },
    data: { result: 'processed', processedAt: new Date() },
  })
  return plainResponse(200, 'OK')
}, { rateLimit: { limit: 300 } })
