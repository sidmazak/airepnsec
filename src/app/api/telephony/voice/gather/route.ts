import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { withPublic } from '@/lib/api'
import { handleReceptionistTurn } from '@/lib/ai/receptionist'
import { emitEvent } from '@/lib/automation/engine'
import {
  resolveTelephonyRoute, verifyTwilioSignature, candidateWebhookUrls, formParams,
  logWebhook, plainResponse, twiml, gatherSpeech, say, dialNumber, hangup,
} from '@/lib/telephony/twiml'
import { bumpNoInput, resetNoInput } from '@/lib/telephony/no-input'

export const pathname = '/api/telephony/voice/gather'

/**
 * POST /api/telephony/voice/gather — Twilio speech-result webhook.
 * One full AI receptionist turn per spoken utterance: speech → real LLM + tools
 * (availability, bookings, knowledge, claims) → <Say> reply → continue listening.
 * Escalated conversations are transferred or take a voicemail promise, then hang up.
 */
export const POST = withPublic(async (req: NextRequest) => {
  const params = await formParams(req)
  const callSid = params.CallSid ?? ''
  const to = params.To ?? ''
  const speech = (params.SpeechResult ?? '').trim()
  const confidence = Number(params.Confidence ?? '1')

  const route = await resolveTelephonyRoute(['twilio_voice'], to)
  if (!route) return plainResponse(404, 'No enabled twilio_voice integration owns this number')

  const config = (() => { try { return JSON.parse(route.integration.configJson || '{}') as Record<string, unknown> } catch { return {} } })()
  const signature = req.headers.get('x-twilio-signature')
  const candidates = candidateWebhookUrls(req, config, pathname)
  const signatureValid = candidates.some((u) => verifyTwilioSignature(route.secrets.authToken ?? '', u, params, signature))
  if (!signatureValid) {
    await logWebhook({ orgId: route.orgId, provider: 'twilio_voice', eventId: `gather:${callSid}`, payload: params, signatureValid: false, result: 'rejected' })
    return plainResponse(403, 'Invalid Twilio signature')
  }

  const org = await db.organization.findUnique({ where: { id: route.orgId } })
  if (!org) return plainResponse(404, 'Organization not found')

  let conversation = await db.conversation.findFirst({ where: { orgId: org.id, channel: 'phone', externalRef: callSid } })
  if (!conversation) {
    // Twilio sometimes hits gather before incoming finished persisting — recover gracefully.
    const { matchCustomerByPhone } = await import('@/lib/telephony/twiml')
    const customer = await matchCustomerByPhone(org.id, params.From ?? '')
    conversation = await db.conversation.create({
      data: { orgId: org.id, channel: 'phone', status: 'open', contactName: customer?.name || (params.From ?? ''), customerId: customer?.id ?? null, externalRef: callSid },
    })
  }

  const language = (typeof config.language === 'string' && config.language) || 'en-US'
  const voiceName = (typeof config.voiceName === 'string' && config.voiceName) || 'alice'
  const lowConfidence = speech && confidence > 0 && confidence < 0.45
  const statusBefore = conversation.status

  // Staff paused AI for this call — do not let the bot keep answering phone calls.
  if (!conversation.aiEnabled) {
    await db.message.create({ data: { conversationId: conversation.id, orgId: org.id, role: 'customer', content: speech || '(no speech)', meta: JSON.stringify({ source: 'phone', callSid, aiDisabled: true }) } }).catch(() => {})
    return twiml(say('A member of our team has taken over this call. Please try again later or leave a message on our website. Goodbye.', { voice: voiceName, language }) + hangup)
  }

  if (!speech) {
    const misses = bumpNoInput(callSid)
    if (misses >= 3) {
      resetNoInput(callSid)
      await db.conversation.update({ where: { id: conversation.id }, data: { status: 'closed' } })
      await audit({ orgId: org.id, actorType: 'webhook', actorId: 'twilio_voice', action: 'telephony.call_ended', entity: 'conversation', entityId: conversation.id, meta: { callSid, reason: 'no_input' } })
      return twiml(say('It seems we got disconnected. Do give us a call back — goodbye.', { voice: voiceName, language }) + hangup)
    }
    return twiml(gatherSpeech('/api/telephony/voice/gather', {
      sayText: misses === 1 ? 'Hello? I could not hear you — are you there?' : 'I am sorry, I still cannot hear you.',
      language, voiceName,
    }))
  }
  resetNoInput(callSid)

  await logWebhook({ orgId: org.id, provider: 'twilio_voice', eventId: `gather:${callSid}:${Date.now()}`, payload: { ...params, SpeechResult: speech.slice(0, 400) }, signatureValid: true, result: 'processed' })

  let reply = ''
  try {
    const result = await handleReceptionistTurn(org, conversation.id, lowConfidence ? `The caller said (low speech confidence): ${speech}` : speech)
    reply = result.reply
  } catch (err) {
    reply = 'I am sorry, something went wrong on my side. Your message has been saved and our team will follow up.'
    console.error('[telephony] gather turn failed:', err instanceof Error ? err.message : err)
  }

  const fresh = await db.conversation.findUnique({ where: { id: conversation.id } })
  // Escalation automations fire only on the transition into waiting_human.
  if (statusBefore !== 'waiting_human' && fresh?.status === 'waiting_human') {
    await emitEvent(org.id, 'conversation_escalated', { conversationId: conversation.id, entityId: conversation.id })
  }
  await audit({ orgId: org.id, actorType: 'webhook', actorId: 'twilio_voice', action: 'telephony.call_turn', entity: 'conversation', entityId: conversation.id, meta: { callSid, speech: speech.slice(0, 200), reply: reply.slice(0, 200) } })

  const transferNumber = (typeof config.transferNumber === 'string' && config.transferNumber.trim()) || ''
  if (fresh?.status === 'waiting_human') {
    if (transferNumber) {
      return twiml(say('Let me connect you with a member of our team. One moment please.', { voice: voiceName, language }) + dialNumber(transferNumber))
    }
    await db.conversation.update({ where: { id: conversation.id }, data: { status: 'closed' } })
    return twiml(say('Thanks for calling. We have noted your request and a team member will get back to you soon. Goodbye.', { voice: voiceName, language }) + hangup)
  }

  return twiml(
    say(reply, { voice: voiceName, language }) +
    gatherSpeech('/api/telephony/voice/gather', { sayText: 'Is there anything else I can help you with?', language, voiceName })
  )
}, { rateLimit: { limit: 600 } })
