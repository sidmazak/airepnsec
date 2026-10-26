import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { handleReceptionistTurn } from '@/lib/ai/receptionist'
import { emitEvent } from '@/lib/automation/engine'
import { sendOrgSms } from '@/lib/integrations/connectors'
import { normalizeReceptionistStatus } from '@/lib/receptionist/status'
import { matchCustomerByPhone } from '@/lib/telephony/twiml'
import { consentKeyword, type ConsentKeyword } from '@/lib/telephony/sms-keywords'
import type { Organization } from '@prisma/client'

export function smsThreadKey(from: string): string {
  return `sms:${from.replace(/\D/g, '')}`
}

type IngestResult = {
  conversationId: string | null
  statusBefore: string
  shouldReply: boolean
  keyword: ConsentKeyword
}

async function findOrCreateConversation(orgId: string, from: string, contactName: string, customerId: string | null) {
  const externalRef = smsThreadKey(from)
  const existing = await db.conversation.findFirst({ where: { orgId, channel: 'sms', externalRef } })
  if (existing) return existing
  return db.conversation.create({
    data: { orgId, channel: 'sms', status: 'open', contactName, customerId, externalRef },
  })
}

async function sendConsentAck(orgId: string, to: string, text: string): Promise<void> {
  try {
    await sendOrgSms(orgId, { to, body: text })
  } catch (err) {
    await db.outboxMessage.create({
      data: {
        orgId, channel: 'sms', recipient: to, subject: 'Consent confirmation', body: text,
        status: 'skipped',
        statusReason: `consent confirmation could not be sent: ${err instanceof Error ? err.message.slice(0, 160) : 'unknown error'}`,
        relatedType: 'conversation',
      },
    }).catch(() => {})
  }
}

export async function ingestInboundSms(input: {
  org: Organization
  from: string
  to: string
  body: string
  messageSid: string
  provider: string
}): Promise<IngestResult> {
  const { org, from, to, body, messageSid, provider } = input
  const customer = await matchCustomerByPhone(org.id, from)
  const keyword = consentKeyword(body)
  const receptionistStatus = normalizeReceptionistStatus(org.receptionistStatus)

  if (keyword && customer) {
    const conversation = await findOrCreateConversation(org.id, from, customer.name || from, customer.id)
    await db.message.create({
      data: {
        conversationId: conversation.id, orgId: org.id, role: 'customer', content: body,
        meta: JSON.stringify({ source: 'sms', provider, messageSid, keyword }),
      },
    })
    const optOut = keyword === 'stop'
    await db.customer.update({ where: { id: customer.id }, data: { optOut } })
    await audit({
      orgId: org.id, actorType: 'webhook', actorId: provider,
      action: optOut ? 'telephony.sms_opt_out' : 'telephony.sms_opt_in',
      entity: 'customer', entityId: customer.id,
      meta: { from, messageSid, previous: customer.optOut },
    })
    await sendConsentAck(
      org.id,
      from,
      optOut
        ? 'You are unsubscribed and will not receive further automated text messages. Reply START to resubscribe.'
        : 'You are resubscribed and will receive automated messages again. Reply STOP to opt out.'
    )
    return { conversationId: conversation.id, statusBefore: conversation.status, shouldReply: false, keyword }
  }

  if (receptionistStatus === 'stopped') {
    await audit({
      orgId: org.id, actorType: 'webhook', actorId: provider,
      action: 'telephony.sms_ignored', entity: 'organization', entityId: org.id,
      meta: { messageSid, from, to, reason: 'receptionist_stopped', preview: body.slice(0, 160) },
    })
    return { conversationId: null, statusBefore: '', shouldReply: false, keyword }
  }

  const conversation = await findOrCreateConversation(org.id, from, customer?.name || from, customer?.id ?? null)
  await audit({
    orgId: org.id, actorType: 'webhook', actorId: provider,
    action: 'telephony.sms_received', entity: 'conversation', entityId: conversation.id,
    meta: { messageSid, from, to, customerMatched: Boolean(customer) },
  })
  await db.message.create({
    data: {
      conversationId: conversation.id, orgId: org.id, role: 'customer', content: body,
      meta: JSON.stringify({ source: 'sms', provider, messageSid }),
    },
  })

  if (customer?.optOut || !conversation.aiEnabled) {
    return { conversationId: conversation.id, statusBefore: conversation.status, shouldReply: false, keyword }
  }
  return { conversationId: conversation.id, statusBefore: conversation.status, shouldReply: true, keyword }
}

export async function replyToInboundSms(input: {
  org: Organization
  conversationId: string
  body: string
  from: string
  statusBefore: string
}): Promise<void> {
  const { org, conversationId, body, from, statusBefore } = input
  const result = await handleReceptionistTurn(org, conversationId, body, { skipInboundPersist: true, channel: 'sms' })
  const fresh = await db.conversation.findUnique({ where: { id: conversationId } })
  if (statusBefore !== 'waiting_human' && fresh?.status === 'waiting_human') {
    await emitEvent(org.id, 'conversation_escalated', { conversationId, entityId: conversationId })
  }
  if (!result.reply) return

  try {
    const sent = await sendOrgSms(org.id, { to: from, body: result.reply })
    await audit({
      orgId: org.id, actorType: 'system', actorId: 'sms-receptionist', action: 'telephony.sms_reply_sent',
      entity: 'conversation', entityId: conversationId,
      meta: { to: from, chars: result.reply.length, provider: sent.provider },
    })
  } catch (sendErr) {
    await db.outboxMessage.create({
      data: {
        orgId: org.id, channel: 'sms', recipient: from, body: result.reply,
        status: 'queued', statusReason: `initial send failed: ${sendErr instanceof Error ? sendErr.message.slice(0, 200) : 'unknown'}`,
        relatedType: 'conversation', relatedId: conversationId,
      },
    })
    console.error('[telephony] SMS reply send failed (queued for retry):', sendErr instanceof Error ? sendErr.message : sendErr)
  }
}
