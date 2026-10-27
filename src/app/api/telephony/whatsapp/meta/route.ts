import { NextRequest, after } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { notifyEscalation } from '@/lib/notifications/staff'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { withPublic } from '@/lib/api'
import { handleReceptionistTurn } from '@/lib/ai/receptionist'
import { emitEvent } from '@/lib/automation/engine'
import { integrationConfig, decryptSecrets, str, sendMetaWhatsApp, sanitizeMessage } from '@/lib/integrations/connectors'
import { resolveReceptionistStatus } from '@/lib/receptionist/runtime'
import { matchCustomerByPhone, logWebhook, plainResponse } from '@/lib/telephony/twiml'

export const pathname = '/api/telephony/whatsapp/meta'

type MetaMessage = {
  from?: string
  id?: string
  type?: string
  text?: { body?: string }
}

type MetaPayload = {
  object?: string
  entry?: Array<{
    changes?: Array<{
      field?: string
      value?: {
        metadata?: { phone_number_id?: string; display_phone_number?: string }
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>
        messages?: MetaMessage[]
      }
    }>
  }>
}

function waThreadKey(from: string): string {
  return `whatsapp:${from.replace(/\D/g, '')}`
}

function cleanProfileName(raw: string): string {
  return raw
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[\u0000-\u001F]/g, '')
    .trim()
    .slice(0, 80)
}

function validSignature(rawBody: string, appSecret: string, header: string | null): boolean {
  if (!appSecret || !header?.startsWith('sha256=')) return false
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')
  const received = header.slice('sha256='.length)
  if (received.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    return false
  }
}

async function findIntegration(phoneNumberId: string) {
  const rows = await db.integration.findMany({ where: { kind: 'meta_whatsapp', enabled: true } })
  return rows.find((row) => str(integrationConfig(row), 'phoneNumberId') === phoneNumberId) ?? null
}

async function ingest(
  integration: { kind: string; configJson: string; secretsEnc: string; orgId: string },
  from: string, profileName: string, body: string, messageId: string,
) {
  const orgId = integration.orgId
  const org = await db.organization.findUnique({ where: { id: orgId } })
  if (!org || !body.trim()) return
  const receptionistStatus = (await resolveReceptionistStatus(org)).status
  if (receptionistStatus === 'stopped') {
    await audit({
      orgId: org.id, actorType: 'webhook', actorId: 'meta_whatsapp',
      action: 'telephony.whatsapp_ignored', entity: 'organization', entityId: org.id,
      meta: { messageId, from, reason: 'receptionist_stopped', preview: body.slice(0, 160) },
    })
    return
  }

  const customer = await matchCustomerByPhone(org.id, from)
  let conversation = await db.conversation.findFirst({
    where: { orgId: org.id, channel: 'whatsapp', externalRef: waThreadKey(from) },
  })
  if (!conversation) {
    conversation = await db.conversation.create({
      data: {
        orgId: org.id, channel: 'whatsapp', status: 'open',
        contactName: customer?.name || profileName || from,
        customerId: customer?.id ?? null, externalRef: waThreadKey(from),
      },
    })
  }

  await audit({
    orgId: org.id, actorType: 'webhook', actorId: 'meta_whatsapp',
    action: 'telephony.whatsapp_received', entity: 'conversation', entityId: conversation.id,
    meta: { messageId, from, customerMatched: Boolean(customer) },
  })

  await db.message.create({
    data: { conversationId: conversation.id, orgId: org.id, role: 'customer', content: body, meta: JSON.stringify({ source: 'whatsapp', provider: 'meta', messageId }) },
  })

  if (customer?.optOut || !conversation.aiEnabled) return

  const conversationId = conversation.id
  const statusBefore = conversation.status
  after(async () => {
    try {
      const result = await handleReceptionistTurn(org, conversationId, body, { skipInboundPersist: true, channel: 'whatsapp' })
      const fresh = await db.conversation.findUnique({ where: { id: conversationId } })
      if (statusBefore !== 'waiting_human' && fresh?.status === 'waiting_human') {
        await emitEvent(org.id, 'conversation_escalated', { conversationId, entityId: conversationId })
        await notifyEscalation(org.id, conversationId, 'WhatsApp')
      }
      if (!result.reply) return

      try {
        await sendMetaWhatsApp(integration, { to: from, body: result.reply })
        await audit({ orgId: org.id, actorType: 'system', actorId: 'whatsapp-receptionist', action: 'telephony.whatsapp_reply_sent', entity: 'conversation', entityId: conversationId, meta: { to: from, provider: 'meta', chars: result.reply.length } })
      } catch (sendErr) {
        await db.outboxMessage.create({
          data: {
            orgId: org.id, channel: 'whatsapp', recipient: from, body: result.reply,
            status: 'queued', statusReason: `initial send failed: ${sanitizeMessage(sendErr instanceof Error ? sendErr.message : String(sendErr), integration).slice(0, 200)}`,
            relatedType: 'conversation', relatedId: conversationId,
          },
        })
        console.error('[telephony] Meta WhatsApp reply send failed (queued for retry):', sendErr instanceof Error ? sendErr.message : sendErr)
      }
    } catch (err) {
      console.error('[telephony] Meta WhatsApp turn failed:', err instanceof Error ? err.message : err)
    }
  })
}

/**
 * GET /api/telephony/whatsapp/meta — Meta webhook verification handshake.
 * PUT the same callback URL in the Meta App Dashboard and subscribe to `messages`.
 */
export const GET = withPublic(async (req: NextRequest) => {
  const url = new URL(req.url)
  const mode = url.searchParams.get('hub.mode') ?? ''
  const token = url.searchParams.get('hub.verify_token') ?? ''
  const challenge = url.searchParams.get('hub.challenge') ?? ''
  if (mode !== 'subscribe' || !token) return plainResponse(403, 'Forbidden')

  const rows = await db.integration.findMany({ where: { kind: 'meta_whatsapp', enabled: true } })
  const match = rows.find((row) => {
    const expected = str(integrationConfig(row), 'verifyToken')
    return expected.length >= 8 && expected === token
  })
  if (!match) return plainResponse(403, 'Forbidden')
  return plainResponse(200, challenge)
}, { rateLimit: { limit: 120 } })

/**
 * POST /api/telephony/whatsapp/meta — Meta WhatsApp Cloud API webhook.
 * Verifies `x-hub-signature-256` with the app secret (mandatory), dedupes by
 * message id, persists inbound text immediately, then answers via the AI.
 */
export const POST = withPublic(async (req: NextRequest) => {
  const raw = await req.text()
  let payload: MetaPayload
  try {
    payload = JSON.parse(raw) as MetaPayload
  } catch {
    return plainResponse(400, 'Invalid JSON')
  }
  if (payload.object !== 'whatsapp_business_account') return plainResponse(400, 'Unsupported object')

  const phoneNumberId = payload.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id ?? ''
  if (!phoneNumberId) return plainResponse(400, 'Missing phone_number_id')
  const integration = await findIntegration(phoneNumberId)
  if (!integration) return plainResponse(404, 'No enabled Meta WhatsApp integration owns this number')

  const secrets = decryptSecrets(integration)
  const appSecret = str(secrets, 'appSecret')
  const signature = req.headers.get('x-hub-signature-256')
  const signatureValid = validSignature(raw, appSecret, signature)
  if (!signatureValid) {
    await logWebhook({
      orgId: integration.orgId, provider: 'meta_whatsapp',
      eventId: `sig:${(payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id) ?? Date.now()}`,
      payload: { phoneNumberId, signature: signature ?? '' }, signatureValid: false, result: 'rejected',
    })
    return plainResponse(403, 'Invalid signature')
  }

  const org = await db.organization.findUnique({ where: { id: integration.orgId } })
  if (!org) return plainResponse(404, 'Organization not found')

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue
      const value = change.value
      const profileName = cleanProfileName(value?.contacts?.[0]?.profile?.name ?? '')
      for (const message of value?.messages ?? []) {
        const id = message.id ?? ''
        const from = message.from ?? ''
        if (!id || !from) continue
        const { duplicate } = await logWebhook({
          orgId: org.id, provider: 'meta_whatsapp', eventId: id,
          payload: { id, from, type: message.type ?? '', text: (message.text?.body ?? '').slice(0, 500) },
          signatureValid: true, result: 'received',
        })
        if (duplicate) continue
        if (message.type !== 'text' || !message.text?.body) {
          await audit({ orgId: org.id, actorType: 'webhook', actorId: 'meta_whatsapp', action: 'telephony.whatsapp_unsupported', entity: 'organization', entityId: org.id, meta: { id, from, type: message.type ?? 'unknown' } })
          continue
        }
        try {
          await ingest(integration, from, profileName, message.text?.body ?? '', id)
        } catch (err) {
          console.error('[telephony] Meta WhatsApp ingest failed:', err instanceof Error ? err.message : err)
        }
      }
    }
  }

  return plainResponse(200, 'OK')
}, { rateLimit: { limit: 300 } })
