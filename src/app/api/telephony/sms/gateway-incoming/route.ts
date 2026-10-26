import { NextRequest, after } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db'
import { withPublic, json, fail } from '@/lib/api'
import { getWebhookSecret } from '@/lib/business/payments'
import { logWebhook } from '@/lib/telephony/twiml'
import { ingestInboundSms, replyToInboundSms } from '@/lib/telephony/inboundSms'

export const pathname = '/api/telephony/sms/gateway-incoming'

function pick(payload: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return ''
}

function records(payload: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = String(value)
  }
  return out
}

function secretMatches(provided: string, stored: string): boolean {
  if (!provided || !stored) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(stored)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

async function parsePayload(req: NextRequest): Promise<Record<string, unknown>> {
  const contentType = req.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const body = await req.json().catch(() => null)
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
  }
  if (contentType.includes('form')) {
    const form = await req.formData().catch(() => null)
    if (!form) return {}
    const out: Record<string, unknown> = {}
    form.forEach((value, key) => { if (typeof value === 'string') out[key] = value })
    return out
  }
  const text = await req.text().catch(() => '')
  return text ? { message: text } : {}
}

export const POST = withPublic(async (req: NextRequest) => {
  const url = new URL(req.url)
  const slug = (url.searchParams.get('org') ?? '').trim().toLowerCase()
  if (!slug) return fail(400, 'Missing ?org=<org slug> query parameter', { code: 'missing_org' })

  const org = await db.organization.findUnique({ where: { slug } })
  if (!org) return fail(404, 'Organization not found', { code: 'not_found' })

  const stored = (await getWebhookSecret(org.id)).trim()
  if (!stored) return fail(503, 'No webhook secret is configured — generate one in Integrations → Inbound webhook', { code: 'no_secret' })

  const provided = (req.headers.get('x-webhook-secret') ?? url.searchParams.get('secret') ?? '').trim()
  if (!secretMatches(provided, stored)) return fail(403, 'Invalid webhook secret', { code: 'invalid_secret' })

  const payload = await parsePayload(req)
  const from = pick(payload, ['from', 'From', 'sender', 'originator', 'phone', 'source'])
  const to = pick(payload, ['to', 'To', 'recipient', 'destination'])
  const body = pick(payload, ['body', 'Body', 'message', 'Message', 'text', 'content', 'sms'])
  const messageSid = pick(payload, ['id', 'messageId', 'message_id', 'MessageSid', 'sid', 'uuid'])

  if (!from || !body) return fail(400, 'Payload needs a sender ("from") and a message body', { code: 'invalid_payload' })

  const eventId = `${org.id}:${messageSid || `${from}:${to}:${body.slice(0, 80)}`}`
  const { duplicate } = await logWebhook({
    orgId: org.id, provider: 'sms_gateway', eventId,
    payload: records(payload), signatureValid: true, result: 'received',
  })
  if (duplicate) return json({ ok: true, duplicate: true })

  const ingested = await ingestInboundSms({
    org, from, to: to || 'gateway', body: body.slice(0, 4000), messageSid: messageSid || eventId, provider: 'sms_gateway',
  })

  if (ingested.shouldReply && ingested.conversationId) {
    const conversationId = ingested.conversationId
    after(async () => {
      try {
        await replyToInboundSms({ org, conversationId, body, from, statusBefore: ingested.statusBefore })
      } catch (err) {
        console.error('[telephony] gateway SMS turn failed:', err instanceof Error ? err.message : err)
      }
    })
  }

  return json({ ok: true, accepted: true, keyword: ingested.keyword, replyQueued: ingested.shouldReply })
}, { rateLimit: { limit: 300 } })
