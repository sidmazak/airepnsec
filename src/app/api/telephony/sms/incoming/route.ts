import { NextRequest, after } from 'next/server'
import { db } from '@/lib/db'
import { withPublic } from '@/lib/api'
import {
  resolveTelephonyRoute, verifyTwilioSignature, candidateWebhookUrls, formParams,
  logWebhook, plainResponse, twiml,
} from '@/lib/telephony/twiml'
import { ingestInboundSms, replyToInboundSms } from '@/lib/telephony/inboundSms'

export const pathname = '/api/telephony/sms/incoming'

/**
 * POST /api/telephony/sms/incoming — Twilio inbound SMS webhook (signature-verified).
 * Threads one conversation per sender number, persists the inbound message immediately,
 * then answers with the real AI receptionist. STOP/START keywords update consent
 * before any AI turn. Opted-out customers never receive AI replies.
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

  const ingested = await ingestInboundSms({ org, from, to, body, messageSid, provider: 'twilio_sms' })
  if (!ingested.shouldReply || !ingested.conversationId) return twiml('')

  const conversationId = ingested.conversationId
  after(async () => {
    try {
      await replyToInboundSms({ org, conversationId, body, from, statusBefore: ingested.statusBefore })
    } catch (err) {
      console.error('[telephony] SMS turn failed:', err instanceof Error ? err.message : err)
    }
  })

  return twiml('')
}, { rateLimit: { limit: 300 } })
