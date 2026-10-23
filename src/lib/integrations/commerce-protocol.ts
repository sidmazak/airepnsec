export type CommerceProviderId = 'shopify' | 'woocommerce' | 'wix' | 'mailchimp'
export const COMMERCE_PROVIDER_IDS: CommerceProviderId[] = ['shopify', 'woocommerce', 'wix', 'mailchimp']

export const COMMERCE_LABELS: Record<CommerceProviderId, string> = {
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
  wix: 'Wix',
  mailchimp: 'Mailchimp',
}

export type ExternalContact = {
  externalId: string
  name: string
  email: string
  phone: string
  tags: string[]
}

type IntegrationRow = { id: string; orgId: string; kind: string; configJson: string; secretsEnc: string }

const trim = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const fullName = (first: unknown, last: unknown, fallback = ''): string =>
  [trim(first), trim(last)].filter(Boolean).join(' ') || fallback

function normalizeDomain(value: string): string {
  const bare = value.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim()
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(bare)) throw new Error(`Invalid Shopify shop domain "${value}" — expected something like my-store.myshopify.com`)
  return bare
}

function normalizeStoreUrl(value: string): string {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`
  return withScheme.replace(/\/+$/, '')
}

/* ---------------- request builders ---------------- */

export function shopifyCustomersRequest(shopDomain: string, accessToken: string) {
  return {
    url: `https://${normalizeDomain(shopDomain)}/admin/api/2024-10/customers.json?limit=250`,
    headers: { 'x-shopify-access-token': accessToken, accept: 'application/json' },
  }
}

export function wooCommerceCustomersRequest(storeUrl: string, consumerKey: string, consumerSecret: string) {
  return {
    url: `${normalizeStoreUrl(storeUrl)}/wp-json/wc/v3/customers?per_page=100`,
    headers: {
      authorization: `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}`,
      accept: 'application/json',
    },
  }
}

export function wixContactsRequest(siteId: string, apiKey: string) {
  return {
    url: 'https://www.wixapis.com/contacts/v4/contacts?paging.limit=100',
    headers: { authorization: apiKey, 'wix-site-id': siteId, accept: 'application/json' },
  }
}

export function mailchimpMembersRequest(serverPrefix: string, listId: string, apiKey: string) {
  const dc = serverPrefix.replace(/^https?:\/\//i, '').replace(/\.api\.mailchimp\.com.*$/i, '').replace(/[^a-z0-9-]/gi, '')
  if (!dc) throw new Error('Mailchimp serverPrefix is invalid (expected something like us21)')
  return {
    url: `https://${dc}.api.mailchimp.com/3.0/lists/${encodeURIComponent(listId)}/members?count=500`,
    headers: { authorization: `Basic ${Buffer.from(`anystring:${apiKey}`).toString('base64')}`, accept: 'application/json' },
  }
}

/* ---------------- parsers ---------------- */

export function parseShopifyContacts(data: unknown): ExternalContact[] {
  const customers = (data as { customers?: Array<Record<string, unknown>> }).customers ?? []
  return customers
    .map((c) => ({
      externalId: String(c.id ?? ''),
      name: fullName(c.first_name, c.last_name, trim(c.email)),
      email: trim(c.email).toLowerCase(),
      phone: trim(c.phone),
      tags: trim(c.tags).split(',').map((t) => t.trim()).filter(Boolean),
    }))
    .filter((c) => c.externalId && (c.email || c.phone || c.name))
}

export function parseWooCommerceContacts(data: unknown): ExternalContact[] {
  const customers = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []
  return customers
    .map((c) => {
      const billing = (c.billing ?? {}) as Record<string, unknown>
      return {
        externalId: String(c.id ?? ''),
        name: fullName(c.first_name, c.last_name, trim(c.username) || trim(billing.email as string)),
        email: (trim(c.email) || trim(billing.email)).toLowerCase(),
        phone: trim(billing.phone),
        tags: [],
      }
    })
    .filter((c) => c.externalId && (c.email || c.phone || c.name))
}

export function parseWixContacts(data: unknown): ExternalContact[] {
  const contacts = (data as { contacts?: Array<Record<string, unknown>> }).contacts ?? []
  return contacts
    .map((c) => {
      const info = (c.info ?? {}) as Record<string, unknown>
      const name = (info.name ?? {}) as Record<string, unknown>
      const emails = (info.emails ?? {}) as { items?: Array<Record<string, unknown>> }
      const phones = (info.phones ?? {}) as { items?: Array<Record<string, unknown>> }
      const email = trim(emails.items?.[0]?.email).toLowerCase()
      const phone = trim(phones.items?.[0]?.phone)
      const labels = Array.isArray(c.labels) ? (c.labels as unknown[]).map((l) => (typeof l === 'string' ? l : trim((l as Record<string, unknown>)?.name))) : []
      return {
        externalId: String(c.id ?? ''),
        name: fullName(name.first, name.last, email),
        email,
        phone,
        tags: labels.filter(Boolean),
      }
    })
    .filter((c) => c.externalId && (c.email || c.phone || c.name))
}

export function parseMailchimpContacts(data: unknown): ExternalContact[] {
  const members = (data as { members?: Array<Record<string, unknown>> }).members ?? []
  return members
    .map((m) => {
      const merge = (m.merge_fields ?? {}) as Record<string, unknown>
      const email = trim(m.email_address).toLowerCase()
      const tags = Array.isArray(m.tags) ? (m.tags as unknown[]).map((t) => trim((t as Record<string, unknown>)?.name)) : []
      return {
        externalId: String(m.id ?? ''),
        name: fullName(merge.FNAME, merge.LNAME, email),
        email,
        phone: trim(merge.PHONE),
        tags: tags.filter(Boolean),
      }
    })
    .filter((m) => m.externalId && (m.email || m.phone || m.name))
}

