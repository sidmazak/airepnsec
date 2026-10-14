import { withPublic, json, fail, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import {
  parseWebhookPayload,
  processWebhook,
  getWebhookSecret,
  verifyWebhookSignature,
} from '@/lib/business/payments'

/**
 * POST /api/payments/webhook — PUBLIC endpoint for payment-provider callbacks.
 * The org is resolved from `org_slug` (or `orgSlug`) inside the JSON payload.
 * The raw body + `x-signature` header are HMAC-verified against the org secret;
 * nothing is ever processed without a valid signature. Business validation
 * failures are reported honestly (202 result:'error') — this endpoint never
 * 500s on business outcomes so providers don't retry storms on validation.
 */
export const POST = withPublic(async (req) => {
  const raw = await req.text()
  const signature = req.headers.get('x-signature')

  let parsed: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    parsed = value as Record<string, unknown>
  } catch {
    return fail(401, 'Webhook payload could not be parsed as JSON', { code: 'bad_json' })
  }

  const orgSlug =
    typeof parsed.org_slug === 'string' ? parsed.org_slug : typeof parsed.orgSlug === 'string' ? parsed.orgSlug : ''
  if (!orgSlug) {
    return fail(400, 'Webhook payload is missing org_slug', { code: 'bad_payload' })
  }

  const org = await db.organization.findUnique({ where: { slug: orgSlug } })
  if (!org) {
    return fail(404, `No organization found for slug "${orgSlug}"`, { code: 'org_not_found' })
  }

  const secret = await getWebhookSecret(org.id)
  const signatureValid = verifyWebhookSignature(raw, signature, secret)

  try {
    const payload = parseWebhookPayload(raw)
    const result = await processWebhook(org.id, 'generic', payload, raw, signatureValid)
    return json(result, 202)
  } catch (err) {
    if (err instanceof ApiError) {
      // Real business outcomes the caller should see as statuses:
      if (err.code === 'invoice_not_found' || err.code === 'overpay') {
        return fail(err.status, err.message, { code: err.code, ...(err.extra ?? {}) })
      }
      return json({ result: 'error', error: err.message }, 202)
    }
    return json({ result: 'error', error: 'Webhook could not be processed' }, 202)
  }
})
