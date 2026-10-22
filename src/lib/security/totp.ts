import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

/**
 * RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s step) — enough for standard
 * authenticator apps (Google Authenticator, 1Password, Aegis, …) with no
 * third-party dependency. Secrets are base32 (RFC 4648, no padding).
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch)
    if (idx < 0) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** 160-bit random secret, base32-encoded for authenticator apps. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

/** HOTP value for a counter (RFC 4226 dynamic truncation). */
function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac('sha1', secret).update(msg).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const code = ((mac[offset] & 0x7f) << 24) | ((mac[offset + 1] & 0xff) << 16) | ((mac[offset + 2] & 0xff) << 8) | (mac[offset + 3] & 0xff)
  return String(code % 10 ** digits).padStart(digits, '0')
}

/** Current TOTP code for a base32 secret (used by tests and diagnostics). */
export function totpAt(secretBase32: string, timeMs = Date.now(), stepSeconds = 30, digits = 6): string {
  const counter = Math.floor(timeMs / 1000 / stepSeconds)
  return hotp(base32Decode(secretBase32), counter, digits)
}

/**
 * Verify a code with ±`window` steps of clock tolerance. Constant-time compare;
 * malformed input is rejected before any crypto.
 */
export function verifyTotp(secretBase32: string, code: string, opts: { window?: number; timeMs?: number; stepSeconds?: number; digits?: number } = {}): boolean {
  const digits = opts.digits ?? 6
  const cleaned = (code ?? '').replace(/\D/g, '')
  if (cleaned.length !== digits) return false
  const secret = base32Decode(secretBase32)
  if (secret.length === 0) return false
  const step = opts.stepSeconds ?? 30
  const counter = Math.floor((opts.timeMs ?? Date.now()) / 1000 / step)
  const window = opts.window ?? 1
  const candidate = Buffer.from(cleaned)
  for (let offset = -window; offset <= window; offset++) {
    const expected = Buffer.from(hotp(secret, counter + offset, digits))
    if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) return true
  }
  return false
}

/**
 * Verify a code and report WHICH time step matched. The step (counter) is what
 * replay protection needs: a code is only accepted once per step, so a captured
 * code cannot be replayed inside the tolerance window.
 */
export function verifyTotpStep(
  secretBase32: string,
  code: string,
  opts: { window?: number; timeMs?: number; stepSeconds?: number; digits?: number } = {}
): { ok: boolean; counter: number } {
  const digits = opts.digits ?? 6
  const cleaned = (code ?? '').replace(/\D/g, '')
  if (cleaned.length !== digits) return { ok: false, counter: 0 }
  const secret = base32Decode(secretBase32)
  if (secret.length === 0) return { ok: false, counter: 0 }
  const step = opts.stepSeconds ?? 30
  const counter = Math.floor((opts.timeMs ?? Date.now()) / 1000 / step)
  const window = opts.window ?? 1
  const candidate = Buffer.from(cleaned)
  for (let offset = -window; offset <= window; offset++) {
    const expected = Buffer.from(hotp(secret, counter + offset, digits))
    if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) {
      return { ok: true, counter: counter + offset }
    }
  }
  return { ok: false, counter }
}

/** otpauth:// URI for QR rendering or manual entry. */
export function otpauthUrl(input: { secret: string; account: string; issuer: string }): string {
  const issuer = input.issuer.trim() || 'AI Secretary'
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(input.account)}`
  const params = new URLSearchParams({ secret: input.secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' })
  return `otpauth://totp/${label}?${params.toString()}`
}
