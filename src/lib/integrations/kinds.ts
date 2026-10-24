import { z } from 'zod'
import { parseJson } from '@/lib/org'
import type { Integration } from '@prisma/client'

/**
 * Shared per-kind validation schemas + the secret-free wire shape used by ALL
 * integration endpoints. secretsEnc/decrypted secrets NEVER appear here.
 */

export const smtpConfigSchema = z.object({
  host: z.string().min(1, 'host is required'),
  port: z.coerce.number().int('port must be an integer').positive('port must be positive'),
  secure: z.boolean().optional(),
  from: z.string().min(3, 'from must be a sender email address'),
})

export const twilioConfigSchema = z.object({
  from: z.string().min(3, 'from is required (e.g. +15551234567 or whatsapp:+15551234567)'),
})

export const twilioVoiceConfigSchema = z.object({
  from: z.string().min(6, 'from is required — the Twilio voice-capable number in E.164 format (e.g. +15551234567)'),
  language: z.string().max(10).optional(), // e.g. en-US
  voiceName: z.string().max(40).optional(), // Twilio <Say> voice, e.g. alice / Polly.Joanna
  transferNumber: z.string().max(20).optional(), // where <Dial> sends escalated calls
  publicBaseUrl: z.string().url().optional(), // the https base URL configured in the Twilio console (used for webhook signature validation)
})

export const smsGatewayConfigSchema = z
  .object({
    provider: z.enum(['textbee', 'httpsms', 'android_sms_gateway', 'telnyx', 'vonage', 'messagebird', 'plivo', 'generic_http']),
    baseUrl: z.string().url('baseUrl must be a valid http(s) URL').optional(),
    from: z.string().max(40).optional(),
    deviceId: z.string().max(200).optional(),
    // generic_http only:
    url: z.string().url('url must be a valid http(s) URL').optional(),
    method: z.enum(['POST', 'PUT']).optional(),
    authHeaderName: z.string().max(60).optional(),
    bodyTemplate: z.string().max(2000).optional(),
    testRecipient: z.string().max(40).optional(),
    // Self-hosted gateways usually run on the same LAN: opt in explicitly.
    allowPrivate: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.provider === 'httpsms' && !val.from) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: 'httpSMS requires the sending phone number in "from"' })
    }
    if (val.provider === 'generic_http' && !val.url) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'generic_http requires the destination "url"' })
    }
    if (['telnyx', 'vonage', 'messagebird', 'plivo'].includes(val.provider) && !val.from) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: `${val.provider} requires the sending number or sender id in "from"` })
    }
  })

export const emailApiConfigSchema = z
  .object({
    provider: z.enum(['sendgrid', 'mailgun', 'postmark', 'resend', 'brevo']),
    from: z.string().email('from must be the sender email address'),
    fromName: z.string().max(120).optional(),
    domain: z.string().max(200).optional(), // Mailgun sending domain
    region: z.enum(['us', 'eu']).optional(), // Mailgun region
    messageStream: z.string().max(80).optional(), // Postmark stream, defaults to "outbound"
  })
  .superRefine((val, ctx) => {
    if (val.provider === 'mailgun' && !val.domain) {
      ctx.addIssue({ code: 'custom', path: ['domain'], message: 'Mailgun requires the sending domain (e.g. mg.example.com)' })
    }
  })

export const caldavConfigSchema = z.object({
  url: z.string().url('url must be the CalDAV calendar collection URL'),
  username: z.string().max(200).optional(),
  // A self-hosted calendar server usually lives on the LAN: allowed by default
  // (cloud metadata endpoints stay blocked).
  allowPrivate: z.boolean().optional(),
})

export const googleCalendarConfigSchema = z.object({
  calendarId: z.string().max(300).optional(), // calendar to read/write — defaults to "primary"
  redirectUri: z.string().url('redirectUri must be the absolute OAuth callback URL').optional(),
})

export const microsoftCalendarConfigSchema = z.object({
  // Where Microsoft authenticates. "common" works for most Microsoft 365 tenants;
  // a specific tenant ID (GUID) can be supplied for locked-down setups.
  tenant: z.string().min(1, 'tenant is required').max(200).optional(),
  // The mailbox the free/busy schedule queries — defaults to the signed-in
  // user's primary mailbox (fetched from Graph on sync).
  calendarEmail: z.string().email('calendarEmail must be an email address').optional(),
  redirectUri: z.string().url('redirectUri must be the absolute OAuth callback URL').optional(),
})

export const stripeConfigSchema = z.object({}).partial()

export const squareConfigSchema = z.object({
  locationId: z.string().min(1, 'locationId is required (Square location to bill)'),
  environment: z.enum(['production', 'sandbox']).optional(),
  notificationUrl: z.string().url('notificationUrl must be the exact webhook URL configured in Square').optional(),
})

export const accountingConfigSchema = z.object({
  realmId: z.string().max(200).optional(), // QuickBooks company (realm) id
  tenantId: z.string().max(200).optional(), // Xero tenant id
  companyFileId: z.string().max(200).optional(), // MYOB company file id
  salesAccountCode: z.string().max(40).optional(), // Xero line-item account code
})

export const shopifyConfigSchema = z.object({
  shopDomain: z.string().min(4, 'shopDomain is required (e.g. my-store.myshopify.com)'),
})

export const wooCommerceConfigSchema = z.object({
  storeUrl: z.string().url('storeUrl must be the WordPress site URL'),
  allowPrivate: z.boolean().optional(), // self-hosted WooCommerce on the LAN
})

export const wixConfigSchema = z.object({
  siteId: z.string().min(1, 'siteId is required (the Wix site id)'),
})

export const mailchimpConfigSchema = z.object({
  serverPrefix: z.string().min(2, 'serverPrefix is required (e.g. us21)'),
  listId: z.string().min(1, 'listId is required (the Mailchimp audience id)'),
})

export const webhookOutConfigSchema = z.object({
  url: z.string().url('url must be a valid http(s) URL'),
  // Admin opt-in for LAN/self-hosted receivers; otherwise private IPs are SSRF-blocked.
  allowPrivate: z.boolean().optional(),
})

export const imapConfigSchema = z.object({
  host: z.string().min(1, 'host is required'),
  port: z.coerce.number().int('port must be an integer').positive('port must be positive'),
  secure: z.boolean().optional(), // true for IMAPS (993), false for STARTTLS (143)
  username: z.string().min(1, 'username is required'),
  // Folders to monitor (comma-separated). Default: INBOX
  folders: z.string().max(500).optional(),
  // How often to poll (minutes). Default: 5
  pollIntervalMinutes: z.coerce.number().int().positive().max(60).optional(),
  // Maximum messages to fetch per poll. Default: 50
  maxMessagesPerPoll: z.coerce.number().int().positive().max(200).optional(),
  // Self-hosted mail servers usually live on the LAN: set allowPrivate to opt in
  // (cloud metadata endpoints stay blocked regardless).
  allowPrivate: z.boolean().optional(),
})

/** Secrets accepted per kind (full-replacement semantics on PATCH). */
export const secretsSchemaFor: Record<string, z.ZodTypeAny> = {
  smtp: z.object({ user: z.string().optional(), pass: z.string().optional() }),
  twilio_sms: z.object({ accountSid: z.string().min(1, 'accountSid is required'), authToken: z.string().min(1, 'authToken is required') }),
  twilio_whatsapp: z.object({ accountSid: z.string().min(1, 'accountSid is required'), authToken: z.string().min(1, 'authToken is required') }),
  twilio_voice: z.object({ accountSid: z.string().min(1, 'accountSid is required'), authToken: z.string().min(1, 'authToken is required') }),
  sms_gateway: z.object({
    apiKey: z.string().optional(), // TextBee / httpSMS
    username: z.string().optional(), // android-sms-gateway (basic auth)
    password: z.string().optional(),
    token: z.string().optional(), // android-sms-gateway (bearer)
    authValue: z.string().optional(), // generic_http custom auth header value
    apiSecret: z.string().optional(), // vonage (API secret), plivo (auth token fallback)
    accountId: z.string().optional(), // plivo Auth ID
  }),
  email_api: z.object({ apiKey: z.string().min(1, 'apiKey is required') }),
  caldav: z.object({ password: z.string().optional() }),
  google_calendar: z.object({
    clientId: z.string().min(1, 'clientId is required'),
    clientSecret: z.string().min(1, 'clientSecret is required'),
    // Written by the OAuth callback — never typed by the operator.
    refreshToken: z.string().optional(),
    accessToken: z.string().optional(),
    accessTokenExpiresAt: z.string().optional(),
  }),
  microsoft_calendar: z.object({
    clientId: z.string().min(1, 'clientId is required (the application (client) ID from Entra ID)'),
    clientSecret: z.string().min(1, 'clientSecret is required (the client secret value)'),
    // Written by the OAuth callback — never typed by the operator.
    refreshToken: z.string().optional(),
    accessToken: z.string().optional(),
    accessTokenExpiresAt: z.string().optional(),
  }),
  stripe: z.object({ secretKey: z.string().min(1, 'secretKey is required'), webhookSecret: z.string().optional() }),
  square: z.object({ accessToken: z.string().min(1, 'accessToken is required'), webhookSignatureKey: z.string().optional() }),
  quickbooks: z.object({
    clientId: z.string().min(1, 'clientId is required'),
    clientSecret: z.string().min(1, 'clientSecret is required'),
    refreshToken: z.string().min(1, 'refreshToken is required'),
    accessToken: z.string().optional(),
    accessTokenExpiresAt: z.string().optional(),
  }),
  xero: z.object({
    clientId: z.string().min(1, 'clientId is required'),
    clientSecret: z.string().min(1, 'clientSecret is required'),
    refreshToken: z.string().min(1, 'refreshToken is required'),
    accessToken: z.string().optional(),
    accessTokenExpiresAt: z.string().optional(),
  }),
  myob: z.object({
    clientId: z.string().min(1, 'clientId is required'),
    clientSecret: z.string().min(1, 'clientSecret is required'),
    refreshToken: z.string().min(1, 'refreshToken is required'),
    accessToken: z.string().optional(),
    accessTokenExpiresAt: z.string().optional(),
  }),
  shopify: z.object({ accessToken: z.string().min(1, 'accessToken is required') }),
  woocommerce: z.object({
    consumerKey: z.string().min(1, 'consumerKey is required'),
    consumerSecret: z.string().min(1, 'consumerSecret is required'),
  }),
  wix: z.object({ apiKey: z.string().min(1, 'apiKey is required') }),
  mailchimp: z.object({ apiKey: z.string().min(1, 'apiKey is required') }),
  webhook_out: z.object({ secret: z.string().optional() }),
  imap: z.object({ password: z.string().min(1, 'password is required'), webhookSecret: z.string().min(16, 'webhookSecret must be at least 16 characters').max(200).optional() }),
}

export const configSchemaFor: Record<string, z.ZodTypeAny> = {
  smtp: smtpConfigSchema,
  twilio_sms: twilioConfigSchema,
  twilio_whatsapp: twilioConfigSchema,
  twilio_voice: twilioVoiceConfigSchema,
  sms_gateway: smsGatewayConfigSchema,
  email_api: emailApiConfigSchema,
  caldav: caldavConfigSchema,
  google_calendar: googleCalendarConfigSchema,
  microsoft_calendar: microsoftCalendarConfigSchema,
  stripe: stripeConfigSchema,
  square: squareConfigSchema,
  quickbooks: accountingConfigSchema,
  xero: accountingConfigSchema,
  myob: accountingConfigSchema,
  shopify: shopifyConfigSchema,
  woocommerce: wooCommerceConfigSchema,
  wix: wixConfigSchema,
  mailchimp: mailchimpConfigSchema,
  webhook_out: webhookOutConfigSchema,
  imap: imapConfigSchema,
}

/** Minimal credential check so "configured" always means "testable". */
export function secretsAreSufficient(kind: string, secrets: Record<string, unknown>): boolean {
  switch (kind) {
    case 'smtp':
      return true // anonymous relays are legitimate; send/test will fail honestly otherwise
    case 'twilio_sms':
    case 'twilio_whatsapp':
    case 'twilio_voice':
      return Boolean(secrets.accountSid && secrets.authToken)
    case 'sms_gateway':
      // Credentials are provider-dependent and often legitimately absent
      // (android-sms-gateway local mode, an unauthenticated LAN/iOS bridge).
      // The real connection test and each send report honest failures instead.
      return true
    case 'email_api':
      return Boolean(secrets.apiKey)
    case 'caldav':
      return true // password optional (some local servers allow anonymous writes); PUT/PROPFIND will fail honestly otherwise
    case 'google_calendar':
      // The OAuth client credentials are enough to START the consent flow; the
      // refresh token arrives later from the Google callback.
      return Boolean(secrets.clientId && secrets.clientSecret)
    case 'microsoft_calendar':
      return Boolean(secrets.clientId && secrets.clientSecret)
    case 'stripe':
      return Boolean(secrets.secretKey)
    case 'square':
      return Boolean(secrets.accessToken)
    case 'quickbooks':
    case 'xero':
    case 'myob':
      return Boolean(secrets.clientId && secrets.clientSecret && secrets.refreshToken)
    case 'shopify':
      return Boolean(secrets.accessToken)
    case 'woocommerce':
      return Boolean(secrets.consumerKey && secrets.consumerSecret)
    case 'wix':
      return Boolean(secrets.apiKey)
    case 'mailchimp':
      return Boolean(secrets.apiKey)
    case 'webhook_out':
      return true // signing secret is optional by design
    case 'imap':
      return Boolean(secrets.password)
    default:
      return false
  }
}

/**
 * Secrets that an OAuth callback owns. When the operator edits other credentials
 * the token is preserved instead of being wiped by the full-replacement semantics.
 */
const PRESERVED_SECRET_KEYS: Record<string, string[]> = {
  google_calendar: ['refreshToken', 'accessToken', 'accessTokenExpiresAt'],
  microsoft_calendar: ['refreshToken', 'accessToken', 'accessTokenExpiresAt'],
  quickbooks: ['refreshToken', 'accessToken', 'accessTokenExpiresAt'],
  xero: ['refreshToken', 'accessToken', 'accessTokenExpiresAt'],
  myob: ['refreshToken', 'accessToken', 'accessTokenExpiresAt'],
}

/** Merge incoming secrets over the stored ones, keeping provider-owned tokens. */
export function mergeSecrets(kind: string, existing: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const preserved = PRESERVED_SECRET_KEYS[kind]
  if (!preserved) return incoming
  const merged: Record<string, unknown> = { ...incoming }
  for (const key of preserved) {
    if (merged[key] === undefined && existing[key] !== undefined) merged[key] = existing[key]
  }
  return merged
}

/** True when the Google OAuth consent flow has completed (a refresh token is stored). */
export function googleOAuthConnected(secrets: Record<string, unknown>): boolean {
  return typeof secrets.refreshToken === 'string' && secrets.refreshToken.length > 0
}

/** Microsoft 365: the consent flow completed (tokens are stored). */
export function microsoftOAuthConnected(secrets: Record<string, unknown>): boolean {
  if (typeof secrets.refreshToken !== 'string' || !secrets.refreshToken) return false
  if (typeof secrets.accessToken !== 'string' || !secrets.accessToken) return false
  if (typeof secrets.accessTokenExpiresAt !== 'string' || !secrets.accessTokenExpiresAt) return false
  return Number.isFinite(new Date(secrets.accessTokenExpiresAt).getTime())
}

/** Wire shape — config parsed, credentials represented ONLY by the boolean `configured`. */
export function publicIntegration(integration: Integration) {
  return {
    id: integration.id,
    kind: integration.kind,
    label: integration.label,
    config: parseJson<Record<string, unknown>>(integration.configJson, {}),
    configured: Boolean(integration.secretsEnc),
    enabled: integration.enabled,
    lastTestAt: integration.lastTestAt ? integration.lastTestAt.toISOString() : null,
    lastTestOk: integration.lastTestOk,
    lastTestError: integration.lastTestError,
    createdAt: integration.createdAt.toISOString(),
  }
}
