import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Server-held key material. Never exposed to the client.
 * Priority: APP_SECRET env var > .data/secret.key file (created on first boot).
 */
const DATA_DIR = path.join(process.cwd(), '.data')
const KEY_FILE = path.join(DATA_DIR, 'secret.key')

let cachedKey: Buffer | null = null

export function getServerKey(): Buffer {
  if (cachedKey) return cachedKey
  if (process.env.APP_SECRET) {
    cachedKey = crypto.createHash('sha256').update(process.env.APP_SECRET).digest()
    return cachedKey
  }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 })
  }
  cachedKey = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex')
  return cachedKey
}

/* ---------------- symmetric encryption (provider credentials) ---------------- */

export function encryptSecret(plaintext: string): string {
  if (!plaintext) return ''
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', getServerKey(), iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join(':')
}

export function decryptSecret(ciphertext: string): string {
  if (!ciphertext) return ''
  const parts = ciphertext.split(':')
  if (parts.length !== 4 || parts[0] !== 'v1') return ''
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', getServerKey(), Buffer.from(parts[1], 'base64url'))
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    return ''
  }
}

export function secretIsEncrypted(value: string): boolean {
  return value.startsWith('v1:') && value.split(':').length === 4
}

/* ---------------- passwords (scrypt) ---------------- */

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 })
  return `scrypt:${salt.toString('base64url')}:${hash.toString('base64url')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  try {
    const salt = Buffer.from(parts[1], 'base64url')
    const expected = Buffer.from(parts[2], 'base64url')
    const actual = crypto.scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1 })
    return crypto.timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

/* ---------------- tokens & signatures ---------------- */

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url')
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function hmacSign(value: string, key?: string): string {
  return crypto.createHmac('sha256', key ?? getServerKey()).update(value).digest('hex')
}

export function hmacVerify(value: string, signature: string, key?: string): boolean {
  try {
    const expected = Buffer.from(hmacSign(value, key))
    const actual = Buffer.from(signature)
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

export function newId(): string {
  return crypto.randomUUID()
}
