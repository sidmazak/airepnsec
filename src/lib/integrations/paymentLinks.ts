import { getEnabledStripe, createStripePaymentLink } from '@/lib/integrations/stripe'
import { getEnabledSquare, createSquarePaymentLink } from '@/lib/integrations/square'

/**
 * One entry point for invoice payment links. Stripe is preferred when both are
 * enabled; Square is used otherwise. Returns the provider that actually created
 * the link so callers never imply the wrong processor.
 */

export type PaymentLinkProvider = 'stripe' | 'square'

export async function getEnabledPaymentLinkProvider(orgId: string): Promise<PaymentLinkProvider | null> {
  if (await getEnabledStripe(orgId)) return 'stripe'
  if (await getEnabledSquare(orgId)) return 'square'
  return null
}

export async function createInvoicePaymentLink(
  orgId: string,
  invoice: { id: string; number: string; currency: string },
  outstandingCents: number
): Promise<{ url: string; id: string; provider: PaymentLinkProvider }> {
  if (await getEnabledStripe(orgId)) {
    const link = await createStripePaymentLink(orgId, invoice, outstandingCents)
    return { ...link, provider: 'stripe' }
  }
  if (await getEnabledSquare(orgId)) {
    return createSquarePaymentLink(orgId, invoice, outstandingCents)
  }
  throw new Error('No payment integration is enabled — configure Stripe or Square in Integrations')
}

export const PAYMENT_LINK_PROVIDER_LABELS: Record<PaymentLinkProvider, string> = {
  stripe: 'Stripe',
  square: 'Square',
}
