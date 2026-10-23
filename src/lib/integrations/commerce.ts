import { db } from '@/lib/db'
import { assertOutboundUrl } from '@/lib/security/outbound'
import { decryptSecrets, integrationConfig, sanitizeMessage, str } from '@/lib/integrations/connectors'
import {
  COMMERCE_LABELS,
  COMMERCE_PROVIDER_IDS,
  mailchimpMembersRequest,
  parseMailchimpContacts,
  parseShopifyContacts,
  parseWixContacts,
  parseWooCommerceContacts,
  shopifyCustomersRequest,
  wixContactsRequest,
  wooCommerceCustomersRequest,
  type CommerceProviderId,
  type ExternalContact,
} from '@/lib/integrations/commerce-protocol'

export * from '@/lib/integrations/commerce-protocol'

type IntegrationRow = { id: string; orgId: string; kind: string; configJson: string; secretsEnc: string }

/* ---------------- live fetch ---------------- */

export async function fetchCommerceContacts(
  kind: string,
  integration: { configJson: string; secretsEnc: string }
): Promise<{ contacts: ExternalContact[]; detail: string }> {
  if (!COMMERCE_PROVIDER_IDS.includes(kind as CommerceProviderId)) throw new Error(`Unknown commerce kind ${kind}`)
  const provider = kind as CommerceProviderId
  const config = integrationConfig(integration)
  const secrets = decryptSecrets(integration)

  let request: { url: string; headers: Record<string, string> }
  if (provider === 'shopify') {
    const accessToken = str(secrets, 'accessToken')
    if (!accessToken) throw new Error('Shopify secrets need an accessToken')
    request = shopifyCustomersRequest(str(config, 'shopDomain'), accessToken)
  } else if (provider === 'woocommerce') {
    const consumerKey = str(secrets, 'consumerKey')
    const consumerSecret = str(secrets, 'consumerSecret')
    if (!consumerKey || !consumerSecret) throw new Error('WooCommerce secrets need consumerKey and consumerSecret')
    request = wooCommerceCustomersRequest(str(config, 'storeUrl'), consumerKey, consumerSecret)
  } else if (provider === 'wix') {
    const apiKey = str(secrets, 'apiKey')
    if (!apiKey) throw new Error('Wix secrets need an apiKey')
    request = wixContactsRequest(str(config, 'siteId'), apiKey)
  } else {
    const apiKey = str(secrets, 'apiKey')
    if (!apiKey) throw new Error('Mailchimp secrets need an apiKey')
    request = mailchimpMembersRequest(str(config, 'serverPrefix'), str(config, 'listId'), apiKey)
  }

  if (provider === 'woocommerce') {
    await assertOutboundUrl(request.url, { allowPrivate: config.allowPrivate === true, label: 'WooCommerce store URL' })
  }

  try {
    const res = await fetch(request.url, { headers: request.headers, signal: AbortSignal.timeout(20_000) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const payload = data as { error?: string; message?: string; errors?: Array<{ message?: string }>; detail?: string }
      const detail = payload.errors?.[0]?.message || payload.error || payload.message || payload.detail || `HTTP ${res.status} ${res.statusText}`
      throw new Error(`${COMMERCE_LABELS[provider]} rejected the request (HTTP ${res.status}): ${detail}`)
    }
    const contacts =
      provider === 'shopify'
        ? parseShopifyContacts(data)
        : provider === 'woocommerce'
          ? parseWooCommerceContacts(data)
          : provider === 'wix'
            ? parseWixContacts(data)
            : parseMailchimpContacts(data)
    return { contacts, detail: `${contacts.length} contact${contacts.length === 1 ? '' : 's'} fetched from ${COMMERCE_LABELS[provider]}` }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(COMMERCE_LABELS[provider])) throw err
    throw new Error(sanitizeMessage(err instanceof Error ? err.message : String(err), integration))
  }
}

export async function testCommerce(kind: string, integration: { configJson: string; secretsEnc: string }) {
  if (!COMMERCE_PROVIDER_IDS.includes(kind as CommerceProviderId)) return { ok: false, detail: `Unknown commerce kind ${kind}` }
  try {
    const { detail } = await fetchCommerceContacts(kind, integration)
    return { ok: true, detail }
  } catch (err) {
    return { ok: false, detail: `${COMMERCE_LABELS[kind as CommerceProviderId]} test failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/* ---------------- customer upsert ---------------- */

function mergeTags(existingJson: string, incoming: string[]): string {
  let current: string[] = []
  try {
    const parsed: unknown = JSON.parse(existingJson || '[]')
    if (Array.isArray(parsed)) current = parsed.filter((t): t is string => typeof t === 'string')
  } catch {
    current = []
  }
  const merged = [...new Set([...current, ...incoming])].slice(0, 50)
  return JSON.stringify(merged)
}

export async function syncCommerceCustomers(kind: string, integration: IntegrationRow) {
  const { contacts, detail } = await fetchCommerceContacts(kind, integration)
  const provider = kind as CommerceProviderId
  let created = 0
  let updated = 0
  let skipped = 0

  for (const contact of contacts) {
    const ref = `${provider}:${contact.externalId}`
    const or: Array<Record<string, string>> = [{ externalRef: ref }]
    if (contact.email) or.push({ email: contact.email })
    if (contact.phone) or.push({ phone: contact.phone })
    const existing = await db.customer.findFirst({ where: { orgId: integration.orgId, OR: or } })
    if (existing) {
      await db.customer.update({
        where: { id: existing.id },
        data: {
          name: existing.name || contact.name,
          email: existing.email || contact.email,
          phone: existing.phone || contact.phone,
          externalRef: existing.externalRef || ref,
          tags: mergeTags(existing.tags, contact.tags),
        },
      })
      updated += 1
    } else {
      if (!contact.email && !contact.phone) {
        skipped += 1
        continue
      }
      await db.customer.create({
        data: {
          orgId: integration.orgId,
          name: contact.name || contact.email || contact.phone,
          email: contact.email,
          phone: contact.phone,
          externalRef: ref,
          tags: JSON.stringify(contact.tags.slice(0, 50)),
        },
      })
      created += 1
    }
  }

  return { provider, fetched: contacts.length, created, updated, skipped, detail }
}
