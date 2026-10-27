import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { notifyStaffEvent } from '@/lib/notifications/staff'
import { parseJson } from '@/lib/org'
import { say, hangup, twiml, voicemailRecord, publicOrigin, matchCustomerByPhone } from '@/lib/telephony/twiml'

export const VOICEMAIL_PATH = '/api/telephony/voice/voicemail'

export function voicemailEnabled(config: Record<string, unknown>): boolean {
  return config.voicemailEnabled !== false
}

function voicemailGreeting(config: Record<string, unknown>, orgName: string): string {
  const custom = typeof config.voicemailGreeting === 'string' ? config.voicemailGreeting.trim() : ''
  return custom || `Thanks for calling ${orgName}. We cannot take your call right now. Please leave your name, number and a short message after the tone.`
}

/** TwiML that plays the voicemail prompt and records the caller's message. */
export function voicemailResponse(req: NextRequest, config: Record<string, unknown>, orgName: string): Response {
  const language = (typeof config.language === 'string' && config.language) || 'en-US'
  const voiceName = (typeof config.voiceName === 'string' && config.voiceName) || 'alice'
  const origin = publicOrigin(req, config)
  const greeting = voicemailGreeting(config, orgName)
  return twiml(
    voicemailRecord({
      actionPath: VOICEMAIL_PATH,
      greeting,
      voice: voiceName,
      language,
      transcribeCallback: origin ? `${origin}${VOICEMAIL_PATH}` : undefined,
    }) +
      say('Thank you. Your message has been recorded. Goodbye.', { voice: voiceName, language }) +
      hangup
  )
}

/**
 * Alert staff about a call that ended without voicemail (no answer, failed,
 * cancelled, or the caller hung up). Deduped per call.
 */
export async function notifyMissedCall(input: { orgId: string; callSid: string; from: string; to: string; reason: string }): Promise<void> {
  const org = await db.organization.findUnique({ where: { id: input.orgId } })
  if (!org) return
  const customer = await matchCustomerByPhone(org.id, input.from)
  const body = `${customer?.name ? `${customer.name} — ` : ''}${input.from || 'unknown caller'} called ${input.to || 'the business line'} and the call was not answered (${input.reason}).`
  await notifyStaffEvent({
    orgId: org.id,
    event: 'missed_call',
    subject: 'Missed call',
    body,
    relatedType: 'telephony_call',
    dedupeKey: `missed-call:${input.callSid}`,
  })

  await audit({
    orgId: org.id,
    actorType: 'system',
    actorId: 'telephony',
    action: 'telephony.call_missed',
    entity: 'telephony_call',
    meta: { callSid: input.callSid, from: input.from, reason: input.reason },
  })
}

type VoicemailInput = {
  orgId: string
  callSid: string
  from: string
  to: string
  recordingUrl?: string
  recordingDurationSec?: number
  transcript?: string
}

/**
 * Persist a voicemail on the phone conversation, update the call record, notify
 * staff (visible in the inbox and the outbox) and optionally text an
 * acknowledgement back to the caller. Honest states only — the acknowledgement
 * is queued in the outbox, it is not claimed as delivered.
 */
export async function persistVoicemail(input: VoicemailInput): Promise<{ conversationId: string; notificationQueued: boolean; acknowledgementQueued: boolean }> {
  const org = await db.organization.findUnique({ where: { id: input.orgId } })
  if (!org) throw new Error('Organization not found')

  const customer = await matchCustomerByPhone(org.id, input.from)
  let conversation = await db.conversation.findFirst({
    where: { orgId: org.id, channel: 'phone', externalRef: input.callSid },
  })
  if (!conversation) {
    conversation = await db.conversation.create({
      data: {
        orgId: org.id,
        channel: 'phone',
        status: 'open',
        contactName: customer?.name || input.from || 'Unknown caller',
        customerId: customer?.id ?? null,
        externalRef: input.callSid,
      },
    })
  }

  const transcript = (input.transcript ?? '').trim()
  const meta = JSON.stringify({
    source: 'voicemail',
    callSid: input.callSid,
    from: input.from,
    to: input.to,
    recordingUrl: input.recordingUrl ?? '',
    recordingDurationSec: input.recordingDurationSec ?? 0,
  })

  const existing = await db.message.findFirst({
    where: { conversationId: conversation.id, role: 'system', meta: { contains: input.callSid } },
  })
  const content = transcript
    ? `Voicemail transcript: ${transcript}`
    : input.recordingUrl
      ? `Voicemail received (${input.recordingDurationSec ?? 0}s). Recording: ${input.recordingUrl}`
      : 'Voicemail received.'
  if (existing) {
    await db.message.update({ where: { id: existing.id }, data: { content, meta } })
  } else {
    await db.message.create({ data: { conversationId: conversation.id, orgId: org.id, role: 'system', content, meta } })
  }

  const callMeta = parseJson<Record<string, unknown>>(
    (await db.telephonyCall.findFirst({ where: { orgId: org.id, callSid: input.callSid } }))?.meta ?? '{}',
    {}
  )
  await db.telephonyCall.updateMany({
    where: { orgId: org.id, callSid: input.callSid },
    data: {
      status: 'missed',
      endedAt: new Date(),
      meta: JSON.stringify({
        ...callMeta,
        voicemail: true,
        recordingUrl: input.recordingUrl ?? '',
        transcript: transcript.slice(0, 500),
      }),
    },
  })

  // Staff-visible notification. Deduped per call so the recording callback and
  // the transcription callback cannot create two alerts.
  let notificationQueued = false
  if (!existing) {
    const sent = await notifyStaffEvent({
      orgId: org.id,
      event: 'voicemail',
      subject: `New voicemail from ${input.from || 'unknown caller'}`,
      body: `${customer?.name ? `${customer.name} — ` : ''}${transcript || 'A caller left a voicemail.'}${input.recordingUrl ? `

Recording: ${input.recordingUrl}` : ''}`,
      relatedType: 'telephony_call',
      relatedId: conversation.id,
      dedupeKey: `voicemail-notify:${input.callSid}`,
    })
    notificationQueued = sent.inapp || sent.email
  }

  // Optional caller acknowledgement. Only for a caller we can text, and only
  // when they have not opted out. Queued — never reported as delivered.
  let acknowledgementQueued = false
  const voiceIntegration = await db.integration.findFirst({ where: { orgId: org.id, kind: 'twilio_voice' } })
  const ackTemplate = parseJson<Record<string, unknown>>(voiceIntegration?.configJson ?? '{}', {}).missedCallSms
  if (typeof ackTemplate === 'string' && ackTemplate.trim() && input.from && !customer?.optOut) {
    await db.outboxMessage
      .create({
        data: {
          orgId: org.id,
          channel: 'sms',
          recipient: input.from,
          body: ackTemplate.trim(),
          status: 'queued',
          relatedType: 'conversation',
          relatedId: conversation.id,
          dedupeKey: `voicemail-ack:${input.callSid}`,
        },
      })
      .catch((err: { code?: string }) => {
        if (err?.code !== 'P2002') throw err
      })
    acknowledgementQueued = true
  }

  await audit({
    orgId: org.id,
    actorType: 'webhook',
    actorId: 'twilio_voice',
    action: 'telephony.voicemail_received',
    entity: 'conversation',
    entityId: conversation.id,
    meta: {
      callSid: input.callSid,
      from: input.from,
      durationSec: input.recordingDurationSec ?? 0,
      hasRecording: Boolean(input.recordingUrl),
      hasTranscript: Boolean(transcript),
      notificationQueued,
      acknowledgementQueued,
    },
  })

  return { conversationId: conversation.id, notificationQueued, acknowledgementQueued }
}
