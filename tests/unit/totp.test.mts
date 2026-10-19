import test from 'node:test'
import assert from 'node:assert/strict'
import { base32Decode, base32Encode, generateTotpSecret, otpauthUrl, totpAt, verifyTotp } from '../../src/lib/security/totp.ts'

// RFC 6238 Appendix B, SHA1 seed "12345678901234567890" → base32
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

test('base32 round-trips arbitrary bytes', () => {
  const buf = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0xab, 0xcd])
  assert.deepEqual(base32Decode(base32Encode(buf)), buf)
})

test('generateTotpSecret produces a 32-char base32 secret', () => {
  const secret = generateTotpSecret()
  assert.match(secret, /^[A-Z2-7]{32}$/)
})

test('totpAt matches RFC 6238 SHA1 test vectors (6 digits)', () => {
  const vectors: Array<[number, string]> = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ]
  for (const [seconds, expected] of vectors) {
    assert.equal(totpAt(RFC_SECRET, seconds * 1000), expected, `vector ${seconds}`)
  }
})

test('verifyTotp accepts the current step and ±1 step, rejects stale or malformed', () => {
  const now = 1_700_000_000_000
  const current = totpAt(RFC_SECRET, now)
  assert.equal(verifyTotp(RFC_SECRET, current, { timeMs: now }), true)
  // 30 s in the past / future stays valid inside the default window
  assert.equal(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now - 30_000), { timeMs: now }), true)
  assert.equal(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now + 30_000), { timeMs: now }), true)
  // 90 s away is outside the window
  assert.equal(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now + 90_000), { timeMs: now }), false)
  // wrong / malformed input
  assert.equal(verifyTotp(RFC_SECRET, '000000', { timeMs: now }), current === '000000')
  assert.equal(verifyTotp(RFC_SECRET, 'abc', { timeMs: now }), false)
  assert.equal(verifyTotp('', current, { timeMs: now }), false)
})

test('otpauthUrl is a valid otpauth URI with the secret and issuer', () => {
  const url = otpauthUrl({ secret: RFC_SECRET, account: 'owner@example.com', issuer: 'Acme Salon' })
  assert.match(url, /^otpauth:\/\/totp\/Acme%20Salon:owner%40example\.com\?/)
  assert.match(url, new RegExp(`secret=${RFC_SECRET}`))
  assert.match(url, /digits=6/)
  assert.match(url, /period=30/)
})
