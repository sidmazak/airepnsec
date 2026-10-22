import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { parseJson } from '@/lib/org'
import type { AiIdentity } from '@/lib/org'
import { withPublic } from '@/lib/api'
import {
  resolveTelephonyRoute, verifyTwilioSignature, candidateWebhookUrls, formParams,
  matchCustomerByPhone, logWebhook, plainResponse, twiml, gatherSpeech, say, hangup,
} from '@/lib/telephony/twiml'
import { normalizeReceptionistStatus } from '@/lib/receptionist/status'
import {
  buildLineCandidates,
  normalizeAgentLines,
  pickLeastBusy,
  pickRedirect,
  pickRoundRobin,
} from '@/lib/telephony/routing'

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
  const configuredLines = normalizeAgentLines(config.agentLines)
  let routedLine: { id: string; number: string; label: string } | null = null

  if (strategy !== 'receptionist' && configuredLines.length > 0) {
    const numbers = configuredLines.map((l) => l.number)
    const activeSince = new Date(Date.now() - 4 * 3600_000)
    const [lineStates, activeCalls] = await Promise.all([
      db.telephonyLine.findMany({
        where: { orgId: org.id, phoneNumber: { in: numbers } },
        select: { id: true, phoneNumber: true, enabled: true, acceptingCalls: true, priority: true },
      }),
      db.telephonyCall.findMany({
        where: {
          orgId: org.id,
          callSid: { not: callSid },
          status: { in: ['started', 'answered'] },
          startedAt: { gte: activeSince },
        },
        select: { lineId: true },
      }),
    ])

    const candidates = buildLineCandidates(configuredLines, lineStates, activeCalls)
    let chosen =
      strategy === 'least_busy' ? pickLeastBusy(candidates) : strategy === 'redirect' ? pickRedirect(candidates) : null

    if (!chosen && strategy !== 'redirect') {
      // round_robin: compare-and-swap the stored cursor so two instances handling
      // simultaneous calls never hand both calls to the same agent.
      for (let attempt = 0; attempt < 5 && !chosen; attempt++) {
        const fresh =
          attempt === 0
            ? route.integration
            : await db.integration.findUnique({ where: { id: route.integration.id } })
        if (!fresh) break
        const freshCfg = (() => {
          try {
            return JSON.parse(fresh.configJson || '{}') as Record<string, unknown>
          } catch {
            return {}
          }
        })()
        const freshCandidates = buildLineCandidates(
          normalizeAgentLines(freshCfg.agentLines),
          lineStates,
          activeCalls
        )
        const pick = pickRoundRobin(freshCandidates, Number(freshCfg.lastRrIndex ?? -1))
        if (!pick) break
        const updated = await db.integration.updateMany({
          where: { id: fresh.id, configJson: fresh.configJson },
          data: { configJson: JSON.stringify({ ...freshCfg, lastRrIndex: pick.index }) },
        })
        if (updated.count === 1) chosen = pick
      }
    }

    if (chosen) {
      const targetNumber = chosen.number
      const targetLabel = chosen.label
      let line = await db.telephonyLine.findFirst({ where: { orgId: org.id, phoneNumber: targetNumber } })
      if (!line) {
        line = await db.telephonyLine.create({
          data: {
            orgId: org.id,
            integrationId: route.integration.id,
            label: targetLabel,
            phoneNumber: targetNumber,
            destinationKind: 'phone',
            destinationValue: targetNumber,
            priority: 100,
            enabled: true,
            acceptingCalls: true,
          },
        })
      }
      routedLine = { id: line.id, number: targetNumber, label: targetLabel }
    }
  }

  // Record every call (routed or AI-handled) for concurrency/least-busy accuracy.
  const existingCall = await db.telephonyCall.findFirst({ where: { orgId: org.id, callSid }, select: { id: true } })
  const callMeta = JSON.stringify(
    routedLine
      ? { strategy, routedTo: routedLine.number, label: routedLine.label }
      : { strategy: 'receptionist', ai: true }
  )
  let callId = existingCall?.id ?? ''
  if (existingCall) {
    await db.telephonyCall
      .update({ where: { id: existingCall.id }, data: { lineId: routedLine?.id ?? '', status: 'started', meta: callMeta } })
      .catch(() => undefined)
  } else {
    const created = await db.telephonyCall
      .create({ data: { orgId: org.id, callSid, from, to, lineId: routedLine?.id ?? '', status: 'started', meta: callMeta } })
      .catch(() => null)
    callId = created?.id ?? ''
  }

  if (routedLine) {
    await audit({
      orgId: org.id,
      actorType: 'webhook',
      actorId: 'twilio_voice',
      action: 'telephony.call_routed',
      entity: 'telephony_call',
      entityId: routedLine.id,
      meta: { callSid, to: routedLine.number, strategy, label: routedLine.label },
    })
    const safeNum = routedLine.number.replace(/[&<>"']/g, '')
    return twiml(
      say(`One moment, connecting you to ${routedLine.label}.`, { voice: voiceName, language }) +
        `<Dial timeout="25" action="/api/telephony/voice/status?routed=1">${safeNum}</Dial>` +
        say('Our team is unavailable right now. Please leave a brief message after the tone.', { voice: voiceName, language }) +
        '<Record maxLength="60" playBeep="true"/>' +
        '<Hangup/>'
    )
  }

  // Organization-wide runtime switch. Calls routed to a human agent line are
  // unaffected — only the AI receptionist stops answering.
  const receptionistStatus = normalizeReceptionistStatus(org.receptionistStatus)
  if (receptionistStatus !== 'running') {
    if (callId) {
      await db.telephonyCall
        .update({
          where: { id: callId },
          data: { status: 'missed', endedAt: new Date(), meta: JSON.stringify({ strategy: 'receptionist', ai: false, receptionistStatus }) },
        })
        .catch(() => undefined)
    }
    await audit({
      orgId: org.id, actorType: 'webhook', actorId: 'twilio_voice',
      action: 'telephony.call_not_answered', entity: 'conversation', entityId: conversation.id,
      meta: { callSid, from, to, receptionistStatus },
    })
    const notice =
      receptionistStatus === 'paused'
        ? 'Our assistant is taking a break right now. Please call back later or leave a message on our website.'
        : 'This line is currently unavailable. Please try our website instead.'
    return twiml(say(notice, { voice: voiceName, language }) + hangup)
  }

  return twiml(
    gatherSpeech('/api/telephony/voice/gather', {
      sayText: greeting,
      language,
      voiceName,
      hints: 'book, reschedule, cancel, hours, price, parking',
    })
  )
}, { rateLimit: { limit: 300 } })
