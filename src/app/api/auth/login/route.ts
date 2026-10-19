import { z } from 'zod'
import { withPublic, json, fail, parseBody, rateLimit, createSession, sessionCookie } from '@/lib/api'
import { db } from '@/lib/db'
import { decryptSecret, secretIsEncrypted, verifyPassword } from '@/lib/crypto'
import { verifyTotp } from '@/lib/security/totp'
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
 * required — 401 `totp_required` / `totp_invalid` until one verifies.
 */
export const POST = withPublic(async (req) => {
  const body = await parseBody(req, schema)
  const email = body.email.trim().toLowerCase()

  if (!rateLimit(`login:${email}`, 10, 60_000)) {
    return fail(429, 'Too many sign-in attempts. Try again in a minute.')
  }

  // Email case is normalized in JS (SQLite has no case-insensitive unique lookup).
  const users = await db.user.findMany({
    select: { id: true, orgId: true, email: true, passwordHash: true, name: true, role: true, twoFactorEnabled: true, twoFactorSecret: true },
  })
  const user = users.find((u) => u.email.toLowerCase() === email)

  if (!user || !verifyPassword(body.password, user.passwordHash)) {
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
    if (!secret || !verifyTotp(secret, body.code)) {
      return fail(401, 'Two-factor code is not valid — try the current code from your authenticator app', { code: 'totp_invalid' })
    }
  }

  const { token, expiresAt } = await createSession(user.id)

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
