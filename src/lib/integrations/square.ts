import crypto from 'node:crypto'
import { db } from '@/lib/db'
import { getEnabledIntegration, sanitizeMessage } from '@/lib/integrations/connectors'
import { decryptSecrets, integrationConfig, str } from '@/lib/integrations/connectors'
import {
  squareBase,
  squareHeaders,
  squarePaymentLinkBody,
  parseSquarePaymentLink,
  verifySquareSignature,
  type SquareEnvironment,
  type SquarePaymentLinkInput,
} from '@/lib/integrations/square-protocol'

export { squareBase, squareHeaders, squarePaymentLinkBody, parseSquarePaymentLink, verifySquareSignature }
export type { SquareEnvironment, SquarePaymentLinkInput }

export async function getEnabledSquare(orgId: string) {
  return getEnabledIntegration(orgId, 'square')
}

export async function testSquare(integration: { configJson: string; secretsEnc: string }) {
  const config = integrationConfig(integration)
  const secrets = decryptSecrets(integration)
  const accessToken = str(secrets, 'accessToken')
  if (!accessToken) return { ok: false, detail: 'Square secrets need an accessToken' }
  try {
    const res = await fetch(`${squareBase(str(config, 'environment'))}/v2/locations`, {
      headers: squareHeaders(accessToken),
      signal: AbortSignal.timeout(10_000),
    })
    const data = (await res.json().catch(() => ({}))) as { locations?: Array<{ id?: string; name?: string }>; errors?: Array<{ detail?: string }> }
    if (!res.ok) {
      return { ok: false, detail: `Square rejected the credentials (HTTP ${res.status}): ${sanitizeMessage(data.errors?.[0]?.detail ?? res.statusText, integration)}` }
    }
    const count = data.locations?.length ?? 0
    return { ok: true, detail: `Square credentials verified — ${count} location${count === 1 ? '' : 's'} visible` }
  } catch (err) {
    return { ok: false, detail: `Square test failed: ${sanitizeMessage(err instanceof Error ? err.message : String(err), integration)}` }
  }
}

export async function createSquarePaymentLink(
  orgId: string,
  invoice: { id: string; number: string; currency: string },
  outstandingCents: number
): Promise<{ url: string; id: string; provider: 'square' }> {
  if (!Number.isInteger(outstandingCents) || outstandingCents <= 0) {
    throw new Error('Payment link amount must be a positive integer (minor units)')
  }
  const integration = await getEnabledSquare(orgId)
  if (!integration) throw new Error('Square integration is not enabled')
  const config = integrationConfig(integration)
  const secrets = decryptSecrets(integration)
  const accessToken = str(secrets, 'accessToken')
  const locationId = str(config, 'locationId')
  if (!accessToken) throw new Error('Square integration has no access token')
  if (!locationId) throw new Error('Square integration needs a locationId')

  const org = await db.organization.findUnique({ where: { id: orgId }, select: { slug: true, name: true } })
  if (!org) throw new Error('Organization not found')

  const body = squarePaymentLinkBody({
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    orgSlug: org.slug,
    orgName: org.name,
    currency: invoice.currency,
    amountCents: outstandingCents,
    locationId,
    idempotencyKey: crypto.randomUUID(),
  })
  try {
    const res = await fetch(`${squareBase(str(config, 'environment'))}/v2/online-checkout/payment-links`, {
      method: 'POST',
      headers: squareHeaders(accessToken),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const detail = (data as { errors?: Array<{ detail?: string }> }).errors?.[0]?.detail
      throw new Error(sanitizeMessage(detail ? `Square error ${res.status}: ${detail}` : `Square HTTP ${res.status} ${res.statusText}`, integration))
    }
    const parsed = parseSquarePaymentLink(data)
    return { ...parsed, provider: 'square' }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Square')) throw err
    throw new Error(sanitizeMessage(err instanceof Error ? err.message : String(err), integration))
  }
}
