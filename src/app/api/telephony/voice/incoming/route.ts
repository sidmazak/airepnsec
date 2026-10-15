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
 * Supports PABX-style multi-line routing: when the integration sets
 * routingStrategy != 'receptionist' with agentLines configured, the call is routed
 * to the least-busy / round-robin agent instead of the AI receptionist.
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

  // ---- PABX / multi-agent line routing ----
  const strategy = (typeof config.routingStrategy === 'string' && config.routingStrategy) || 'receptionist'
  const agentLines = Array.isArray(config.agentLines) ? (config.agentLines as Array<Record<string, unknown>>) : []
  const enabledLines = agentLines.filter((l) => l && l.enabled !== false && typeof l.number === 'string' && String(l.number).trim())
  if (strategy !== 'receptionist' && enabledLines.length > 0) {
    let chosen: Record<string, unknown> | null = null
    if (strategy === 'least_busy') {
      const recent = await db.telephonyCall.findMany({ where: { orgId: org.id, startedAt: { gte: new Date(Date.now() - 4 * 3600_000) }, status: { in: ['started', 'answered'] } }, select: { lineId: true } })
      const load = new Map<string, number>()
      for (const r of recent) load.set(r.lineId, (load.get(r.lineId) ?? 0) + 1)
      // load is keyed by line id; agent numbers aren't line ids yet, approximate by index position via counts array
      const counts = enabledLines.map(() => 0)
      recent.forEach(() => {})
      let bestIdx = 0
      let bestLoad = Infinity
      enabledLines.forEach((l, i) => {
        // approximate load by counting calls whose meta targeted this number (best-effort)
        const c = counts[i]
        if (c < bestLoad) { bestLoad = c; bestIdx = i }
      })
      // proper load by matching telephony line phone numbers
      const lines = await db.telephonyLine.findMany({ where: { orgId: org.id, phoneNumber: { in: enabledLines.map((l) => String(l.number)) } } })
      const loadByNumber = new Map<string, number>()
      for (const ln of lines) {
        const cnt = recent.filter(() => true).length
        loadByNumber.set(ln.phoneNumber, 0)
      }
      // count agent calls by lineId mapping
      const lineIdToNumber = new Map(lines.map((ln) => [ln.id, ln.phoneNumber]))
      for (const r of recent) {
        const num = lineIdToNumber.get(r.lineId)
        if (num) loadByNumber.set(num, (loadByNumber.get(num) ?? 0) + 1)
      }
      bestIdx = 0; bestLoad = Infinity
      enabledLines.forEach((l, i) => {
        const num = String(l.number ?? '')
        const lload = loadByNumber.get(num) ?? 0
        if (lload < bestLoad) { bestLoad = lload; bestIdx = i }
      })
      chosen = enabledLines[bestIdx]
    } else {
      // round_robin / redirect
      const lastIdx = typeof config.lastRrIndex === 'number' ? config.lastRrIndex : -1
      const idx = (lastIdx + 1) % enabledLines.length
      config.lastRrIndex = idx
      await db.integration.update({ where: { id: route.integration.id }, data: { configJson: JSON.stringify(config) } }).catch(() => {})
      chosen = enabledLines[idx]
    }
    const targetNumber = String(chosen?.number ?? '').trim()
    const targetLabel = String(chosen?.label ?? targetNumber)
    if (targetNumber) {
      let line = await db.telephonyLine.findFirst({ where: { orgId: org.id, phoneNumber: targetNumber } })
      if (!line) {
        line = await db.telephonyLine.create({ data: { orgId: org.id, integrationId: route.integration.id, label: targetLabel, phoneNumber: targetNumber, destinationKind: 'phone', destinationValue: targetNumber, priority: 100, enabled: true, acceptingCalls: true } })
      }
      await db.telephonyCall.create({ data: { orgId: org.id, callSid, from, to, lineId: line.id, status: 'started', meta: JSON.stringify({ routedTo: targetNumber, strategy }) } })
      await audit({ orgId: org.id, actorType: 'webhook', actorId: 'twilio_voice', action: 'telephony.call_routed', entity: 'telephony_call', entityId: line.id, meta: { callSid, to: targetNumber, strategy, label: targetLabel } })
      const safeNum = targetNumber.replace(/[&<>"']/g, '')
      return twiml(
        say(`One moment, connecting you to ${targetLabel}.`, { voice: voiceName, language }) +
        `<Dial timeout="25" action="/api/telephony/voice/status?routed=1">${safeNum}</Dial>` +
        say('Our team is unavailable right now. Please leave a brief message after the tone.', { voice: voiceName, language }) +
        '<Record maxLength="60" playBeep="true"/>' +
        '<Hangup/>'
      )
    }
  }

  return twiml(gatherSpeech('/api/telephony/voice/gather', { sayText: greeting, language, voiceName, hints: 'book, reschedule, cancel, hours, price, parking' }))
})
