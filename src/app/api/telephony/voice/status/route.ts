import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { withPublic } from '@/lib/api'
import {
  resolveTelephonyRoute, verifyTwilioSignature, candidateWebhookUrls, formParams, logWebhook, plainResponse,
} from '@/lib/telephony/twiml'

export const pathname = '/api/telephony/voice/status'

/** POST /api/telephony/voice/status — Twilio call status callback (signature-verified, audit only). */
export const POST = withPublic(async (req: NextRequest) => {
  const params = await formParams(req)
  const callSid = params.CallSid ?? ''
  const to = params.To ?? ''

  const route = await resolveTelephonyRoute(['twilio_voice'], to)
  if (!route) return plainResponse(204, '')

  const config = (() => { try { return JSON.parse(route.integration.configJson || '{}') as Record<string, unknown> } catch { return {} } })()
  const signature = req.headers.get('x-twilio-signature')
  const candidates = candidateWebhookUrls(req, config, pathname)
  const signatureValid = candidates.some((u) => verifyTwilioSignature(route.secrets.authToken ?? '', u, params, signature))

  await logWebhook({
    orgId: route.orgId,
    provider: 'twilio_voice',
    eventId: `status:${callSid}:${params.CallStatus ?? 'unknown'}:${Date.now()}`,
    payload: params,
    signatureValid,
    result: signatureValid ? 'processed' : 'rejected',
  })
  if (!signatureValid) return plainResponse(403, 'Invalid Twilio signature')

  const conversation = await db.conversation.findFirst({ where: { orgId: route.orgId, channel: 'phone', externalRef: callSid } })
  const status = params.CallStatus ?? 'unknown'
  if (conversation && ['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(status)) {
    if (status === 'completed') {
      await db.conversation.update({ where: { id: conversation.id }, data: { status: 'closed' } }).catch(() => {})
    }
    await audit({
      orgId: route.orgId, actorType: 'webhook', actorId: 'twilio_voice',
      action: 'telephony.call_status', entity: 'conversation', entityId: conversation.id,
      meta: { callSid, status, durationSec: params.CallDuration ?? '' },
    })
  }
  return plainResponse(204, '')
})
