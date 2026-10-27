import { NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db'
import { withPublic, json, fail } from '@/lib/api'
import { audit } from '@/lib/audit'
import { getWebhookSecret } from '@/lib/business/payments'
import { logWebhook } from '@/lib/telephony/twiml'
import { applyDeliveryReceipt, type DeliveryState } from '@/lib/integrations/delivery'

export const pathname = '/api/telephony/sms/dlr'

function pick(payload: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return ''
}

function nestedStatus(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return pick(row, ['groupName', 'group', 'name', 'status', 'description', 'state'])
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

async function parsePayload(req: NextRequest): Promise<unknown> {
  const contentType = req.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) return req.json().catch(() => null)
  if (contentType.includes('form')) {
    const form = await req.formData().catch(() => null)
    if (!form) return null
    const out: Record<string, unknown> = {}
    form.forEach((value, key) => { if (typeof value === 'string') out[key] = value })
    return out
  }
  const text = await req.text().catch(() => '')
  if (!text) return null
  try { return JSON.parse(text) } catch { return { status: text } }
}

function receiptRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
  if (!payload || typeof payload !== 'object') return []
  const obj = payload as Record<string, unknown>
  for (const key of ['results', 'messages', 'data', 'items', 'deliveryReports']) {
    const value = obj[key]
    if (Array.isArray(value)) return value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
  }
  return [obj]
}

/**
 * POST /api/telephony/sms/dlr?org=<slug>&provider=<sinch|infobip|clicksend|...>
 *
 * Signed carrier delivery-report webhook for BYO SMS gateways. Authentication
 * is the org webhook secret (`x-webhook-secret` or `?secret=`), the same
 * mechanism as inbound SMS. The payload may be:
 *   - Infobip: `{results:[{messageId, status:{groupName, description}}]}`
 *   - ClickSend: `{message_id, status}` or an array of those rows
 *   - Sinch: `{messageId, status}` / `{type:'delivery_report', ...}`
 *   - generic: `{id|messageId, status|deliveryStatus, detail?}`
 * Each row is matched to the outbox row by provider message id. No match is
 * reported honestly as ignored; nothing is invented.
 */
export const POST = withPublic(async (req: NextRequest) => {
  const url = new URL(req.url)
  const slug = (url.searchParams.get('org') ?? '').trim().toLowerCase()
  const provider = (url.searchParams.get('provider') ?? '').trim().toLowerCase()
  if (!slug) return fail(400, 'Missing ?org=<org slug> query parameter', { code: 'missing_org' })

  const org = await db.organization.findUnique({ where: { slug } })
  if (!org) return fail(404, 'Organization not found', { code: 'not_found' })

  const stored = (await getWebhookSecret(org.id)).trim()
  if (!stored) return fail(503, 'No webhook secret is configured — generate one in Integrations → Inbound webhooks', { code: 'no_secret' })

  const provided = (req.headers.get('x-webhook-secret') ?? url.searchParams.get('secret') ?? '').trim()
  if (!secretMatches(provided, stored)) return fail(403, 'Invalid webhook secret', { code: 'invalid_secret' })

  const payload = await parsePayload(req)
  const rows = receiptRows(payload)
  if (rows.length === 0) return fail(400, 'Payload has no delivery rows', { code: 'invalid_payload' })

  let updated = 0
  let ignored = 0
  const states: DeliveryState[] = []
  for (const row of rows) {
    const messageId = pick(row, ['messageId', 'message_id', 'MessageSid', 'sid', 'id', 'messageUuid', 'message_uuid'])
    const rawStatus = nestedStatus(row.status) || pick(row, ['MessageStatus', 'deliveryStatus', 'status_text', 'statusText', 'event', 'state'])
    const nestedDetail = row.status && typeof row.status === 'object'
      ? pick(row.status as Record<string, unknown>, ['description', 'reason', 'message', 'details', 'error'])
      : ''
    const detail = nestedDetail || pick(row, ['detail', 'description', 'reason', 'error', 'status_text', 'statusText'])
    if (!messageId || !rawStatus) { ignored++; continue }

    const eventId = `${org.id}:dlr:${provider || 'gateway'}:${messageId}:${rawStatus}`.slice(0, 180)
    const { duplicate } = await logWebhook({
      orgId: org.id, provider: `sms_dlr_${provider || 'gateway'}`, eventId,
      payload: records(row), signatureValid: true, result: 'received',
    })
    if (duplicate) { ignored++; continue }

    const result = await applyDeliveryReceipt({
      orgId: org.id,
      providerKind: provider || undefined,
      providerMessageId: messageId,
      rawStatus,
      detail,
    })
    updated += result.updated
    if (result.updated === 0) ignored++
    if (result.state) states.push(result.state)
    if (result.state === 'failed') {
      await audit({
        orgId: org.id, actorType: 'webhook', actorId: `sms_dlr_${provider || 'gateway'}`,
        action: 'telephony.delivery_failed', entity: 'outbox_message', entityId: messageId,
        meta: { provider: provider || 'gateway', status: rawStatus, detail: detail.slice(0, 200) },
      })
    }
    await db.webhookEvent.updateMany({
      where: { orgId: org.id, provider: `sms_dlr_${provider || 'gateway'}`, eventId },
      data: { result: 'processed', processedAt: new Date() },
    })
  }

  return json({ ok: true, updated, ignored, states })
}, { rateLimit: { limit: 300 } })
