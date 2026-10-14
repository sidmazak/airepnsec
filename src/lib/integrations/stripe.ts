import crypto from 'node:crypto'
import { db } from '@/lib/db'
import { decryptSecret } from '@/lib/crypto'
import { getEnabledIntegration, getUsableIntegration, sanitizeMessage } from '@/lib/integrations/connectors'

/**
 * Real Stripe operations shared by the API routes, the outbox dispatcher and the
 * collections automations. Uses the org's enabled Stripe integration (BYOK).
 */

/** The org's enabled Stripe integration, or null when Stripe is not enabled. */
export async function getEnabledStripe(orgId: string) {
  return getEnabledIntegration(orgId, 'stripe')
}

export type PaymentLinkInput = {
  invoiceId: string
  invoiceNumber: string
  currency: string
  orgId: string
}

/**
 * Create a REAL Stripe Payment Link for the outstanding amount of an invoice.
 * `outstandingCents` is passed through as Stripe `unit_amount` (minor units —
 * the ledger models money as integer minor units already).
 * Throws an Error (sanitized) on any Stripe-side failure.
 */
export async function createStripePaymentLink(
  orgId: string,
  invoice: { id: string; number: string; currency: string },
  outstandingCents: number
): Promise<{ url: string; id: string }> {
  if (!Number.isInteger(outstandingCents) || outstandingCents <= 0) {
    throw new Error('Payment link amount must be a positive integer (minor units)')
  }
  const integration = await getEnabledStripe(orgId)
  if (!integration) throw new Error('Stripe integration is not enabled')

  const secrets = JSON.parse(decryptSecret(integration.secretsEnc) || '{}') as { secretKey?: string }
  const secretKey = (secrets.secretKey ?? '').trim()
  if (!secretKey) throw new Error('Stripe integration has no secret key')

  const org = await db.organization.findUnique({ where: { id: orgId }, select: { slug: true, name: true } })
  if (!org) throw new Error('Organization not found')

  const form = new URLSearchParams({
    'line_items[0][price_data][currency]': invoice.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(outstandingCents),
    'line_items[0][price_data][product_data][name]': `Invoice ${invoice.number} — ${org.name}`,
    'line_items[0][quantity]': '1',
    'metadata[org_slug]': org.slug,
    'metadata[invoice_id]': invoice.id,
    'metadata[invoice_number]': invoice.number,
  })

  try {
    const res = await fetch('https://api.stripe.com/v1/payment_links', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(15_000),
    })
    const data = (await res.json().catch(() => ({}))) as { id?: string; url?: string; error?: { message?: string } }
    if (!res.ok || !data.url || !data.id) {
      throw new Error(sanitizeMessage(data.error?.message ? `Stripe error ${res.status}: ${data.error.message}` : `Stripe HTTP ${res.status} ${res.statusText}`, integration))
    }
    return { url: data.url, id: data.id }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Stripe')) throw err
    throw new Error(sanitizeMessage(err instanceof Error ? err.message : String(err), integration))
  }
}

/**
 * Verify a Stripe webhook `Stripe-Signature` header against the raw body.
 * Header format: `t=<timestamp>,v1=<hex>,v1=<hex>...` — the signature is
 * HMAC-SHA256 over `${t}.${rawBody}` with the webhook signing secret. Any of
 * the listed v1 signatures matching (timing-safe) counts as valid.
 */
export function verifyStripeSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || !secret) return false
  const parts = header.split(',')
  let timestamp = ''
  const signatures: string[] = []
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === 't') timestamp = value
    else if (key === 'v1') signatures.push(value)
  }
  if (!timestamp || signatures.length === 0) return false
  try {
    const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
    return signatures.some((sig) => {
      const a = Buffer.from(expected, 'hex')
      const b = Buffer.from(sig, 'hex')
      return a.length === b.length && crypto.timingSafeEqual(a, b)
    })
  } catch {
    return false
  }
}

export { getUsableIntegration }
