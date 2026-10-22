import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { withPublic } from '@/lib/api'
import { parseJson } from '@/lib/org'
import {
  resolveTelephonyRoute, verifyTwilioSignature, candidateWebhookUrls, formParams, logWebhook, plainResponse, twiml, say, hangup,
} from '@/lib/telephony/twiml'
import { resetNoInput } from '@/lib/telephony/no-input'
import { normalizeCallStatus } from '@/lib/telephony/routing'

export const pathname = '/api/telephony/voice/status'

const TERMINAL = new Set(['completed', 'missed', 'failed', 'no_answer'])

/** POST /api/telephony/voice/status — Twilio call status callback (signature-verified, audit only). */
export const POST = withPublic(async (req: NextRequest) => {
  const params = await formParams(req)
  const callSid = params.CallSid ?? ''
  const to = params.To ?? ''

  const route = await resolveTelephonyRoute(['twilio_voice'], to)
  if (!route) return plainResponse(204, '')

  const config = (() => { try { return JSON.parse(route.integration.configJson || '{}') as Record<string, unknown> } catch { return {} } })()
  const signature = req.headers.get('x-twilio-signature')
  // Twilio signs the exact URL it was given, including the query string. This
  // endpoint is called both directly (statusCallback) and as the <Dial action>
  // target with ?routed=1 — accept either signed form.
  const candidates = [
    ...candidateWebhookUrls(req, config, pathname),
    ...candidateWebhookUrls(req, config, `${pathname}?routed=1`),
  ]
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

  // The <Dial action> callback reports the agent leg in DialCallStatus; the parent
  // CallStatus can still be "in-progress" at that moment. Prefer the dial outcome.
  const rawStatus = (params.routed === '1' && params.DialCallStatus) || params.CallStatus || 'unknown'
  const status = normalizeCallStatus(rawStatus)
  const terminal = TERMINAL.has(status)

  if (terminal) resetNoInput(callSid)

  const tcall = await db.telephonyCall.findFirst({ where: { orgId: route.orgId, callSid } })
  if (tcall) {
    if (terminal && TERMINAL.has(tcall.status)) {
      // Already finalized (status callback and Dial action can both fire) — don't regress.
    } else {
      await db.telephonyCall
        .update({
          where: { id: tcall.id },
          data: {
            status: status === 'unknown' ? tcall.status : status,
            ...(terminal
              ? { endedAt: new Date(), durationSec: Number(params.CallDuration ?? '0') || 0 }
              : {}),
          },
        })
        .catch(() => {})
    }
  }

  const conversation = await db.conversation.findFirst({ where: { orgId: route.orgId, channel: 'phone', externalRef: callSid } })
  if (conversation && terminal) {
    if (conversation.status !== 'waiting_human') {
      await db.conversation.update({ where: { id: conversation.id }, data: { status: 'closed' } }).catch(() => {})
    }
    await audit({
      orgId: route.orgId, actorType: 'webhook', actorId: 'twilio_voice',
      action: 'telephony.call_status', entity: 'conversation', entityId: conversation.id,
      meta: { callSid, status, rawStatus, durationSec: params.CallDuration ?? '' },
    })
  }
  const voiceName = (typeof config.voiceName === 'string' && config.voiceName) || 'alice'
  const language = (typeof config.language === 'string' && config.language) || 'en-US'
  if (params.routed === '1' && ['no_answer', 'missed', 'failed'].includes(status)) {
    return twiml(
      say('Our team is unavailable right now. Please leave a brief message after the tone, or call back shortly.', { voice: voiceName, language }) +
        '<Record maxLength="60" playBeep="true"/>' +
        say('Goodbye.', { voice: voiceName, language }) +
        hangup
    )
  }
  return plainResponse(204, '')
}, { rateLimit: { limit: 600 } })
