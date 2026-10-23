import crypto from 'node:crypto'

/**
 * Pure Square helpers (no DB / env imports) so they can be unit tested with
 * Node's type stripping. The live connector imports these.
 */

export type SquareEnvironment = 'production' | 'sandbox'

export function squareBase(environment: string | undefined): string {
  return environment === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com'
}

export function squareHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'square-version': '2024-10-17',
  }
}

export type SquarePaymentLinkInput = {
  invoiceId: string
  invoiceNumber: string
  orgSlug: string
  orgName: string
  currency: string
  amountCents: number
  locationId: string
  idempotencyKey: string
}

export function squarePaymentLinkBody(input: SquarePaymentLinkInput): Record<string, unknown> {
  return {
    idempotency_key: input.idempotencyKey,
    order: {
      location_id: input.locationId,
      reference_id: input.invoiceNumber,
      metadata: {
        org_slug: input.orgSlug,
        invoice_id: input.invoiceId,
        invoice_number: input.invoiceNumber,
      },
      line_items: [
        {
          name: `Invoice ${input.invoiceNumber} — ${input.orgName}`,
          quantity: '1',
          base_price_money: { amount: input.amountCents, currency: input.currency.toUpperCase() },
        },
      ],
    },
  }
}

export function parseSquarePaymentLink(data: unknown): { url: string; id: string; orderId: string } {
  const payload = data as { payment_link?: { url?: string; id?: string; order_id?: string }; errors?: Array<{ detail?: string }> }
  const link = payload.payment_link
  if (!link?.url || !link.id) {
    throw new Error(payload.errors?.[0]?.detail || 'Square returned no payment link')
  }
  return { url: link.url, id: link.id, orderId: link.order_id ?? '' }
}

/**
 * Square webhook signature: base64(HMAC-SHA256(signatureKey, notificationUrl + rawBody)).
 * The notification URL must be byte-for-byte the one configured in Square.
 */
export function verifySquareSignature(rawBody: string, signatureHeader: string | null, signatureKey: string, notificationUrl: string): boolean {
  if (!signatureHeader || !signatureKey) return false
  try {
    const expected = crypto.createHmac('sha256', signatureKey).update(notificationUrl + rawBody).digest('base64')
    const a = Buffer.from(expected)
    const b = Buffer.from(signatureHeader.trim())
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}
