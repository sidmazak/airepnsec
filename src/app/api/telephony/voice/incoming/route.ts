import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { parseJson } from '@/lib/org'
import type { AiIdentity } from '@/lib/org'
import { withPublic } from '@/lib/api'
import {
  resolveTelephonyRoute, verifyTwilioSignature, candidateWebhookUrls, formParams,
  matchCustomerByPhone, logWebhook, plainResponse, twiml, gatherSpeech, say, hangup, dialNumber, dialNumbers,
} from '@/lib/telephony/twiml'
import { normalizeReceptionistStatus } from '@/lib/receptionist/status'
import {
  buildLineCandidates,
  normalizeAgentLines,
  normalizeRoutingStrategy,
  pickLeastBusy,
  pickRedirect,
  pickRoundRobin,
  pickSimultaneous,
} from '@/lib/telephony/routing'
import { orgOpenState } from '@/lib/telephony/hours'
import { voicemailEnabled, voicemailResponse } from '@/lib/telephony/voicemail'

export const pathname = '/api/telephony/voice/incoming'

/**
 * POST /api/telephony/voice/incoming — Twilio Voice webhook (A "call arrives" URL).
 * Real phone receptionist entry point: signature-verified, resolves the org by the
 * called number, opens a `phone` conversation, greets, and starts the speech loop.
 *
 * PABX routing: `routingStrategy` can send calls to agent lines
 * (`least_busy`, `round_robin`, `redirect`, `simultaneous`) instead of the AI.
 * Outside opening hours the configured `afterHoursAction` decides between the
 * receptionist, voicemail and a transfer. A missed/transferred call is never
 * dropped silently: the status callback takes a voicemail and notifies staff.
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
  const ringTimeoutSec = Number(config.ringTimeoutSec) >= 5 && Number(config.ringTimeoutSec) <= 60 ? Number(config.ringTimeoutSec) : 25

  // Opening hours + after-hours policy. The default is an honest voicemail
  // rather than pretending the business is staffed around the clock.
  const openState = orgOpenState({ openingHours: org.openingHours, holidays: org.holidays, timezone: org.timezone })
  const afterHoursAction = config.afterHoursAction === 'receptionist' || config.afterHoursAction === 'transfer'
    ? config.afterHoursAction
    : 'voicemail'
  const transferNumber = (typeof config.transferNumber === 'string' && config.transferNumber.trim()) || ''
  const afterHoursTransferNumber = (typeof config.afterHoursTransferNumber === 'string' && config.afterHoursTransferNumber.trim()) || ''
  const closedAction = openState.open ? 'receptionist' : afterHoursAction

  // ---- PABX / multi-agent line routing ----
  const strategy = normalizeRoutingStrategy(config.routingStrategy)
  const configuredLines = normalizeAgentLines(config.agentLines)
  let routedLines: Array<{ id: string; number: string; label: string }> = []

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

    const eligible = buildLineCandidates(configuredLines, lineStates, activeCalls)
    if (strategy === 'simultaneous') {
      const chosen = pickSimultaneous(eligible)
      routedLines = await Promise.all(chosen.map(async (pick) => ensureLine(org.id, route.integration.id, pick.number, pick.label)))
    } else {
      let chosen =
        strategy === 'least_busy' ? pickLeastBusy(eligible) : strategy === 'redirect' ? pickRedirect(eligible) : null

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
        routedLines = [await ensureLine(org.id, route.integration.id, chosen.number, chosen.label)]
      }
    }
  }

  // After-hours voicemail/transfer takes precedence over both AI and PABX lines
  // unless the operator explicitly asked for the receptionist or a transfer.
  if (!openState.open && closedAction === 'voicemail' && voicemailEnabled(config)) {
    const callId = await recordCall(org.id, callSid, from, to, '', { strategy: 'after_hours', afterHoursAction: 'voicemail', openState })
    await audit({
      orgId: org.id, actorType: 'webhook', actorId: 'twilio_voice',
      action: 'telephony.call_after_hours', entity: 'telephony_call', entityId: callId,
      meta: { callSid, reason: openState.reason, localTime: openState.localTime },
    })
    return voicemailResponse(req, config, org.name)
  }

  if (!openState.open && closedAction === 'transfer') {
    const target = afterHoursTransferNumber || transferNumber
    if (target) {
      const callId = await recordCall(org.id, callSid, from, to, '', { strategy: 'after_hours', afterHoursAction: 'transfer', openState })
      await audit({
        orgId: org.id, actorType: 'webhook', actorId: 'twilio_voice',
        action: 'telephony.call_after_hours', entity: 'telephony_call', entityId: callId,
        meta: { callSid, target, reason: openState.reason },
      })
      const safeNum = target.replace(/[&<>"']/g, '')
      return twiml(
        say('Thanks for calling. Our office is closed, so we are connecting you to our on-call team.', { voice: voiceName, language }) +
          `<Dial timeout="${ringTimeoutSec}" action="/api/telephony/voice/status?routed=1">${safeNum}</Dial>` +
          say('Our on-call team is unavailable. Please leave a message after the tone.', { voice: voiceName, language }) +
          '<Record maxLength="120" playBeep="true" trim="trim-silence"/>' +
          '<Hangup/>'
      )
    }
    // No transfer target configured — voicemail is safer than a dead end.
    if (voicemailEnabled(config)) {
      await recordCall(org.id, callSid, from, to, '', { strategy: 'after_hours', afterHoursAction: 'voicemail_fallback', openState })
      return voicemailResponse(req, config, org.name)
    }
  }

  if (routedLines.length > 0) {
    const first = routedLines[0]
    const callId = await recordCall(org.id, callSid, from, to, first.id, {
      strategy,
      routedTo: routedLines.map((line) => line.number),
      labels: routedLines.map((line) => line.label),
    })
    await audit({
      orgId: org.id,
      actorType: 'webhook',
      actorId: 'twilio_voice',
      action: 'telephony.call_routed',
      entity: 'telephony_call',
      entityId: callId,
      meta: { callSid, to: routedLines.map((line) => line.number), strategy, label: routedLines.map((line) => line.label).join(', ') },
    })
    const intro = routedLines.length > 1
      ? 'One moment, connecting you to our team.'
      : `One moment, connecting you to ${first.label}.`
    const dial = routedLines.length > 1
      ? dialNumbers(routedLines.map((line) => line.number), { ringTimeoutSec, actionPath: '/api/telephony/voice/status?routed=1' })
      : dialNumber(first.number, { ringTimeoutSec, actionPath: '/api/telephony/voice/status?routed=1' })
    return twiml(
      say(intro, { voice: voiceName, language }) +
        dial +
        say('Our team is unavailable right now. Please leave a brief message after the tone.', { voice: voiceName, language }) +
        '<Record maxLength="120" playBeep="true" trim="trim-silence"/>' +
        '<Hangup/>'
    )
  }

  // Organization-wide runtime switch. Calls routed to a human agent line are
  // unaffected — only the AI receptionist stops answering.
  const receptionistStatus = normalizeReceptionistStatus(org.receptionistStatus)
  if (receptionistStatus !== 'running') {
    const callId = await recordCall(org.id, callSid, from, to, '', { strategy: 'receptionist', receptionistStatus, ai: false })
    await audit({
      orgId: org.id, actorType: 'webhook', actorId: 'twilio_voice',
      action: 'telephony.call_not_answered', entity: 'conversation', entityId: conversation.id,
      meta: { callSid, from, to, receptionistStatus },
    })
    if (voicemailEnabled(config)) {
      return voicemailResponse(req, config, org.name)
    }
    const notice =
      receptionistStatus === 'paused'
        ? 'Our assistant is taking a break right now. Please call back later or leave a message on our website.'
        : 'This line is currently unavailable. Please try our website instead.'
    return twiml(say(notice, { voice: voiceName, language }) + hangup)
  }

  await recordCall(org.id, callSid, from, to, '', { strategy: 'receptionist', ai: true })

  return twiml(
    gatherSpeech('/api/telephony/voice/gather', {
      sayText: greeting,
      language,
      voiceName,
      hints: 'book, reschedule, cancel, hours, price, parking',
    })
  )
}, { rateLimit: { limit: 300 } })

/** Create the agent line row on first use and return its identity. */
async function ensureLine(orgId: string, integrationId: string, number: string, label: string): Promise<{ id: string; number: string; label: string }> {
  let line = await db.telephonyLine.findFirst({ where: { orgId, phoneNumber: number } })
  if (!line) {
    line = await db.telephonyLine.create({
      data: {
        orgId,
        integrationId,
        label,
        phoneNumber: number,
        destinationKind: 'phone',
        destinationValue: number,
        priority: 100,
        enabled: true,
        acceptingCalls: true,
      },
    })
  }
  return { id: line.id, number, label }
}

/** Record every call (AI-handled, routed, after-hours) for load/least-busy accuracy. */
async function recordCall(
  orgId: string,
  callSid: string,
  from: string,
  to: string,
  lineId: string,
  meta: Record<string, unknown>
): Promise<string> {
  const existing = await db.telephonyCall.findFirst({ where: { orgId, callSid }, select: { id: true } })
  if (existing) {
    await db.telephonyCall
      .update({ where: { id: existing.id }, data: { lineId, status: 'started', meta: JSON.stringify(meta) } })
      .catch(() => undefined)
    return existing.id
  }
  const created = await db.telephonyCall
    .create({ data: { orgId, callSid, from, to, lineId, status: 'started', meta: JSON.stringify(meta) } })
    .catch(() => null)
  return created?.id ?? ''
}
