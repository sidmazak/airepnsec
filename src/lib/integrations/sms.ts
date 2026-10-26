import type { TestResult } from '@/lib/integrations/connectors'

/*
 * Inline SSRF guard for SMS gateway URLs. It is kept self-contained (instead of
 * importing @/lib/security/outbound) so this module can be unit-tested with
 * plain `node:test`, which does not resolve the Next.js path alias.
 *
 * Mirrors assertOutboundUrl: literal host check + DNS resolution check. Cloud
 * metadata endpoints are always blocked, even when private addresses are
 * explicitly allowed.
 */
const METADATA_IPS = ['169.254.169.254', '169.254.170.2', '100.100.100.200', 'fd00:ec2::254']
const METADATA_HOSTS = ['metadata.google.internal', 'metadata.goog']
const PRIVATE_V4 = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|192\.168\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/

function isMetadataHost(host: string): boolean {
  const h = host.toLowerCase()
  return METADATA_HOSTS.includes(h) || METADATA_IPS.includes(h)
}

function isPrivateAddress(address: string): boolean {
  const a = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (a === '::1' || a === '::' || a.startsWith('fc') || a.startsWith('fd')) return true
  if (a.startsWith('::ffff:')) return isPrivateAddress(a.slice(7))
  return PRIVATE_V4.test(a)
}

/**
 * Validate a gateway URL before we send to it. `allowPrivate` is the explicit
 * opt-in for a self-hosted gateway on the operator's LAN.
 */
export async function resolveSafeGatewayUrl(raw: string, allowPrivate: boolean): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('SMS gateway URL is not a valid http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('SMS gateway URL must use http:// or https://')
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (isMetadataHost(host)) {
    throw new Error('SMS gateway URL points to a cloud metadata endpoint - this is blocked to prevent credential theft')
  }
  if (allowPrivate) return url
  if (host === 'localhost' || host.endsWith('.localhost') || isPrivateAddress(host)) {
    throw new Error(
      'SMS gateway URL points to a private/local address and private addresses are not allowed. Enable "allowPrivate" on the integration if the gateway runs on your own network.'
    )
  }
  try {
    const dns = await import('node:dns/promises')
    const entries = await dns.lookup(host, { all: true })
    if (entries.some((e) => isPrivateAddress(e.address))) {
      throw new Error(
        'SMS gateway URL resolves to a private/local address and private addresses are not allowed. Enable "allowPrivate" on the integration if the gateway runs on your own network.'
      )
    }
  } catch (err) {
    // A DNS failure is reported by the fetch itself; only rethrow our own verdict.
    if (err instanceof Error && err.message.startsWith('SMS gateway URL resolves')) throw err
  }
  return url
}

/**
 * Universal SMS gateway adapters (BYO hardware / bridges).
 *
 * Twilio stays a first-class integration kind (`twilio_sms`). Everything else —
 * Android GSM modems acting as HTTP gateways (TextBee, httpSMS,
 * android-sms-gateway) and any self-hosted HTTP bridge (iOS/iMessage bridges,
 * Gammu/Kannel/Jasmin shims) — flows through the single `sms_gateway`
 * integration kind, discriminated by `config.provider`.
 *
 * This module is deliberately dependency-free (no Prisma, no connectors import)
 * so it is trivially unit-testable and cannot form an import cycle: callers pass
 * already-decrypted `config`/`secrets` plain objects.
 *
 * Honesty: a gateway HTTP 200 only means "the gateway accepted the request for
 * delivery" — never "the handset delivered it". Delivery receipts require the
 * gateway's inbound webhooks, which are separate.
 */

export type SmsProviderId = 'textbee' | 'httpsms' | 'android_sms_gateway' | 'telnyx' | 'vonage' | 'messagebird' | 'plivo' | 'sinch' | 'infobip' | 'clicksend' | 'generic_http'

export const SMS_PROVIDER_IDS: SmsProviderId[] = ['textbee', 'httpsms', 'android_sms_gateway', 'telnyx', 'vonage', 'messagebird', 'plivo', 'sinch', 'infobip', 'clicksend', 'generic_http']

export function isSmsProviderId(value: unknown): value is SmsProviderId {
  return typeof value === 'string' && (SMS_PROVIDER_IDS as string[]).includes(value)
}

export type SmsGatewayConfig = Record<string, unknown>
export type SmsGatewaySecrets = Record<string, string>
export type SmsInput = { to: string; body: string }

export type SmsGatewayRequest = {
  url: string
  method: 'GET' | 'POST' | 'PUT'
  headers: Record<string, string>
  body?: string
}

/** A gateway-agnostic delivery state. Never inferred from HTTP 200 alone. */
export type SmsDeliveryState = 'created' | 'queued' | 'sending' | 'sent' | 'delivered' | 'failed' | 'expired' | 'unknown'

const DEFAULT_BASE: Record<SmsProviderId, string> = {
  textbee: 'https://api.textbee.dev/api/v1',
  httpsms: 'https://api.httpsms.com',
  android_sms_gateway: 'https://api.sms-gate.app',
  telnyx: 'https://api.telnyx.com/v2',
  vonage: 'https://rest.nexmo.com',
  messagebird: 'https://rest.messagebird.com',
  plivo: 'https://api.plivo.com/v1',
  sinch: 'https://us.sms.api.sinch.com',
  infobip: 'https://api.infobip.com',
  clicksend: 'https://rest.clicksend.com/v3',
  generic_http: '',
}

function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  return typeof v === 'string' ? v.trim() : ''
}

function baseUrl(provider: SmsProviderId, config: SmsGatewayConfig): string {
  const override = str(config, 'baseUrl')
  return (override || DEFAULT_BASE[provider]).replace(/\/+$/, '')
}

/**
 * Normalize a recipient to E.164-ish form: strip formatting (spaces, dashes,
 * parens, dots) and convert a leading `00` to `+`. A leading `+` is preserved.
 * We do NOT invent a country code — the gateway rejects what it cannot route.
 */
export function normalizePhone(raw: string): string {
  const trimmed = (raw ?? '').trim()
  const stripped = trimmed.replace(/[\s().-]/g, '')
  if (stripped.startsWith('00')) return `+${stripped.slice(2)}`
  return stripped
}

/** JSON-safe interpolation value (no surrounding quotes). */
function jsonValue(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

function authHeaders(provider: SmsProviderId, config: SmsGatewayConfig, secrets: SmsGatewaySecrets): Record<string, string> {
  if (provider === 'textbee' || provider === 'httpsms') {
    const apiKey = str(secrets, 'apiKey')
    return apiKey ? { 'x-api-key': apiKey } : {}
  }
  if (provider === 'telnyx') {
    const apiKey = str(secrets, 'apiKey')
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  }
  if (provider === 'messagebird') {
    const apiKey = str(secrets, 'apiKey')
    return apiKey ? { Authorization: `AccessKey ${apiKey}` } : {}
  }
  if (provider === 'sinch') {
    const apiKey = str(secrets, 'apiKey')
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  }
  if (provider === 'infobip') {
    const apiKey = str(secrets, 'apiKey')
    return apiKey ? { Authorization: `App ${apiKey}` } : {}
  }
  if (provider === 'clicksend') {
    const username = str(secrets, 'username')
    const apiKey = str(secrets, 'apiKey')
    if (!username || !apiKey) return {}
    return { Authorization: `Basic ${Buffer.from(`${username}:${apiKey}`).toString('base64')}` }
  }
  if (provider === 'plivo') {
    const authId = str(secrets, 'accountId') || str(secrets, 'username')
    const authToken = str(secrets, 'apiSecret') || str(secrets, 'password')
    if (!authId || !authToken) return {}
    return { Authorization: `Basic ${Buffer.from(`${authId}:${authToken}`).toString('base64')}` }
  }
  if (provider === 'vonage') {
    // Vonage's legacy SMS API authenticates with query parameters (added below).
    return {}
  }
  if (provider === 'android_sms_gateway') {
    const token = str(secrets, 'token')
    if (token) return { Authorization: `Bearer ${token}` }
    const username = str(secrets, 'username')
    if (username) {
      const password = str(secrets, 'password')
      return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` }
    }
    return {} // local-server mode requires no auth
  }
  // generic_http
  const headerName = str(config, 'authHeaderName')
  const authValue = str(secrets, 'authValue')
  if (headerName && authValue) return { [headerName]: authValue }
  return {}
}

/** Build the outgoing HTTP request for a real send. Pure + unit-testable. */
export function buildSendRequest(
  provider: string,
  config: SmsGatewayConfig,
  secrets: SmsGatewaySecrets,
  input: SmsInput
): SmsGatewayRequest {
  const to = normalizePhone(input.to)
  const id = provider as SmsProviderId
  const json = { 'content-type': 'application/json' }

  switch (id) {
    case 'textbee': {
      const deviceId = str(config, 'deviceId')
      return {
        url: `${baseUrl('textbee', config)}/gateway/send-sms`,
        method: 'POST',
        headers: { ...json, ...authHeaders('textbee', config, secrets) },
        body: JSON.stringify({ recipients: [to], message: input.body, ...(deviceId ? { deviceId } : {}) }),
      }
    }
    case 'httpsms': {
      const from = str(config, 'from')
      if (!from) throw new Error('httpSMS gateway config needs a "from" phone number (E.164)')
      return {
        url: `${baseUrl('httpsms', config)}/v1/messages/send`,
        method: 'POST',
        headers: { ...json, ...authHeaders('httpsms', config, secrets) },
        body: JSON.stringify({ content: input.body, from: normalizePhone(from), to }),
      }
    }
    case 'android_sms_gateway': {
      return {
        url: `${baseUrl('android_sms_gateway', config)}/3rdparty/v1/messages`,
        method: 'POST',
        headers: { ...json, ...authHeaders('android_sms_gateway', config, secrets) },
        body: JSON.stringify({ phoneNumbers: [to], textMessage: { text: input.body } }),
      }
    }
    case 'telnyx': {
      const from = str(config, 'from')
      if (!from) throw new Error('Telnyx SMS config needs a "from" number (E.164) or messaging profile id')
      return {
        url: `${baseUrl('telnyx', config)}/messages`,
        method: 'POST',
        headers: { ...json, ...authHeaders('telnyx', config, secrets) },
        body: JSON.stringify({ from, to, text: input.body }),
      }
    }
    case 'vonage': {
      const from = str(config, 'from')
      const apiKey = str(secrets, 'apiKey')
      const apiSecret = str(secrets, 'apiSecret')
      if (!from) throw new Error('Vonage SMS config needs a "from" sender')
      if (!apiKey || !apiSecret) throw new Error('Vonage SMS secrets need apiKey and apiSecret')
      const params = new URLSearchParams({ api_key: apiKey, api_secret: apiSecret, from, to, text: input.body })
      return {
        url: `${baseUrl('vonage', config)}/sms/json`,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      }
    }
    case 'messagebird': {
      const from = str(config, 'from')
      if (!from) throw new Error('MessageBird SMS config needs a "from" sender (number or alphanumeric originator)')
      return {
        url: `${baseUrl('messagebird', config)}/messages`,
        method: 'POST',
        headers: { ...json, ...authHeaders('messagebird', config, secrets) },
        body: JSON.stringify({ originator: from, recipients: [to.replace(/^\+/, '')], body: input.body }),
      }
    }
    case 'plivo': {
      const from = str(config, 'from')
      const authId = str(secrets, 'accountId') || str(secrets, 'username')
      if (!from) throw new Error('Plivo SMS config needs a "from" sender (number or sender id)')
      if (!authId) throw new Error('Plivo SMS secrets need accountId (Auth ID)')
      return {
        url: `${baseUrl('plivo', config)}/Account/${encodeURIComponent(authId)}/Message/`,
        method: 'POST',
        headers: { ...json, ...authHeaders('plivo', config, secrets) },
        body: JSON.stringify({ src: from, dst: to, text: input.body }),
      }
    }
    case 'sinch': {
      const from = str(config, 'from')
      const servicePlanId = str(config, 'servicePlanId')
      if (!from) throw new Error('Sinch SMS config needs a "from" number or sender')
      if (!servicePlanId) throw new Error('Sinch SMS config needs a servicePlanId')
      return {
        url: `${baseUrl('sinch', config)}/xms/v1/${encodeURIComponent(servicePlanId)}/batches`,
        method: 'POST',
        headers: { ...json, ...authHeaders('sinch', config, secrets) },
        body: JSON.stringify({ from, to: [to.replace(/^\+/, '')], body: input.body }),
      }
    }
    case 'infobip': {
      const from = str(config, 'from')
      if (!from) throw new Error('Infobip SMS config needs a "from" sender')
      return {
        url: `${baseUrl('infobip', config)}/sms/2/text/advanced`,
        method: 'POST',
        headers: { ...json, ...authHeaders('infobip', config, secrets) },
        body: JSON.stringify({ messages: [{ destinations: [{ to }], from, text: input.body }] }),
      }
    }
    case 'clicksend': {
      const from = str(config, 'from')
      return {
        url: `${baseUrl('clicksend', config)}/sms/send`,
        method: 'POST',
        headers: { ...json, ...authHeaders('clicksend', config, secrets) },
        body: JSON.stringify({ messages: [{ source: 'ais', ...(from ? { from } : {}), body: input.body, to }] }),
      }
    }
    case 'generic_http': {
      const url = str(config, 'url')
      if (!url) throw new Error('generic_http gateway config needs a destination "url"')
      const method = str(config, 'method') === 'PUT' ? 'PUT' : 'POST'
      const template = str(config, 'bodyTemplate')
      const body = template
        ? template
            .replace(/\{\{\s*to\s*\}\}/g, jsonValue(to))
            .replace(/\{\{\s*message\s*\}\}/g, jsonValue(input.body))
            .replace(/\{\{\s*from\s*\}\}/g, jsonValue(str(config, 'from')))
        : JSON.stringify({ to, message: input.body })
      return { url, method, headers: { ...json, ...authHeaders('generic_http', config, secrets) }, body }
    }
    default:
      throw new Error(`Unknown SMS gateway provider "${provider}"`)
  }
}

/** Build a read-only connectivity probe for a gateway. Pure + unit-testable. */
export function buildTestRequest(provider: string, config: SmsGatewayConfig, secrets: SmsGatewaySecrets): SmsGatewayRequest | null {
  const id = provider as SmsProviderId
  switch (id) {
    case 'textbee':
      return { url: `${baseUrl('textbee', config)}/gateway/devices`, method: 'GET', headers: authHeaders('textbee', config, secrets) }
    case 'httpsms':
      return { url: `${baseUrl('httpsms', config)}/v1/messages?limit=1`, method: 'GET', headers: authHeaders('httpsms', config, secrets) }
    case 'android_sms_gateway':
      return { url: `${baseUrl('android_sms_gateway', config)}/3rdparty/v1/messages?limit=1`, method: 'GET', headers: authHeaders('android_sms_gateway', config, secrets) }
    case 'telnyx':
      return { url: `${baseUrl('telnyx', config)}/messages?page[size]=1`, method: 'GET', headers: authHeaders('telnyx', config, secrets) }
    case 'vonage': {
      const apiKey = str(secrets, 'apiKey')
      const apiSecret = str(secrets, 'apiSecret')
      if (!apiKey || !apiSecret) return null
      const params = new URLSearchParams({ api_key: apiKey, api_secret: apiSecret })
      return { url: `${baseUrl('vonage', config)}/account/get-balance?${params.toString()}`, method: 'GET', headers: {} }
    }
    case 'messagebird':
      return { url: `${baseUrl('messagebird', config)}/messages?limit=1`, method: 'GET', headers: authHeaders('messagebird', config, secrets) }
    case 'plivo': {
      const authId = str(secrets, 'accountId') || str(secrets, 'username')
      if (!authId) return null
      return { url: `${baseUrl('plivo', config)}/Account/${encodeURIComponent(authId)}/`, method: 'GET', headers: authHeaders('plivo', config, secrets) }
    }
    case 'sinch': {
      const servicePlanId = str(config, 'servicePlanId')
      if (!servicePlanId) return null
      return { url: `${baseUrl('sinch', config)}/xms/v1/${encodeURIComponent(servicePlanId)}/batches?page_size=1`, method: 'GET', headers: authHeaders('sinch', config, secrets) }
    }
    case 'infobip':
      return { url: `${baseUrl('infobip', config)}/sms/1/reports?limit=1`, method: 'GET', headers: authHeaders('infobip', config, secrets) }
    case 'clicksend':
      return { url: `${baseUrl('clicksend', config)}/account`, method: 'GET', headers: authHeaders('clicksend', config, secrets) }
    case 'generic_http':
      // No standardized read-only endpoint — the caller decides how to probe.
      return null
    default:
      return null
  }
}

/** Best-effort extraction of the gateway's message/batch id from a response. */
export function extractMessageId(provider: string, data: unknown): string {
  const d = data as Record<string, unknown> | null
  if (!d || typeof d !== 'object') return ''
  const inner = (d.data && typeof d.data === 'object' ? (d.data as Record<string, unknown>) : d)
  for (const key of ['smsBatchId', 'id', 'messageId', 'message_id', 'sid', 'message_uuid', 'message-id']) {
    const v = inner[key] ?? d[key]
    if (typeof v === 'string' && v) return v
  }
  const messageArrays = [inner.messages, (d as { messages?: unknown }).messages]
  for (const list of messageArrays) {
    if (!Array.isArray(list)) continue
    const first = list[0] as Record<string, unknown> | undefined
    for (const key of ['message-id', 'messageId', 'message_id', 'id']) {
      const v = first?.[key]
      if (typeof v === 'string' && v) return v
    }
  }
  return ''
}

/**
 * Map a provider-supplied raw status string to a gateway-agnostic delivery
 * state. Used when a gateway's inbound webhook reports delivery — an HTTP 2xx
 * on send NEVER maps to `delivered`.
 */
export function normalizeDeliveryState(provider: string, raw: unknown): SmsDeliveryState {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!value) return 'unknown'
  if (['delivered', 'delivery_success', 'received'].includes(value)) return 'delivered'
  if (['sent', 'message_sent', 'success', 'succeeded', 'ok'].includes(value)) return 'sent'
  if (['queued', 'pending', 'accepted', 'created'].includes(value)) return 'queued'
  if (['sending', 'in_progress', 'processing'].includes(value)) return 'sending'
  if (['failed', 'message_failed', 'error', 'undelivered', 'rejected', 'cancelled', 'canceled'].includes(value)) return 'failed'
  if (['expired', 'timeout', 'timed_out'].includes(value)) return 'expired'
  void provider
  return 'unknown'
}

/** Redact any stored secret values that leaked into an error/log line. */
function redact(text: string, secrets: SmsGatewaySecrets): string {
  let out = text || 'unknown error'
  for (const value of Object.values(secrets)) {
    if (value && value.length >= 6) out = out.split(value).join('[redacted]')
  }
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > 300 ? `${out.slice(0, 297)}...` : out
}

export type SmsSendOutcome = { providerId: SmsProviderId; messageId: string; detail: string }

/**
 * Send one SMS through the configured gateway. Throws a sanitized Error on
 * failure. A 2xx response means "accepted for delivery", not "delivered" —
 * `detail` and the returned id make that explicit.
 */
export async function sendSmsGateway(
  provider: string,
  config: SmsGatewayConfig,
  secrets: SmsGatewaySecrets,
  input: SmsInput
): Promise<SmsSendOutcome> {
  if (!isSmsProviderId(provider)) throw new Error(`Unknown SMS gateway provider "${provider}"`)
  if (!input.to) throw new Error('Message has no recipient address')

  const req = buildSendRequest(provider, config, secrets, input)
  try {
    // SSRF guard: the gateway URL is admin-configured, but a poisoned value must
    // not be able to reach loopback/link-local/internal hosts. Self-hosted
    // gateways on a trusted LAN are allowed explicitly via allowPrivate.
    await resolveSafeGatewayUrl(req.url, config.allowPrivate === true)
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(15_000),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok && provider === 'vonage') {
      const entry = (data as { messages?: Array<{ status?: string; 'error-text'?: string }> }).messages?.[0]
      if (entry && entry.status !== '0') {
        throw new Error(redact(`Gateway vonage rejected the send: ${entry['error-text'] ?? `status ${entry.status}`}`, secrets))
      }
    }
    if (!res.ok) {
      const message = (data as { message?: string; error?: string }).message ?? (data as { error?: string }).error
      throw new Error(redact(`Gateway ${provider} rejected the send (HTTP ${res.status}): ${message ?? res.statusText}`, secrets))
    }
    const messageId = extractMessageId(provider, data)
    return { providerId: provider, messageId, detail: `Accepted by ${provider}${messageId ? ` (id ${messageId})` : ''} — awaiting handset delivery` }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Gateway ')) throw err
    throw new Error(redact(err instanceof Error ? err.message : String(err), secrets))
  }
}

/** Real connectivity test. Read-only probe where possible; never claims delivery. */
export async function testSmsGateway(provider: string, config: SmsGatewayConfig, secrets: SmsGatewaySecrets): Promise<TestResult> {
  if (!isSmsProviderId(provider)) return { ok: false, detail: `Unknown SMS gateway provider "${provider}"` }

  if (provider === 'generic_http') {
    const testRecipient = str(config, 'testRecipient')
    if (!testRecipient) {
      return { ok: false, detail: 'generic_http has no standard read-only probe — set a testRecipient to run a live test (this sends a REAL SMS), then test again.' }
    }
    try {
      await sendSmsGateway(provider, config, secrets, { to: testRecipient, body: 'AI Secretary test message — gateway connectivity check.' })
      return { ok: true, detail: `generic_http accepted a real test message for ${normalizePhone(testRecipient)} (delivery itself depends on your bridge).` }
    } catch (err) {
      return { ok: false, detail: `generic_http test failed: ${redact(err instanceof Error ? err.message : String(err), secrets)}` }
    }
  }

  const req = buildTestRequest(provider, config, secrets)
  if (!req) return { ok: false, detail: `No test probe available for ${provider}` }
  try {
    await resolveSafeGatewayUrl(req.url, config.allowPrivate === true)
    const res = await fetch(req.url, { method: req.method, headers: req.headers, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
      return { ok: false, detail: `${provider} rejected the credentials (HTTP ${res.status}): ${redact(body.message ?? body.error ?? res.statusText, secrets)}` }
    }
    const data = await res.json().catch(() => ({}))
    let extra = ''
    if (provider === 'textbee') {
      const devices = (data as { data?: unknown[] }).data
      extra = Array.isArray(devices) ? ` — ${devices.length} device(s) registered` : ''
    }
    return { ok: true, detail: `${provider} connectivity verified${extra}` }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const timeout = reason.toLowerCase().includes('abort') || reason.toLowerCase().includes('timeout')
    return { ok: false, detail: timeout ? `${provider} did not respond within 10s (check baseUrl/network)` : `${provider} test failed: ${redact(reason, secrets)}` }
  }
}
