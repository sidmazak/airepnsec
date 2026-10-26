/**
 * Native transactional-email API adapters (BYOK, no vendor SDK).
 *
 * One `email_api` integration kind, discriminated by `config.provider`:
 * SendGrid, Mailgun, Postmark, Resend, Brevo. Builders are pure and
 * unit-testable; `sendViaEmailApi` performs the real HTTP call and returns the
 * provider's message id. A 2xx means "accepted by the provider", not "opened".
 */

export type EmailApiProviderId = 'sendgrid' | 'mailgun' | 'postmark' | 'resend' | 'brevo' | 'mailjet' | 'sparkpost' | 'elasticemail'

export const EMAIL_API_PROVIDER_IDS: EmailApiProviderId[] = ['sendgrid', 'mailgun', 'postmark', 'resend', 'brevo', 'mailjet', 'sparkpost', 'elasticemail']

export function isEmailApiProviderId(value: unknown): value is EmailApiProviderId {
  return typeof value === 'string' && (EMAIL_API_PROVIDER_IDS as string[]).includes(value)
}

export const EMAIL_API_LABELS: Record<EmailApiProviderId, string> = {
  sendgrid: 'SendGrid',
  mailgun: 'Mailgun',
  postmark: 'Postmark',
  resend: 'Resend',
  brevo: 'Brevo',
  mailjet: 'Mailjet',
  sparkpost: 'SparkPost',
  elasticemail: 'Elastic Email',
}

export type EmailMessage = { to: string; subject: string; text: string; html?: string }
export type EmailApiConfig = Record<string, unknown>
export type EmailApiSecrets = Record<string, string>

export type EmailApiRequest = { url: string; method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }

function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  return typeof v === 'string' ? v.trim() : ''
}

export function sendgridRequest(config: EmailApiConfig, apiKey: string, message: EmailMessage): EmailApiRequest {
  const from = str(config, 'from')
  if (!from) throw new Error('SendGrid config needs a "from" email address')
  return {
    url: 'https://api.sendgrid.com/v3/mail/send',
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: message.to }] }],
      from: { email: from },
      subject: message.subject,
      content: [
        { type: 'text/plain', value: message.text },
        ...(message.html ? [{ type: 'text/html', value: message.html }] : []),
      ],
    }),
  }
}

export function mailgunRequest(config: EmailApiConfig, apiKey: string, message: EmailMessage): EmailApiRequest {
  const from = str(config, 'from')
  const domain = str(config, 'domain')
  if (!from) throw new Error('Mailgun config needs a "from" email address')
  if (!domain) throw new Error('Mailgun config needs the sending "domain" (e.g. mg.example.com)')
  const region = str(config, 'region').toLowerCase()
  const base = region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net'
  const form = new URLSearchParams({ from, to: message.to, subject: message.subject, text: message.text })
  if (message.html) form.set('html', message.html)
  return {
    url: `${base}/v3/${encodeURIComponent(domain)}/messages`,
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  }
}

export function postmarkRequest(config: EmailApiConfig, apiKey: string, message: EmailMessage): EmailApiRequest {
  const from = str(config, 'from')
  if (!from) throw new Error('Postmark config needs a "from" email address')
  return {
    url: 'https://api.postmarkapp.com/email',
    method: 'POST',
    headers: { 'x-postmark-server-token': apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      From: from,
      To: message.to,
      Subject: message.subject,
      TextBody: message.text,
      ...(message.html ? { HtmlBody: message.html } : {}),
      MessageStream: str(config, 'messageStream') || 'outbound',
    }),
  }
}

export function resendRequest(config: EmailApiConfig, apiKey: string, message: EmailMessage): EmailApiRequest {
  const from = str(config, 'from')
  if (!from) throw new Error('Resend config needs a "from" email address')
  return {
    url: 'https://api.resend.com/emails',
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    }),
  }
}

export function brevoRequest(config: EmailApiConfig, apiKey: string, message: EmailMessage): EmailApiRequest {
  const from = str(config, 'from')
  if (!from) throw new Error('Brevo config needs a "from" email address')
  const fromName = str(config, 'fromName')
  return {
    url: 'https://api.brevo.com/v3/smtp/email',
    method: 'POST',
    headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: from, ...(fromName ? { name: fromName } : {}) },
      to: [{ email: message.to }],
      subject: message.subject,
      textContent: message.text,
      ...(message.html ? { htmlContent: message.html } : {}),
    }),
  }
}

export function mailjetRequest(config: EmailApiConfig, apiKey: string, apiSecret: string, message: EmailMessage): EmailApiRequest {
  const from = str(config, 'from')
  if (!from) throw new Error('Mailjet config needs a "from" email address')
  if (!apiSecret) throw new Error('Mailjet needs both an API key and an API secret')
  const fromName = str(config, 'fromName')
  return {
    url: 'https://api.mailjet.com/v3.1/send',
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      Messages: [{
        From: { Email: from, ...(fromName ? { Name: fromName } : {}) },
        To: [{ Email: message.to }],
        Subject: message.subject,
        TextPart: message.text,
        ...(message.html ? { HTMLPart: message.html } : {}),
      }],
    }),
  }
}

export function sparkpostRequest(config: EmailApiConfig, apiKey: string, message: EmailMessage): EmailApiRequest {
  const from = str(config, 'from')
  if (!from) throw new Error('SparkPost config needs a "from" email address')
  const fromName = str(config, 'fromName')
  return {
    url: 'https://api.sparkpost.com/api/v1/transmissions',
    method: 'POST',
    headers: { authorization: apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      recipients: [{ address: message.to }],
      content: {
        from: fromName ? `${fromName} <${from}>` : from,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      },
    }),
  }
}

export function elasticEmailRequest(config: EmailApiConfig, apiKey: string, message: EmailMessage): EmailApiRequest {
  const from = str(config, 'from')
  if (!from) throw new Error('Elastic Email config needs a "from" email address')
  const fromName = str(config, 'fromName')
  return {
    url: 'https://api.elasticemail.com/v4/emails',
    method: 'POST',
    headers: { 'x-elasticemail-apikey': apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      Recipients: [{ Email: message.to }],
      Content: {
        From: fromName ? `${fromName} <${from}>` : from,
        Subject: message.subject,
        Body: [
          { ContentType: 'PlainText', Content: message.text },
          ...(message.html ? [{ ContentType: 'HTML', Content: message.html }] : []),
        ],
      },
    }),
  }
}

export function buildEmailApiRequest(provider: string, config: EmailApiConfig, secrets: EmailApiSecrets, message: EmailMessage): EmailApiRequest {
  if (!isEmailApiProviderId(provider)) throw new Error(`Unknown email API provider "${provider}"`)
  const apiKey = str(secrets, 'apiKey')
  if (!apiKey) throw new Error('Email API integration is missing the apiKey secret')
  if (!message.to) throw new Error('Email has no recipient address')
  switch (provider) {
    case 'sendgrid': return sendgridRequest(config, apiKey, message)
    case 'mailgun': return mailgunRequest(config, apiKey, message)
    case 'postmark': return postmarkRequest(config, apiKey, message)
    case 'resend': return resendRequest(config, apiKey, message)
    case 'brevo': return brevoRequest(config, apiKey, message)
    case 'mailjet': return mailjetRequest(config, apiKey, str(secrets, 'apiSecret'), message)
    case 'sparkpost': return sparkpostRequest(config, apiKey, message)
    case 'elasticemail': return elasticEmailRequest(config, apiKey, message)
  }
}

/** Read-only credential probe per provider. Pure + unit-testable. */
export function buildEmailApiTestRequest(provider: string, config: EmailApiConfig, secrets: EmailApiSecrets): EmailApiRequest {
  if (!isEmailApiProviderId(provider)) throw new Error(`Unknown email API provider "${provider}"`)
  const apiKey = str(secrets, 'apiKey')
  if (!apiKey) throw new Error('Email API integration is missing the apiKey secret')
  switch (provider) {
    case 'sendgrid':
      return { url: 'https://api.sendgrid.com/v3/scopes', method: 'GET', headers: { authorization: `Bearer ${apiKey}` } }
    case 'mailgun': {
      const base = str(config, 'region').toLowerCase() === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net'
      return { url: `${base}/v3/domains?limit=1`, method: 'GET', headers: { authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}` } }
    }
    case 'postmark':
      return { url: 'https://api.postmarkapp.com/server', method: 'GET', headers: { 'x-postmark-server-token': apiKey, accept: 'application/json' } }
    case 'resend':
      return { url: 'https://api.resend.com/domains', method: 'GET', headers: { authorization: `Bearer ${apiKey}` } }
    case 'brevo':
      return { url: 'https://api.brevo.com/v3/account', method: 'GET', headers: { 'api-key': apiKey, accept: 'application/json' } }
    case 'mailjet':
      return {
        url: 'https://api.mailjet.com/v3/REST/apikey?limit=1',
        method: 'GET',
        headers: { authorization: `Basic ${Buffer.from(`${apiKey}:${str(secrets, 'apiSecret')}`).toString('base64')}`, accept: 'application/json' },
      }
    case 'sparkpost':
      return { url: 'https://api.sparkpost.com/api/v1/account', method: 'GET', headers: { authorization: apiKey, accept: 'application/json' } }
    case 'elasticemail':
      return { url: 'https://api.elasticemail.com/v4/domains', method: 'GET', headers: { 'x-elasticemail-apikey': apiKey, accept: 'application/json' } }
  }
}

/** Extract the provider-assigned id from a send response. */
export function extractEmailMessageId(provider: string, data: unknown, headers?: { get(name: string): string | null }): string {
  const headerId = headers?.get('x-message-id') || ''
  if (headerId) return headerId
  const d = data as Record<string, unknown> | null
  if (!d || typeof d !== 'object') return ''
  for (const key of ['id', 'messageId', 'MessageID']) {
    const value = d[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

function redact(text: string, secrets: EmailApiSecrets): string {
  let out = text || 'unknown error'
  for (const value of Object.values(secrets)) {
    if (value && value.length >= 6) out = out.split(value).join('[redacted]')
  }
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > 300 ? `${out.slice(0, 297)}...` : out
}

export type EmailApiSendOutcome = { providerId: EmailApiProviderId; messageId: string; detail: string }

export async function sendViaEmailApi(
  provider: string,
  config: EmailApiConfig,
  secrets: EmailApiSecrets,
  message: EmailMessage
): Promise<EmailApiSendOutcome> {
  if (!isEmailApiProviderId(provider)) throw new Error(`Unknown email API provider "${provider}"`)
  const req = buildEmailApiRequest(provider, config, secrets, message)
  let res: Response
  try {
    res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    throw new Error(redact(`${EMAIL_API_LABELS[provider]} request failed: ${err instanceof Error ? err.message : String(err)}`, secrets))
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const detail = (data as { message?: string; error?: string; errors?: Array<{ message?: string }> }).errors?.[0]?.message
      ?? (data as { message?: string }).message
      ?? (data as { error?: string }).error
      ?? res.statusText
    throw new Error(redact(`${EMAIL_API_LABELS[provider]} rejected the email (HTTP ${res.status}): ${detail}`, secrets))
  }
  const messageId = extractEmailMessageId(provider, data, res.headers)
  return {
    providerId: provider,
    messageId,
    detail: `Accepted by ${EMAIL_API_LABELS[provider]}${messageId ? ` (id ${messageId})` : ''} — delivery receipts depend on the provider`,
  }
}

export type EmailApiTestResult = { ok: boolean; detail: string }

export async function testEmailApi(provider: string, config: EmailApiConfig, secrets: EmailApiSecrets): Promise<EmailApiTestResult> {
  if (!isEmailApiProviderId(provider)) return { ok: false, detail: `Unknown email API provider "${provider}"` }
  let req: EmailApiRequest
  try {
    req = buildEmailApiTestRequest(provider, config, secrets)
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : 'Email API is not configured' }
  }
  try {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
      return { ok: false, detail: `${EMAIL_API_LABELS[provider]} rejected the credentials (HTTP ${res.status}): ${redact(body.message ?? body.error ?? res.statusText, secrets)}` }
    }
    return { ok: true, detail: `${EMAIL_API_LABELS[provider]} credentials verified (send + delivery still depend on the provider)` }
  } catch (err) {
    return { ok: false, detail: `${EMAIL_API_LABELS[provider]} test failed: ${redact(err instanceof Error ? err.message : String(err), secrets)}` }
  }
}
