/**
 * Single source of truth for the integration catalog shown in the UI and the
 * setup wizard. Pure data (safe to import from client components) — the actual
 * validation schemas live in `kinds.ts` and the adapters in their own modules.
 */

export type IntegrationCategory = 'communication' | 'calendar' | 'payments' | 'accounting' | 'commerce' | 'automation'

export type IntegrationProviderOption = {
  id: string
  label: string
  brand: string
}

export type IntegrationCatalogEntry = {
  kind: string
  title: string
  blurb: string
  category: IntegrationCategory
  brand: string
  needsCredentials: boolean
  docsUrl?: string
  guide?: string
  providers?: IntegrationProviderOption[]
}

export const CATEGORY_ORDER: IntegrationCategory[] = [
  'communication', 'calendar', 'payments', 'accounting', 'commerce', 'automation',
]

export const CATEGORY_META: Record<IntegrationCategory, { title: string; description: string }> = {
  communication: {
    title: 'Email, SMS & voice',
    description: 'Send reminders and invoices, answer inbound email, text and phone calls.',
  },
  calendar: {
    title: 'Calendars',
    description: 'Two-way sync so external busy time blocks bookable slots and bookings appear on your calendar.',
  },
  payments: {
    title: 'Payments',
    description: 'Create real payment links and verify provider callbacks before recording money.',
  },
  accounting: {
    title: 'Accounting',
    description: 'Push issued invoices and customers into your accounting system.',
  },
  commerce: {
    title: 'Commerce & CRM',
    description: 'Import customers and contacts from your store or mailing list.',
  },
  automation: {
    title: 'Automation',
    description: 'Send signed events to Zapier, Make or any custom endpoint.',
  },
}

const EMAIL_PROVIDERS: IntegrationProviderOption[] = [
  { id: 'sendgrid', label: 'SendGrid', brand: 'sendgrid' },
  { id: 'mailgun', label: 'Mailgun', brand: 'mailgun' },
  { id: 'postmark', label: 'Postmark', brand: 'postmark' },
  { id: 'resend', label: 'Resend', brand: 'resend' },
  { id: 'brevo', label: 'Brevo', brand: 'brevo' },
]

const SMS_PROVIDERS: IntegrationProviderOption[] = [
  { id: 'textbee', label: 'TextBee', brand: 'textbee' },
  { id: 'httpsms', label: 'httpSMS', brand: 'httpsms' },
  { id: 'android_sms_gateway', label: 'Android SMS Gateway', brand: 'android_sms_gateway' },
  { id: 'telnyx', label: 'Telnyx', brand: 'telnyx' },
  { id: 'vonage', label: 'Vonage', brand: 'vonage' },
  { id: 'messagebird', label: 'MessageBird', brand: 'messagebird' },
  { id: 'plivo', label: 'Plivo', brand: 'plivo' },
  { id: 'generic_http', label: 'Generic HTTP', brand: 'generic_http' },
]

export const INTEGRATION_CATALOG: IntegrationCatalogEntry[] = [
  {
    kind: 'smtp',
    title: 'Email (SMTP)',
    blurb: 'Outgoing email for invoices, reminders and receipts. Use your own server, relay or a local sink.',
    category: 'communication',
    brand: 'smtp',
    needsCredentials: false,
    guide: 'Host, port, TLS and sender address. Credentials are optional for anonymous relays.',
  },
  {
    kind: 'email_api',
    title: 'Email (provider API)',
    blurb: 'Send through SendGrid, Mailgun, Postmark, Resend or Brevo — no SMTP server needed.',
    category: 'communication',
    brand: 'email',
    needsCredentials: true,
    guide: 'Pick a provider and paste its API key. The connection test is read-only.',
    providers: EMAIL_PROVIDERS,
  },
  {
    kind: 'imap',
    title: 'Inbound Email (IMAP)',
    blurb: 'Poll a mailbox and let the AI answer by email; optional signed provider webhooks for instant delivery.',
    category: 'communication',
    brand: 'imap',
    needsCredentials: true,
    guide: 'Mailbox host, username, app password and folders. Replies are queued in the outbox.',
  },
  {
    kind: 'twilio_sms',
    title: 'SMS (Twilio)',
    blurb: 'Text reminders and AI replies from your own Twilio number.',
    category: 'communication',
    brand: 'twilio',
    needsCredentials: true,
    docsUrl: 'https://www.twilio.com/docs/messaging',
    guide: 'Account SID, auth token and a Twilio sender number.',
  },
  {
    kind: 'twilio_whatsapp',
    title: 'WhatsApp (Twilio)',
    blurb: 'WhatsApp conversations through a WhatsApp-enabled Twilio sender.',
    category: 'communication',
    brand: 'whatsapp',
    needsCredentials: true,
    docsUrl: 'https://www.twilio.com/docs/whatsapp',
    guide: 'Same credentials as Twilio; the sender must be WhatsApp-enabled (whatsapp:+…).',
  },
  {
    kind: 'twilio_voice',
    title: 'Phone Receptionist (Twilio Voice)',
    blurb: 'The AI answers real calls, books appointments, quotes prices and transfers to staff.',
    category: 'communication',
    brand: 'twilio',
    needsCredentials: true,
    docsUrl: 'https://www.twilio.com/docs/voice',
    guide: 'Point your Twilio number webhooks at this app, then enable the integration.',
  },
  {
    kind: 'sms_gateway',
    title: 'SMS Gateway (bring your own)',
    blurb: 'Use a phone/modem bridge or carrier API: TextBee, httpSMS, Android SMS Gateway, Telnyx, Vonage, MessageBird, Plivo or any HTTP gateway.',
    category: 'communication',
    brand: 'httpsms',
    needsCredentials: false,
    docsUrl: 'https://github.com/capcom6/android-sms-gateway',
    guide: 'Pick a provider; self-hosted bridges may run without credentials.',
    providers: SMS_PROVIDERS,
  },
  {
    kind: 'google_calendar',
    title: 'Google Calendar',
    blurb: 'Two-way sync: busy times block slots, bookings appear on your calendar.',
    category: 'calendar',
    brand: 'google',
    needsCredentials: true,
    docsUrl: 'https://developers.google.com/calendar',
    guide: 'Create a Google Cloud OAuth client, paste the client ID/secret, then Connect.',
  },
  {
    kind: 'microsoft_calendar',
    title: 'Microsoft 365 Calendar',
    blurb: 'Two-way sync through Microsoft Graph so Outlook busy times block slots.',
    category: 'calendar',
    brand: 'microsoft',
    needsCredentials: true,
    docsUrl: 'https://learn.microsoft.com/graph/',
    guide: 'Register an Entra ID app, paste the client ID/secret, then Connect.',
  },
  {
    kind: 'caldav',
    title: 'Calendar Sync (CalDAV)',
    blurb: 'Push bookings to Nextcloud, Fastmail, Radicale or iCloud and pull remote changes back.',
    category: 'calendar',
    brand: 'caldav',
    needsCredentials: false,
    docsUrl: 'https://datatracker.ietf.org/doc/html/rfc4791',
    guide: 'Calendar URL + optional username/password. LAN servers can opt in explicitly.',
  },
  {
    kind: 'stripe',
    title: 'Payments (Stripe)',
    blurb: 'Real Stripe payment links on invoices, with signature-verified callbacks.',
    category: 'payments',
    brand: 'stripe',
    needsCredentials: true,
    docsUrl: 'https://docs.stripe.com/api/payment-link',
    guide: 'Secret key + webhook signing secret (whsec_…).',
  },
  {
    kind: 'square',
    title: 'Payments (Square)',
    blurb: 'Square payment links with signed webhook callbacks that record verified payments.',
    category: 'payments',
    brand: 'square',
    needsCredentials: true,
    docsUrl: 'https://developer.squareup.com/docs/checkout-api',
    guide: 'Access token, location ID and webhook signature key.',
  },
  {
    kind: 'quickbooks',
    title: 'Accounting (QuickBooks Online)',
    blurb: 'Push issued invoices and create customers in QuickBooks with your own OAuth app.',
    category: 'accounting',
    brand: 'quickbooks',
    needsCredentials: true,
    docsUrl: 'https://developer.intuit.com/app/developer/qbo/docs/get-started',
    guide: 'Client ID/secret + refresh token; tokens rotate automatically.',
  },
  {
    kind: 'xero',
    title: 'Accounting (Xero)',
    blurb: 'Push issued invoices and contacts into Xero using your Xero OAuth app.',
    category: 'accounting',
    brand: 'xero',
    needsCredentials: true,
    docsUrl: 'https://developer.xero.com/documentation/',
    guide: 'Client ID/secret + refresh token; tokens rotate automatically.',
  },
  {
    kind: 'myob',
    title: 'Accounting (MYOB AccountRight)',
    blurb: 'Push issued invoices and customers into MYOB AccountRight company files.',
    category: 'accounting',
    brand: 'myob',
    needsCredentials: true,
    docsUrl: 'https://developer.myob.com/',
    guide: 'Client ID/secret, company file ID + refresh token.',
  },
  {
    kind: 'shopify',
    title: 'Shopify',
    blurb: 'Import Shopify customers (with tags) into your customer list.',
    category: 'commerce',
    brand: 'shopify',
    needsCredentials: true,
    docsUrl: 'https://shopify.dev/docs/api/admin-rest',
    guide: 'Store domain + Admin API access token.',
  },
  {
    kind: 'woocommerce',
    title: 'WooCommerce',
    blurb: 'Import customers from your WordPress store, including self-hosted/LAN installs.',
    category: 'commerce',
    brand: 'woocommerce',
    needsCredentials: true,
    docsUrl: 'https://woocommerce.github.io/woocommerce-rest-api-docs/',
    guide: 'Store URL + consumer key/secret. Enable LAN access for a local store.',
  },
  {
    kind: 'wix',
    title: 'Wix',
    blurb: 'Import Wix contacts into your customer list.',
    category: 'commerce',
    brand: 'wix',
    needsCredentials: true,
    docsUrl: 'https://dev.wix.com/docs/rest',
    guide: 'Site ID + Wix API key.',
  },
  {
    kind: 'mailchimp',
    title: 'Mailchimp',
    blurb: 'Import Mailchimp audience members into your customer list.',
    category: 'commerce',
    brand: 'mailchimp',
    needsCredentials: true,
    docsUrl: 'https://mailchimp.com/developer/marketing/api/',
    guide: 'API key + server prefix (e.g. us21) + audience/list ID.',
  },
  {
    kind: 'webhook_out',
    title: 'Webhooks',
    blurb: 'Send signed events to Zapier, Make or any custom HTTPS endpoint.',
    category: 'automation',
    brand: 'webhook',
    needsCredentials: false,
    guide: 'Destination URL + optional HMAC signing secret. One row per URL.',
  },
]

export function catalogEntry(kind: string): IntegrationCatalogEntry | undefined {
  return INTEGRATION_CATALOG.find((entry) => entry.kind === kind)
}

/** Kinds rendered as singleton cards (webhook_out has its own multi-row card). */
export const CATALOG_CARD_KINDS = INTEGRATION_CATALOG.filter((entry) => entry.kind !== 'webhook_out').map((entry) => entry.kind)

export function providerLabel(entry: IntegrationCatalogEntry | undefined, providerId: string): string {
  return entry?.providers?.find((provider) => provider.id === providerId)?.label ?? providerId
}

export function providerBrand(entry: IntegrationCatalogEntry | undefined, providerId: string): string {
  return entry?.providers?.find((provider) => provider.id === providerId)?.brand ?? entry?.brand ?? 'generic'
}
