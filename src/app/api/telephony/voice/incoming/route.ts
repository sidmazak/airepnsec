import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { parseJson } from '@/lib/org'
import type { AiIdentity } from '@/lib/org'
import { withPublic } from '@/lib/api'
import {
  resolveTelephonyRoute, verifyTwilioSignature, candidateWebhookUrls, formParams,
  matchCustomerByPhone, logWebhook, plainResponse, twiml, gatherSpeech, say,
} from '@/lib/telephony/twiml'

export const pathname = '/api/telephony/voice/incoming'

/**
 * POST /api/telephony/voice/incoming — Twilio Voice webhook (A "call arrives" URL).
 * Real phone receptionist entry point: signature-verified, resolves the org by the
 * called number, opens a `phone` conversation, greets, and starts the speech loop.
 * Configure this URL (public base URL must match) as the Voice webhook in Twilio.
 */
export const POST = withPublic(async (req: NextRequest) => {
  const params = await formParams(req)
  const callSid = params.CallSid ?? ''
  const from = params.From ?? ''
  const to = params.To ?? ''

  const route = await resolveTelephonyRoute(['twilio_voice'], to)
  if (!route) return plainResponse(404, 'No enabled twilio_voice integration owns this number')

  const config = (() => { try { return JSON.parse(route.integration.configJson || '{}') as Record<string, unknown> } catch { return {} } })()
  const signature = req.headers.get('x-twilio-signature')
  const candidates = candidateWebhookUrls(req, config, pathname)
  const signatureValid = candidates.some((u) => verifyTwilioSignature(route.secrets.authToken ?? '', u, params, signature))

  if (!signatureValid) {
    await logWebhook({ orgId: route.orgId, provider: 'twilio_voice', eventId: `incoming:${callSid}`, payload: params, signatureValid: false, result: 'rejected' })
    return plainResponse(403, 'Invalid Twilio signature')
  }

  const { duplicate } = await logWebhook({ orgId: route.orgId, provider: 'twilio_voice', eventId: `incoming:${callSid}`, payload: params, signatureValid: true, result: 'received' })
  if (duplicate) return twiml('')

  const org = await db.organization.findUnique({ where: { id: route.orgId } })
  if (!org) return plainResponse(404, 'Organization not found')

  const customer = await matchCustomerByPhone(org.id, from)
  let conversation = await db.conversation.findFirst({
    where: { orgId: org.id, channel: 'phone', externalRef: callSid },
  })
  if (!conversation) {
    conversation = await db.conversation.create({
      data: {
        orgId: org.id,
        channel: 'phone',
        status: 'open',
        contactName: customer?.name || from,
        customerId: customer?.id ?? null,
        externalRef: callSid,
      },
    })
  }

  await audit({
    orgId: org.id, actorType: 'webhook', actorId: 'twilio_voice',
    action: 'telephony.call_started', entity: 'conversation', entityId: conversation.id,
    meta: { callSid, from, to, customerMatched: Boolean(customer) },
  })

  const identity = parseJson<AiIdentity>(org.aiIdentity, {})
  const greeting = identity.greeting?.trim() || `Thanks for calling ${org.name}. How can I help you today?`
  const language = (typeof config.language === 'string' && config.language) || 'en-US'
  const voiceName = (typeof config.voiceName === 'string' && config.voiceName) || 'alice'

  return twiml(gatherSpeech('/api/telephony/voice/gather', { sayText: greeting, language, voiceName, hints: 'book, reschedule, cancel, hours, price, parking' }))
})
