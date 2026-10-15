import { db } from '@/lib/db'
import { decryptSecret, hmacSign } from '@/lib/crypto'
import { parseJson } from '@/lib/org'

/**
 * Typed connector layer for third-party integrations (BYOK).
 * Every secret lives in Integration.secretsEnc (AES-256-GCM encrypted JSON) and
 * NEVER leaves the server — error messages are sanitized against secret values.
 */

export type IntegrationKind = 'smtp' | 'twilio_sms' | 'twilio_whatsapp' | 'twilio_voice' | 'sms_gateway' | 'caldav' | 'stripe' | 'webhook_out'

export const INTEGRATION_KINDS: IntegrationKind[] = ['smtp', 'twilio_sms', 'twilio_whatsapp', 'twilio_voice', 'sms_gateway', 'caldav', 'stripe', 'webhook_out']

/** Kinds that allow only one row per org (enforced at create time). */
export const SINGLETON_KINDS: IntegrationKind[] = ['smtp', 'twilio_sms', 'twilio_whatsapp', 'twilio_voice', 'sms_gateway', 'caldav', 'stripe']

export function isIntegrationKind(kind: string): kind is IntegrationKind {
  return (INTEGRATION_KINDS as string[]).includes(kind)
}

/** Non-secret config parsed from configJson. */
export function integrationConfig(integration: { configJson: string }): Record<string, unknown> {
  return parseJson<Record<string, unknown>>(integration.configJson, {})
}

/** Decrypted secrets as a plain object. Server-side use only. */
export function decryptSecrets(integration: { secretsEnc: string }): Record<string, string> {
  if (!integration.secretsEnc) return {}
  return parseJson<Record<string, string>>(decryptSecret(integration.secretsEnc), {})
}

/** Read a string field from a parsed config/secrets object. */
export function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  return typeof v === 'string' ? v.trim() : ''
}

/* ---------------- error sanitization ---------------- */

/**
 * Make an error honest but safe: redact any secret values that leaked into the
 * message, then truncate. Network errors are already safe but can be long.
 */
export function sanitizeMessage(message: string, integration?: { secretsEnc: string; configJson: string }): string {
  let out = message || 'unknown error'
  if (integration) {
    const secrets = Object.values(decryptSecrets(integration)).filter((v) => v && v.length >= 6)
    for (const secret of secrets) {
      out = out.split(secret).join('[redacted]')
    }
  }
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > 300 ? `${out.slice(0, 297)}...` : out
}

export type TestResult = { ok: boolean; detail: string }

/* ---------------- REAL network tests ---------------- */

/** SMTP: verify connection + credentials via nodemailer without sending mail. */
async function testSmtp(integration: { configJson: string; secretsEnc: string }): Promise<TestResult> {
  const config = integrationConfig(integration)
  const secrets = decryptSecrets(integration)
  const host = str(config, 'host')
  const port = Number(config.port)
  if (!host || !Number.isInteger(port) || port <= 0) {
    return { ok: false, detail: 'SMTP config needs a host and a numeric port' }
  }
  const secure = config.secure === true
  const user = str(secrets, 'user')
  const pass = str(secrets, 'pass')
  try {
    const nodemailer = (await import('nodemailer')).default
    const transport = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user ? { user, pass } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
    })
    await transport.verify()
    return { ok: true, detail: `SMTP connection verified (${host}:${port}, ${secure ? 'implicit TLS' : 'no implicit TLS'}${user ? ', authenticated' : ''})` }
  } catch (err) {
    const e = err as { message?: string; code?: string }
    return { ok: false, detail: `SMTP test failed: ${sanitizeMessage(e.message || e.code || 'connection failed', integration)}` }
  }
}

/** Twilio (SMS, WhatsApp, or Voice): real authenticated account fetch. */
async function testTwilio(kind: IntegrationKind, integration: { configJson: string; secretsEnc: string }): Promise<TestResult> {
  const config = integrationConfig(integration)
  const secrets = decryptSecrets(integration)
  const accountSid = str(secrets, 'accountSid')
  const authToken = str(secrets, 'authToken')
  const from = str(config, 'from')
  if (!accountSid || !authToken) return { ok: false, detail: 'Twilio secrets need accountSid and authToken' }
  if (!from) return { ok: false, detail: 'Twilio config needs a "from" sender (e.g. +15551234567 or whatsapp:+15551234567)' }
  if (kind === 'twilio_whatsapp' && !from.toLowerCase().startsWith('whatsapp:')) {
    return { ok: false, detail: 'WhatsApp "from" must be in whatsapp:+1555... format' }
  }
  if (kind === 'twilio_voice' && !/\+\d{6,}/.test(from)) {
    return { ok: false, detail: 'Voice "from" must be the Twilio voice-capable number in E.164 format (e.g. +15551234567)' }
  }
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}.json`, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string }
      return { ok: false, detail: `Twilio API rejected the credentials (HTTP ${res.status}): ${sanitizeMessage(body.message ?? res.statusText, integration)}` }
    }
    const account = (await res.json()) as { friendly_name?: string; status?: string }
    const channel = kind === 'twilio_whatsapp' ? 'WhatsApp' : kind === 'twilio_voice' ? 'Phone (voice)' : 'SMS'
    return {
      ok: true,
      detail: `Twilio ${channel} verified — account "${account.friendly_name ?? accountSid}" (${account.status ?? 'unknown'}), number ${from}`,
    }
  } catch (err) {
    return { ok: false, detail: `Twilio test failed: ${sanitizeMessage(err instanceof Error ? err.message : String(err), integration)}` }
  }
}

/** Stripe: real authenticated account fetch with the secret key. */
async function testStripe(integration: { configJson: string; secretsEnc: string }): Promise<TestResult> {
  const secrets = decryptSecrets(integration)
  const secretKey = str(secrets, 'secretKey')
  if (!secretKey) return { ok: false, detail: 'Stripe secrets need a secretKey (sk_live_... or sk_test_...)' }
  try {
    const res = await fetch('https://api.stripe.com/v1/account', {
      method: 'GET',
      headers: { Authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
      return { ok: false, detail: `Stripe API rejected the key (HTTP ${res.status}): ${sanitizeMessage(body.error?.message ?? res.statusText, integration)}` }
    }
    const account = (await res.json()) as { business_name?: string | null; charges_enabled?: boolean; id?: string }
    return {
      ok: true,
      detail: `Stripe verified — account ${account.id ?? 'unknown'} (${account.business_name || 'unnamed business'}), charges_enabled=${String(account.charges_enabled ?? false)}`,
    }
  } catch (err) {
    return { ok: false, detail: `Stripe test failed: ${sanitizeMessage(err instanceof Error ? err.message : String(err), integration)}` }
  }
}

/** Outbound webhook: really POST a signed test event to the destination URL. */
async function testWebhookOut(orgId: string, integration: { configJson: string; secretsEnc: string }): Promise<TestResult> {
  const config = integrationConfig(integration)
  const secrets = decryptSecrets(integration)
  const url = str(config, 'url')
  if (!/^https?:\/\//i.test(url)) return { ok: false, detail: 'webhook_out config needs a destination URL starting with http:// or https://' }
  const secret = str(secrets, 'secret')

  const org = await db.organization.findUnique({ where: { id: orgId }, select: { slug: true } })
  const rawBody = JSON.stringify({
    event: 'integration.test',
    sentAt: new Date().toISOString(),
    org: org?.slug ?? '',
  })
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': signWebhookPayload(rawBody, secret),
        'x-ais-event': 'integration.test',
      },
      body: rawBody,
      signal: AbortSignal.timeout(8_000),
    })
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, detail: `Destination responded HTTP ${res.status} ${res.statusText} — expected 2xx` }
    }
    return { ok: true, detail: `Test event delivered to ${url} (HTTP ${res.status})` }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const timeout = reason.includes('abort') || reason.toLowerCase().includes('timeout')
    return { ok: false, detail: timeout ? `Destination did not respond within 8s: ${url}` : `Webhook delivery failed: ${sanitizeMessage(reason, integration)}` }
  }
}

export async function testIntegration(orgId: string, integration: { kind: string; configJson: string; secretsEnc: string }): Promise<TestResult> {
  switch (integration.kind) {
    case 'smtp':
      return testSmtp(integration)
    case 'twilio_sms':
    case 'twilio_whatsapp':
    case 'twilio_voice':
      return testTwilio(integration.kind, integration)
    case 'sms_gateway': {
      const { testSmsGateway } = await import('@/lib/integrations/sms')
      return testSmsGateway(str(integrationConfig(integration), 'provider'), integrationConfig(integration), decryptSecrets(integration))
    }
    case 'caldav': {
      const { testCaldav } = await import('@/lib/integrations/caldav')
      return testCaldav(integration)
    }
    case 'stripe':
      return testStripe(integration)
    case 'webhook_out':
      return testWebhookOut(orgId, integration)
    default:
      return { ok: false, detail: `Unknown integration kind "${integration.kind}"` }
  }
}

/* ---------------- senders ---------------- */

export type EmailInput = { to: string; subject: string; text: string; html?: string }

/** Send a real email through the org's SMTP integration. Throws Error (sanitized) on failure. */
export async function sendEmail(integration: { kind: string; configJson: string; secretsEnc: string }, input: EmailInput): Promise<{ messageId: string }> {
  if (integration.kind !== 'smtp') throw new Error('sendEmail requires an smtp integration')
  const config = integrationConfig(integration)
  const secrets = decryptSecrets(integration)
  const host = str(config, 'host')
  const port = Number(config.port)
  const from = str(config, 'from')
  if (!host || !Number.isInteger(port) || !from) throw new Error('SMTP integration is missing host/port/from config')
  const user = str(secrets, 'user')
  const pass = str(secrets, 'pass')
  try {
    const nodemailer = (await import('nodemailer')).default
    const transport = nodemailer.createTransport({
      host,
      port,
      secure: config.secure === true,
      auth: user ? { user, pass } : undefined,
      connectionTimeout: 15_000,
    })
    const info = await transport.sendMail({
      from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
    })
    return { messageId: info.messageId ?? '' }
  } catch (err) {
    throw new Error(sanitizeMessage(err instanceof Error ? err.message : String(err), integration))
  }
}

export type TwilioInput = { to: string; body: string }

/**
 * Send a real SMS/WhatsApp message via the Twilio Messages API.
 * For twilio_whatsapp the destination "to" is normalized to whatsapp:+... form.
 * Returns the Twilio message sid.
 */
export async function sendTwilio(integration: { kind: string; configJson: string; secretsEnc: string }, input: TwilioInput): Promise<{ sid: string }> {
  if (integration.kind !== 'twilio_sms' && integration.kind !== 'twilio_whatsapp' && integration.kind !== 'twilio_voice') {
    throw new Error('sendTwilio requires a twilio_sms, twilio_whatsapp, or twilio_voice integration')
  }
  const config = integrationConfig(integration)
  const secrets = decryptSecrets(integration)
  const accountSid = str(secrets, 'accountSid')
  const authToken = str(secrets, 'authToken')
  const from = str(config, 'from')
  if (!accountSid || !authToken || !from) throw new Error('Twilio integration is missing accountSid/authToken secrets or the from sender')
  if (!input.to) throw new Error('Message has no recipient address')

  const to = integration.kind === 'twilio_whatsapp' && !input.to.toLowerCase().startsWith('whatsapp:')
    ? `whatsapp:${input.to}`
    : input.to
  // twilio_voice numbers can also send SMS (same Messages API)

  const form = new URLSearchParams({ To: to, From: from, Body: input.body })
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(15_000),
    })
    const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string }
    if (!res.ok) {
      throw new Error(sanitizeMessage(data.message ? `Twilio error ${res.status}: ${data.message}` : `Twilio HTTP ${res.status} ${res.statusText}`, integration))
    }
    if (!data.sid) throw new Error('Twilio accepted the message but returned no sid')
    return { sid: data.sid }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Twilio')) throw err
    throw new Error(sanitizeMessage(err instanceof Error ? err.message : String(err), integration))
  }
}

/** Hex HMAC-SHA256 signature for outbound webhook payloads ("none" when no secret is set). */
export function signWebhookPayload(rawBody: string, secret: string): string {
  if (!secret) return 'none'
  return hmacSign(rawBody, secret)
}

/* ---------------- lookup helpers ---------------- */

/** Find the enabled + usable integration of a kind (first match). */
export async function getEnabledIntegration(orgId: string, kind: IntegrationKind) {
  const rows = await db.integration.findMany({ where: { orgId, kind, enabled: true } })
  // SMTP may legitimately run as an anonymous relay (no credentials) — an
  // enabled row with host/port config is usable. Every other kind needs secrets.
  return (
    rows.find((r) => r.secretsEnc || (kind === 'smtp' && Boolean(str(integrationConfig(r), 'host')))) ?? null
  )
}

/** Find any integration of a kind, preferring enabled ones (used for inbound webhooks). */
export async function getUsableIntegration(orgId: string, kind: IntegrationKind) {
  const rows = await db.integration.findMany({ where: { orgId, kind } })
  return rows.find((r) => r.enabled && r.secretsEnc) ?? rows.find((r) => r.secretsEnc) ?? null
}

/* ---------------- SMS sender resolution (Twilio OR BYO gateway) ---------------- */

export type SmsSenderInfo = { channel: 'twilio' | 'gateway'; kind: IntegrationKind; integration: { kind: string; configJson: string; secretsEnc: string } }

/**
 * Resolve the org's outbound SMS sender: an enabled Twilio SMS integration
 * takes precedence; otherwise the enabled SMS gateway. Returns null when no SMS
 * channel can deliver. Unlike getEnabledIntegration this does NOT require stored
 * secrets — self-hosted gateways (android-sms-gateway local mode, an unauthenticated
 * LAN bridge) legitimately run credential-less, and the real test/send reports the truth.
 */
export async function getEnabledSmsSender(orgId: string): Promise<SmsSenderInfo | null> {
  const twilio = await getEnabledIntegration(orgId, 'twilio_sms')
  if (twilio) return { channel: 'twilio', kind: 'twilio_sms', integration: twilio }
  const gateways = await db.integration.findMany({ where: { orgId, kind: 'sms_gateway', enabled: true }, orderBy: { createdAt: 'asc' } })
  if (gateways[0]) return { channel: 'gateway', kind: 'sms_gateway', integration: gateways[0] }
  return null
}

/**
 * Send an SMS through whichever SMS channel the org has enabled. Throws a
 * sanitized Error when none is configured or the send fails. A success means
 * "accepted by the gateway/provider for delivery", never "delivered to a handset".
 */
export async function sendOrgSms(orgId: string, input: { to: string; body: string }): Promise<{ provider: string; messageId: string }> {
  const sender = await getEnabledSmsSender(orgId)
  if (!sender) throw new Error('No enabled SMS integration (Twilio or an SMS gateway) is configured')
  if (sender.channel === 'twilio') {
    const { sid } = await sendTwilio(sender.integration, input)
    return { provider: 'twilio', messageId: sid }
  }
  const { sendSmsGateway } = await import('@/lib/integrations/sms')
  const config = integrationConfig(sender.integration)
  const result = await sendSmsGateway(str(config, 'provider'), config, decryptSecrets(sender.integration), input)
  return { provider: result.providerId, messageId: result.messageId }
}
