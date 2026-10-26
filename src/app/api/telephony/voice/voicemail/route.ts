import { NextRequest } from 'next/server'
import { withPublic } from '@/lib/api'
import {
  candidateWebhookUrls, formParams, logWebhook, plainResponse, resolveTelephonyRoute,
  say, hangup, twiml, verifyTwilioSignature,
} from '@/lib/telephony/twiml'
import { persistVoicemail, VOICEMAIL_PATH } from '@/lib/telephony/voicemail'

export const pathname = VOICEMAIL_PATH

/**
 * POST /api/telephony/voice/voicemail — Twilio <Record> action and transcription
 * callback. Signature-verified. Saves the recording reference and transcript,
 * notifies staff and queues the optional caller acknowledgement. No audio is
 * stored by this app (Twilio hosts the recording; the URL is saved).
 */
export const POST = withPublic(async (req: NextRequest) => {
  const params = await formParams(req)
  const callSid = params.CallSid ?? ''
  const to = params.To ?? ''
  const from = params.From ?? ''
  const recordingUrl = params.RecordingUrl ?? ''
  const transcript = (params.TranscriptionText ?? '').trim()
  const duration = Number(params.RecordingDuration ?? '0') || 0
  const isTranscription = Boolean(transcript) || params.TranscriptionStatus === 'completed'

  const route = await resolveTelephonyRoute(['twilio_voice'], to)
  if (!route) return plainResponse(404, 'No enabled twilio_voice integration owns this number')

  let config: Record<string, unknown> = {}
  try {
    config = JSON.parse(route.integration.configJson || '{}') as Record<string, unknown>
  } catch {
    config = {}
  }

  const signature = req.headers.get('x-twilio-signature')
  const candidates = candidateWebhookUrls(req, config, VOICEMAIL_PATH)
  const signatureValid = candidates.some((u) => verifyTwilioSignature(route.secrets.authToken ?? '', u, params, signature))
  const eventId = `${isTranscription ? 'voicemail-transcript' : 'voicemail'}:${callSid}:${recordingUrl || params.TranscriptionSid || 'unknown'}`
  await logWebhook({
    orgId: route.orgId,
    provider: 'twilio_voice',
    eventId,
    payload: { ...params, TranscriptionText: transcript.slice(0, 400) },
    signatureValid,
    result: signatureValid ? 'processed' : 'rejected',
  })
  if (!signatureValid) return plainResponse(403, 'Invalid Twilio signature')
  if (!callSid) return plainResponse(400, 'Missing CallSid')

  try {
    await persistVoicemail({
      orgId: route.orgId,
      callSid,
      from,
      to,
      recordingUrl: recordingUrl || undefined,
      recordingDurationSec: duration,
      transcript: transcript || undefined,
    })
  } catch (err) {
    console.error('[telephony] voicemail persist failed:', err instanceof Error ? err.message : err)
    return plainResponse(500, 'Could not save the voicemail')
  }

  const language = (typeof config.language === 'string' && config.language) || 'en-US'
  const voiceName = (typeof config.voiceName === 'string' && config.voiceName) || 'alice'
  if (isTranscription) return plainResponse(204, '')
  return twiml(say('Thank you. Your message has been recorded. Goodbye.', { voice: voiceName, language }) + hangup)
}, { rateLimit: { limit: 300 } })
