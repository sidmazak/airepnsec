import { z } from 'zod'
import { withPublic, json, fail, parseBody, rateLimit, rateLimitShared, clientIp, createSession, sessionCookie } from '@/lib/api'
import { db } from '@/lib/db'
import { decryptSecret, secretIsEncrypted, verifyPassword } from '@/lib/crypto'
import { verifyTotpStep } from '@/lib/security/totp'
import { audit } from '@/lib/audit'

const schema = z.object({
  email: z.string().min(1, 'Email is required'),
  password: z.string().min(1, 'Password is required'),
  code: z.string().max(10).optional(),
})

/**
 * POST /api/auth/login {email, password, code?}
 * Sets the HttpOnly session cookie on success. Generic error message so we
 * never disclose whether an email exists. Per-email brute-force throttle.
 * When the account has TOTP 2FA enabled, a current authenticator `code` is
 * required — 401 `totp_required` / `totp_invalid` until one verifies. Each code
 * is accepted only once (replay protection via the consumed TOTP step).
 */
export const POST = withPublic(async (req) => {
  const body = await parseBody(req, schema)
  const email = body.email.trim().toLowerCase()

  if (!rateLimit(`login:${email}`, 10, 60_000)) {
    return fail(429, 'Too many sign-in attempts. Try again in a minute.', undefined, { 'retry-after': '60' })
  }
  // Per-IP throttle catches credential stuffing across many different emails.
  // The shared (database-backed) counter holds when more than one instance runs.
  if (!rateLimit(`login-ip:${clientIp(req)}`, 30, 60_000)) {
    return fail(429, 'Too many sign-in attempts from this address. Try again in a minute.', undefined, { 'retry-after': '60' })
  }
  if (!(await rateLimitShared(`login:${email}`, 10, 60_000))) {
    return fail(429, 'Too many sign-in attempts. Try again in a minute.', undefined, { 'retry-after': '60' })
  }

  const select = {
    id: true, orgId: true, email: true, passwordHash: true, name: true, role: true,
    twoFactorEnabled: true, twoFactorSecret: true, twoFactorLastCounter: true, active: true,
  } as const
  // Emails are stored lowercase on every write path; use the unique index directly.
  // The fallback is deliberately BOUNDED (50 rows, id/email only) and self-healing:
  // it normalises a legacy mixed-case row instead of loading the whole user table.
  let user = await db.user.findUnique({ where: { email }, select })
  if (!user) {
    const legacy = await db.user.findMany({
      where: { email: { not: '' } },
      select: { id: true, email: true, passwordHash: true, name: true, role: true, twoFactorEnabled: true, twoFactorSecret: true, twoFactorLastCounter: true, active: true, orgId: true },
      take: 50,
    })
    const match = legacy.find((u) => u.email.trim().toLowerCase() === email)
    if (match) {
      await db.user.update({ where: { id: match.id }, data: { email } })
      user = { ...match, email }
    }
  }

  if (!user || !user.active || !verifyPassword(body.password, user.passwordHash)) {
    // Deactivated members get the same generic message — no account-state disclosure.
    return fail(401, 'Invalid email or password', { code: 'invalid_credentials' })
  }

  if (user.twoFactorEnabled) {
    if (!body.code || !body.code.trim()) {
      return fail(401, 'Two-factor code required', { code: 'totp_required' })
    }
    let secret = ''
    try {
      secret = secretIsEncrypted(user.twoFactorSecret)
        ? decryptSecret(user.twoFactorSecret)
        : /^[A-Z2-7]+$/.test(user.twoFactorSecret)
          ? user.twoFactorSecret
          : ''
    } catch {
      secret = ''
    }
    const { ok, counter } = secret ? verifyTotpStep(secret, body.code) : { ok: false, counter: 0 }
    if (!ok) {
      return fail(401, 'Two-factor code is not valid — try the current code from your authenticator app', { code: 'totp_invalid' })
    }
    // Replay protection: a TOTP step may be consumed only once.
    if (counter > 0 && counter <= user.twoFactorLastCounter) {
      return fail(401, 'That two-factor code was already used — wait for the next code from your authenticator app', { code: 'totp_replayed' })
    }
    await db.user.update({ where: { id: user.id }, data: { twoFactorLastCounter: counter } })
  }

  const { token, expiresAt } = await createSession(user.id)
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })

  await audit({
    orgId: user.orgId,
    actorType: 'user',
    actorId: user.id,
    action: 'auth.login',
    entity: 'user',
    entityId: user.id,
    meta: { email: user.email, twoFactor: user.twoFactorEnabled },
  })

  const res = json({
    ok: true,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  })
  res.headers.append('set-cookie', sessionCookie(token, expiresAt))
  return res
})
