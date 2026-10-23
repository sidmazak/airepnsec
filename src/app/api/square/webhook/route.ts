import { withPublic, json, fail } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { processWebhook } from '@/lib/business/payments'
import { decryptSecrets, getUsableIntegration, integrationConfig, str } from '@/lib/integrations/connectors'
import { squareBase, squareHeaders, verifySquareSignature } from '@/lib/integrations/square'

const MAX_UNDESIGNATED_ORG_SCAN = 20

/**
 * POST /api/square/webhook — PUBLIC endpoint for Square callbacks.
 *
 * Signature: `x-square-hmacsha256-signature` is base64(HMAC-SHA256(key,
 * notificationUrl + rawBody)). The notification URL must match the one set in
 * Square; the integration config can override it.
 *
 * Org resolution: verify the signature against each org's Square integration
 * (or the org whose slug appears in the order metadata). The payment's order is
 * fetched from Square to read `metadata.invoice_id` / `invoice_number`.
 *
 * Handled events: payment.created / payment.updated with status COMPLETED.
 * Amounts are integer minor units and go through the idempotent verified-payment
 * path (overpay protection, ledger, invoice recalc).
 */
export const POST = withPublic(async (req) => {
  const raw = await req.text()
  const signature = req.headers.get('x-square-hmacsha256-signature')
  const fallbackNotificationUrl = `${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/api/square/webhook`

  type SquareEvent = {
    event_id?: unknown
    type?: unknown
    data?: { object?: { payment?: Record<string, unknown> } }
  }
  let event: SquareEvent
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    event = value as SquareEvent
  } catch {
    return fail(400, 'Webhook payload could not be parsed as JSON', { code: 'bad_json' })
  }

  const eventId = typeof event.event_id === 'string' ? event.event_id : ''
  const eventType = typeof event.type === 'string' ? event.type : ''
  if (!eventId || !eventType) return fail(400, 'Square payload is missing event_id or type', { code: 'bad_payload' })

  async function verifyForOrg(orgId: string): Promise<{ ok: boolean; notificationUrl: string }> {
    const integration = await getUsableIntegration(orgId, 'square')
    if (!integration) return { ok: false, notificationUrl: '' }
    const secrets = decryptSecrets(integration)
    const key = str(secrets, 'webhookSignatureKey')
    const notificationUrl = str(integrationConfig(integration), 'notificationUrl') || fallbackNotificationUrl
    if (!key) return { ok: false, notificationUrl }
    return { ok: verifySquareSignature(raw, signature, key, notificationUrl), notificationUrl }
  }

  const candidates = await db.integration.findMany({
    where: { kind: 'square', secretsEnc: { not: '' } },
    select: { orgId: true },
    take: MAX_UNDESIGNATED_ORG_SCAN,
  })
  let orgId = ''
  let notificationUrl = fallbackNotificationUrl
  for (const candidate of candidates) {
    const verified = await verifyForOrg(candidate.orgId)
    if (verified.ok) {
      orgId = candidate.orgId
      notificationUrl = verified.notificationUrl
      break
    }
  }
  if (!orgId) {
    return fail(400, 'Square webhook signature is invalid, or the square integration has no webhookSignatureKey configured', {
      code: 'invalid_signature',
    })
  }

  const payment = event.data?.object?.payment ?? {}
  const orderId = typeof payment.order_id === 'string' ? payment.order_id : ''
  const paymentId = typeof payment.id === 'string' ? payment.id : eventId
  const status = typeof payment.status === 'string' ? payment.status : ''
  const amountMoney = (payment.amount_money ?? {}) as { amount?: unknown; currency?: unknown }
  const amountCents = typeof amountMoney.amount === 'number' ? amountMoney.amount : -1
  const currency = typeof amountMoney.currency === 'string' ? amountMoney.currency : ''

  const reject = async (result: 'rejected' | 'received', note: string) => {
    await db.webhookEvent.upsert({
      where: { eventId },
      create: { orgId, provider: 'square', eventId, payload: raw.slice(0, 4000), signatureValid: true, result, processedAt: new Date() },
      update: { result, processedAt: new Date() },
    })
    await audit({ orgId, actorType: 'webhook', action: 'webhook.rejected', entity: 'webhook_event', meta: { provider: 'square', type: eventType, reason: note } })
  }

  if (!['payment.created', 'payment.updated'].includes(eventType)) {
    const existing = await db.webhookEvent.findUnique({ where: { eventId }, select: { id: true } })
    if (!existing) {
      await db.webhookEvent.create({
        data: { orgId, provider: 'square', eventId, payload: raw.slice(0, 4000), signatureValid: true, result: 'ignored', processedAt: new Date() },
      })
    }
    return json({ received: true, result: 'ignored', type: eventType })
  }

  if (status !== 'COMPLETED') {
    await reject('received', `payment status is ${status || 'unknown'} — not completed`)
    return json({ received: true, result: 'error', error: `Payment status ${status || 'unknown'} is not COMPLETED — payment not recorded` })
  }
  if (amountCents <= 0) {
    await reject('received', 'payment carries no positive amount')
    return json({ received: true, result: 'error', error: 'Payment carries no positive amount — not recorded' })
  }
  if (!orderId) {
    await reject('rejected', 'payment has no order_id')
    return json({ received: true, result: 'error', error: 'Payment has no order_id — cannot resolve the invoice' })
  }

  const integration = await getUsableIntegration(orgId, 'square')
  if (!integration) {
    await reject('rejected', 'square integration disappeared while processing')
    return json({ received: true, result: 'error', error: 'Square integration is not usable' })
  }
  const config = integrationConfig(integration)
  const secrets = decryptSecrets(integration)
  const accessToken = str(secrets, 'accessToken')

  let orderMeta: Record<string, unknown> = {}
  try {
    const res = await fetch(`${squareBase(str(config, 'environment'))}/v2/orders/${encodeURIComponent(orderId)}`, {
      headers: squareHeaders(accessToken),
      signal: AbortSignal.timeout(10_000),
    })
    const data = (await res.json().catch(() => ({}))) as { order?: { metadata?: Record<string, unknown> }; errors?: Array<{ detail?: string }> }
    if (!res.ok) throw new Error(data.errors?.[0]?.detail || `Square HTTP ${res.status}`)
    orderMeta = data.order?.metadata ?? {}
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Square order lookup failed'
    await reject('received', message)
    return json({ received: true, result: 'error', error: message })
  }

  const invoiceIdMeta = typeof orderMeta.invoice_id === 'string' ? orderMeta.invoice_id : ''
  const invoiceNumberMeta = typeof orderMeta.invoice_number === 'string' ? orderMeta.invoice_number : ''
  const orgSlugMeta = typeof orderMeta.org_slug === 'string' ? orderMeta.org_slug : ''
  if (orgSlugMeta) {
    const org = await db.organization.findUnique({ where: { slug: orgSlugMeta }, select: { id: true } })
    if (!org || org.id !== orgId) {
      await reject('rejected', 'order org_slug does not match the verified organization')
      return json({ received: true, result: 'error', error: 'Order org_slug does not match the verified organization' })
    }
  }

  let invoice: { id: string; number: string; currency: string } | null = null
  if (invoiceIdMeta) invoice = await db.invoice.findFirst({ where: { id: invoiceIdMeta, orgId } })
  if (!invoice && invoiceNumberMeta) invoice = await db.invoice.findFirst({ where: { number: invoiceNumberMeta, orgId } })
  if (!invoice) {
    await reject('rejected', 'order metadata carries no invoice_id/invoice_number matching an invoice')
    return json({ received: true, result: 'error', error: 'No invoice reference found in the Square order metadata' })
  }
  if (currency && invoice.currency && currency.toLowerCase() !== invoice.currency.toLowerCase()) {
    await reject('rejected', `currency mismatch: payment ${currency} vs invoice ${invoice.currency}`)
    return json({ received: true, result: 'error', error: `Payment currency ${currency} does not match invoice currency ${invoice.currency}` })
  }

  try {
    const result = await processWebhook(
      orgId,
      'square',
      { eventId, invoiceNumber: invoice.number, amountCents, method: 'card', reference: paymentId },
      raw,
      true
    )
    return json({ received: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Webhook could not be processed'
    await reject('rejected', message)
    return json({ received: true, result: 'error', error: message })
  }
})
