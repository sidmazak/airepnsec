import crypto from 'node:crypto'
import { NextRequest } from 'next/server'
import { withPublic, json, fail } from '@/lib/api'
import { db } from '@/lib/db'
import { handleImapWebhook } from '@/lib/integrations/imap'
import { decryptSecrets, integrationConfig, str } from '@/lib/integrations/connectors'
import { logWebhook, plainResponse } from '@/lib/telephony/twiml'

export const pathname = '/api/telephony/imap/webhook'

function safeEqual(a: string, b: string): boolean {
  const left = crypto.createHash('sha256').update(a).digest()
  const right = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(left, right)
}

/**
 * POST /api/telephony/imap/webhook — real-time inbound-email notifications from
 * email providers (Mailgun, Postmark, SendGrid, …).
 *
 * The integration is addressed explicitly with `?integration=<id>` (shown in the
 * Integrations UI) or the `x-ais-integration-id` header. Every request must carry
 * the per-integration `x-webhook-secret`; unsigned webhooks are rejected. When the
 * provider cannot add a header, put the secret in the URL as `&secret=…`.
 */
export const POST = withPublic(async (req: NextRequest) => {
  const contentType = req.headers.get('content-type') || ''
  let payload: Record<string, unknown> = {}

  if (contentType.includes('application/json')) {
    payload = (await req.json().catch(() => ({}))) as Record<string, unknown>
  } else if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const form = await req.formData()
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') payload[key] = value
    }
  } else {
    const text = await req.text()
    try {
      payload = JSON.parse(text) as Record<string, unknown>
    } catch {
      payload = { raw: text }
    }
  }

  const payloadStr: Record<string, string> = {}
  for (const [key, value] of Object.entries(payload)) {
    payloadStr[key] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  const eventId = `webhook:${payload.MessageId || payload.message_id || payload['Message-ID'] || `unknown-${Date.now()}`}`

  const integrationId = req.nextUrl.searchParams.get('integration')
    || req.headers.get('x-ais-integration-id')
    || ''

  let row = integrationId
    ? await db.integration.findFirst({ where: { id: integrationId, kind: 'imap', enabled: true } })
    : null

  if (!row) {
    // Backwards-compatible discovery: match the monitored mailbox domain.
    const fromDomain = ((payload.from || payload.From || payload.sender || '') as string).split('@').pop()?.toLowerCase()
    if (fromDomain) {
      const candidates = await db.integration.findMany({ where: { kind: 'imap', enabled: true } })
      for (const candidate of candidates) {
        const username = str(integrationConfig(candidate), 'username').toLowerCase()
        if (username.endsWith(`@${fromDomain}`)) {
          row = candidate
          break
        }
      }
    }
  }

  if (!row) return plainResponse(404, 'No enabled IMAP integration found for this webhook')

  const secrets = decryptSecrets(row)
  const expected = str(secrets, 'webhookSecret')
  if (!expected) {
    return plainResponse(503, 'This IMAP integration has no webhook secret configured — add one in Integrations to accept webhooks')
  }
  const provided = req.headers.get('x-webhook-secret')
    || req.headers.get('x-webhook-signature')
    || req.nextUrl.searchParams.get('secret')
    || ''
  if (!provided || !safeEqual(provided, expected)) {
    await logWebhook({
      orgId: row.orgId,
      provider: 'imap',
      eventId,
      payload: payloadStr,
      signatureValid: false,
      result: 'rejected',
    })
    return plainResponse(403, 'Invalid webhook secret')
  }

  const { duplicate } = await logWebhook({
    orgId: row.orgId,
    provider: 'imap',
    eventId,
    payload: payloadStr,
    signatureValid: true,
    result: 'received',
  })
  if (duplicate) return json({ ok: true, detail: 'duplicate webhook ignored' })

  const result = await handleImapWebhook(row.orgId, row, payload)
  if (!result.ok && result.detail === 'No message-id in webhook payload') {
    return fail(422, result.detail, { code: 'bad_payload' })
  }
  return json({ ok: result.ok, detail: result.detail })
}, { rateLimit: { limit: 300 } })
