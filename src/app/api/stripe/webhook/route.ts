import { withPublic, json, fail } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { processWebhook } from '@/lib/business/payments'
import { decryptSecrets, getUsableIntegration } from '@/lib/integrations/connectors'
import { verifyStripeSignature } from '@/lib/integrations/stripe'

/** Upper bound for the "no org slug in metadata" fallback scan. */
const MAX_UNDESIGNATED_ORG_SCAN = 20

/**
 * POST /api/stripe/webhook — PUBLIC endpoint for Stripe callbacks.
 *
 * Signature: `Stripe-Signature: t=...,v1=...` is HMAC-SHA256 over
 * `${t}.${rawBody}` with the stripe integration's webhookSecret — verified with
 * timing-safe comparison; anything else is rejected with 400.
 *
 * Org resolution: `data.object.metadata.org_slug` first (payment links we mint
 * always carry it); otherwise every org's stripe integration is tried and the
 * one whose webhookSecret verifies the signature wins.
 *
 * Handled events: checkout.session.completed, payment_intent.succeeded → a
 * VERIFIED payment is recorded through the exact same idempotent path as the
 * generic webhook (recordVerifiedPayment: overpay protection, ledger entry,
 * invoice recalc). Amounts arrive in minor units — passed through as-is.
 */
export const POST = withPublic(async (req) => {
  const raw = await req.text()
  const sigHeader = req.headers.get('stripe-signature')

  type StripeEvent = {
    id?: unknown
    type?: unknown
    data?: { object?: Record<string, unknown> & { metadata?: Record<string, unknown> } }
  }
  let event: StripeEvent
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    event = value as StripeEvent
  } catch {
    return fail(400, 'Webhook payload could not be parsed as JSON', { code: 'bad_json' })
  }

  const eventId = typeof event.id === 'string' ? event.id : ''
  const eventType = typeof event.type === 'string' ? event.type : ''
  if (!eventId || !eventType) {
    return fail(400, 'Stripe payload is missing id or type', { code: 'bad_payload' })
  }

  const metadata = event.data?.object?.metadata ?? {}
  const orgSlug = typeof metadata.org_slug === 'string' ? metadata.org_slug : ''

  /* -------- resolve org + verify signature -------- */

  async function verifyForOrg(orgId: string): Promise<boolean> {
    const integration = await getUsableIntegration(orgId, 'stripe')
    if (!integration) return false
    const secrets = decryptSecrets(integration)
    const secret = (secrets.webhookSecret ?? '').trim()
    if (!secret) return false
    // Stripe signs with a 5 minute tolerance - an older timestamp is a replay.
    return verifyStripeSignature(raw, sigHeader, secret, 10 * 60_000)
  }

  let orgId = ''
  if (orgSlug) {
    const org = await db.organization.findUnique({ where: { slug: orgSlug }, select: { id: true } })
    if (org && (await verifyForOrg(org.id))) orgId = org.id
  } else {
    // No slug in the metadata: try every configured Stripe integration. The scan
    // is capped so an unsigned request cannot turn into an O(orgs) crypto DoS.
    const candidates = await db.integration.findMany({
      where: { kind: 'stripe', secretsEnc: { not: '' } },
      select: { orgId: true },
      take: MAX_UNDESIGNATED_ORG_SCAN,
    })
    for (const candidate of candidates) {
      if (await verifyForOrg(candidate.orgId)) {
        orgId = candidate.orgId
        break
      }
    }
  }

  if (!orgId) {
    return fail(400, 'Stripe webhook signature is invalid, or the stripe integration has no webhook secret configured', {
      code: 'invalid_signature',
    })
  }

  /* -------- dedupe by Stripe event id -------- */

  const HANDLED = ['checkout.session.completed', 'payment_intent.succeeded']
  if (!HANDLED.includes(eventType)) {
    // Not a payment event: record it once and move on. processWebhook owns the
    // lifecycle of payment events (dedupe + retry semantics); ignored events
    // never reach it.
    const existing = await db.webhookEvent.findUnique({ where: { eventId }, select: { id: true } })
    if (!existing) {
      await db.webhookEvent.create({
        data: { orgId, provider: 'stripe', eventId, payload: raw.slice(0, 4000), signatureValid: true, result: 'ignored', processedAt: new Date() },
      })
    }
    return json({ received: true, result: 'ignored', type: eventType })
  }

  /* -------- map the Stripe event to a verified payment -------- */

  const obj = event.data?.object ?? {}
  const amountRaw = eventType === 'checkout.session.completed' ? obj.amount_total : obj.amount_received
  const amountCents = typeof amountRaw === 'number' ? amountRaw : -1
  const currency = typeof obj.currency === 'string' ? obj.currency : ''
  const stripeObjectRef = typeof obj.id === 'string' ? obj.id : ''

  const rejectRow = async (result: 'rejected' | 'received', note: string) => {
    // upsert: processWebhook may already have created the row for this event id
    await db.webhookEvent.upsert({
      where: { eventId },
      create: { orgId, provider: 'stripe', eventId, payload: raw.slice(0, 4000), signatureValid: true, result, processedAt: new Date() },
      update: { result, processedAt: new Date() },
    })
    await audit({ orgId, actorType: 'webhook', action: 'webhook.rejected', entity: 'webhook_event', meta: { provider: 'stripe', type: eventType, reason: note } })
  }

  const invoiceIdMeta = typeof metadata.invoice_id === 'string' ? metadata.invoice_id : ''
  const invoiceNumberMeta = typeof metadata.invoice_number === 'string' ? metadata.invoice_number : ''

  let invoice: { id: string; number: string; currency: string } | null = null
  if (invoiceIdMeta) invoice = await db.invoice.findFirst({ where: { id: invoiceIdMeta, orgId } })
  if (!invoice && invoiceNumberMeta) invoice = await db.invoice.findFirst({ where: { number: invoiceNumberMeta, orgId } })

  if (!invoice) {
    await rejectRow('rejected', 'payload metadata carries no invoice_id/invoice_number matching an invoice')
    return json({ received: true, result: 'error', error: 'No invoice reference found in the event metadata' })
  }

  if (amountCents <= 0) {
    await rejectRow('received', `amount not received yet (${eventType}, amount=${String(amountRaw)})`)
    return json({ received: true, result: 'error', error: 'Event carries no positive amount — payment not recorded' })
  }

  if (currency && invoice.currency && currency.toLowerCase() !== invoice.currency.toLowerCase()) {
    await rejectRow('rejected', `currency mismatch: event ${currency} vs invoice ${invoice.currency}`)
    return json({ received: true, result: 'error', error: `Event currency ${currency} does not match invoice currency ${invoice.currency}` })
  }

  const payload = {
    eventId,
    invoiceNumber: invoice.number,
    amountCents,
    method: 'card' as const,
    reference: stripeObjectRef || eventId,
  }

  try {
    const result = await processWebhook(orgId, 'stripe', payload, raw, true)
    return json({ received: true, ...result })
  } catch (err) {
    // Business failure (e.g. overpay) — answer 200 honestly so Stripe does not retry-storm.
    const message = err instanceof Error ? err.message : 'Webhook could not be processed'
    await rejectRow('rejected', message)
    return json({ received: true, result: 'error', error: message })
  }
})
