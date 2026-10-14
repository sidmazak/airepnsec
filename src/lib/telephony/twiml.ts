import { createHmac, timingSafeEqual } from 'crypto'
import { db } from '@/lib/db'
import { integrationConfig, decryptSecrets, str, type IntegrationKind } from '@/lib/integrations/connectors'

/**
 * Real Twilio inbound telephony support (voice + SMS).
 * - TwiML responses are generated server-side (the phone receptionist "speaks" via
 *   Twilio's own <Say>/<Gather speech> — no media leaves our DB).
 * - Every webhook is authenticated with the REAL Twilio signature scheme:
 *   base64(HMAC-SHA1(authToken, fullUrl + sorted("keyvalue" params))).
 */

/* ---------------- signature verification ---------------- */

export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signatureHeader: string | null): boolean {
  if (!authToken || !signatureHeader) return false
  const data = url + Object.keys(params).sort().map((k) => `${k}${params[k]}`).join('')
  const expected = createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64')
  const a = Buffer.from(expected)
  const b = Buffer.from(signatureHeader)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Behind proxies the absolute URL Twilio signed may differ from what this server
 * sees. Validate against the honest candidate list: the integration's configured
 * publicBaseUrl first (what the operator told Twilio to call), then PUBLIC_BASE_URL
 * env, then the forwarded request URL. Any match = authentic request.
 */
export function candidateWebhookUrls(req: { headers: Headers; url: string }, config: Record<string, unknown>, pathname: string): string[] {
  const out: string[] = []
  const push = (base: string) => {
    const clean = base.replace(/\/$/, '')
    if (/^https?:\/\//.test(clean) && !out.includes(`${clean}${pathname}`)) out.push(`${clean}${pathname}`)
  }
  const cfgBase = str(config, 'publicBaseUrl')
  if (cfgBase) push(cfgBase)
  if (process.env.PUBLIC_BASE_URL) push(process.env.PUBLIC_BASE_URL)
  const forwardedHost = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
  if (forwardedHost) {
    const proto = req.headers.get('x-forwarded-proto') ?? (forwardedHost.startsWith('localhost') || forwardedHost.startsWith('127.') ? 'http' : 'https')
    push(`${proto}://${forwardedHost}`)
  }
  return out
}

/* ---------------- org + integration routing by called/sms number ---------------- */

function digits(v: string): string {
  return (v || '').replace(/\D/g, '')
}

export type TelephonyRoute = {
  orgId: string
  integration: { id: string; kind: IntegrationKind; configJson: string; secretsEnc: string }
  secrets: Record<string, string>
}

/** Find the org whose twilio integration owns the destination number (To). */
export async function resolveTelephonyRoute(kinds: IntegrationKind[], toNumber: string): Promise<TelephonyRoute | null> {
  const rows = await db.integration.findMany({
    where: { kind: { in: kinds }, enabled: true },
    orderBy: { createdAt: 'asc' },
  })
  const wanted = digits(toNumber)
  const exact = rows.find((r) => {
    const from = str(integrationConfig(r), 'from')
    return wanted && digits(from) === wanted
  })
  const chosen = exact ?? (rows.length === 1 ? rows[0] : null) // single-org deployments: accept sole number
  if (!chosen) return null
  const secrets = decryptSecrets(chosen)
  if (!secrets.accountSid || !secrets.authToken) return null
  return {
    orgId: chosen.orgId,
    integration: { id: chosen.id, kind: chosen.kind as IntegrationKind, configJson: chosen.configJson, secretsEnc: chosen.secretsEnc },
    secrets,
  }
}

/* ---------------- TwiML builders (escaped, minimal but real) ---------------- */

function esc(v: string): string {
  return (v || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Strip markdown/symbols that read badly over TTS on a phone call. */
export function speakable(text: string): string {
  return (text || '')
    .replace(/[*_`#>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200)
}

export function twiml(inner: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, {
    status: 200,
    headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export function say(text: string, opts: { voice?: string; language?: string } = {}): string {
  const voice = opts.voice || 'alice'
  const language = opts.language || 'en-US'
  return `<Say voice="${esc(voice)}" language="${esc(language)}">${esc(speakable(text))}</Say>`
}

export function gatherSpeech(actionPath: string, opts: { sayText?: string; voice?: string; voiceName?: string; language?: string; hints?: string } = {}): string {
  const attrs = [
    `input="speech"`,
    `action="${esc(actionPath)}"`,
    `method="POST"`,
    `speechTimeout="auto"`,
    `language="${esc(opts.language || 'en-US')}"`,
    opts.hints ? `hints="${esc(opts.hints)}"` : '',
  ].filter(Boolean).join(' ')
  const inner = opts.sayText ? say(opts.sayText, { voice: opts.voiceName || opts.voice, language: opts.language }) : ''
  return `<Gather ${attrs}>${inner}</Gather>`
}

export function dialNumber(number: string, opts: { ringTimeoutSec?: number } = {}): string {
  return `<Dial timeout="${opts.ringTimeoutSec ?? 25}">${esc(number)}</Dial>`
}

export const hangup = '<Hangup/>'
export function redirect(url: string): string {
  return `<Redirect method="POST">${esc(url)}</Redirect>`
}

/* ---------------- shared webhook plumbing ---------------- */

/** Parse Twilio's application/x-www-form-urlencoded POST body into plain strings. */
export async function formParams(req: Request): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  try {
    const form = await req.formData()
    for (const [k, v] of form.entries()) {
      if (typeof v === 'string') out[k] = v
    }
  } catch {
    /* empty body → no params */
  }
  return out
}

/** Suffix-digit customer match for caller ID (same tolerance as the receptionist). */
export async function matchCustomerByPhone(orgId: string, phone: string) {
  const wanted = digits(phone)
  if (!wanted || wanted.length < 4) return null
  const all = await db.customer.findMany({ where: { orgId, phone: { not: '' } }, take: 500 })
  return (
    all.find((c) => {
      const cd = c.phone.replace(/\D/g, '')
      return cd === wanted || cd.endsWith(wanted) || wanted.endsWith(cd)
    }) ?? null
  )
}

export async function logWebhook(input: {
  orgId: string
  provider: string
  eventId: string
  payload: Record<string, string>
  signatureValid: boolean
  result: 'received' | 'processed' | 'duplicate' | 'rejected'
}) {
  const row = {
    orgId: input.orgId,
    provider: input.provider,
    eventId: input.eventId.slice(0, 180),
    payload: JSON.stringify(input.payload).slice(0, 8000),
    signatureValid: input.signatureValid,
    result: input.result,
    processedAt: input.result === 'processed' ? new Date() : null,
  }
  try {
    await db.webhookEvent.create({ data: row })
  } catch (err) {
    const code = (err as { code?: string })?.code
    if (code !== 'P2002') {
      console.error('[telephony] webhook log failed:', err instanceof Error ? err.message : err)
      return { duplicate: false }
    }
    // Unique collision → Twilio retried an event we already logged. A previously
    // REJECTED attempt (bad signature) must not block a properly signed retry.
    const existing = await db.webhookEvent.findUnique({ where: { eventId: row.eventId } }).catch(() => null)
    if (existing && existing.result === 'rejected') {
      await db.webhookEvent.update({ where: { id: existing.id }, data: row }).catch(() => {})
      return { duplicate: false }
    }
    return { duplicate: true }
  }
  return { duplicate: false }
}

export function plainResponse(status: number, body: string, contentType = 'text/plain'): Response {
  return new Response(body, { status, headers: { 'content-type': `${contentType}; charset=utf-8`, 'cache-control': 'no-store' } })
}
