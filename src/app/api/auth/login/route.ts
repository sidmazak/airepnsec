import { z } from 'zod'
import { withPublic, json, fail, parseBody, rateLimit, createSession, sessionCookie } from '@/lib/api'
import { db } from '@/lib/db'
import { verifyPassword } from '@/lib/crypto'
import { audit } from '@/lib/audit'

const schema = z.object({
  email: z.string().min(1, 'Email is required'),
  password: z.string().min(1, 'Password is required'),
})

/**
 * POST /api/auth/login {email, password}
 * Sets the HttpOnly session cookie on success. Generic error message so we
 * never disclose whether an email exists. Per-email brute-force throttle.
 */
export const POST = withPublic(async (req) => {
  const body = await parseBody(req, schema)
  const email = body.email.trim().toLowerCase()

  if (!rateLimit(`login:${email}`, 10, 60_000)) {
    return fail(429, 'Too many sign-in attempts. Try again in a minute.')
  }

  // Email case is normalized in JS (SQLite has no case-insensitive unique lookup).
  const users = await db.user.findMany({
    select: { id: true, orgId: true, email: true, passwordHash: true, name: true, role: true },
  })
  const user = users.find((u) => u.email.toLowerCase() === email)

  if (!user || !verifyPassword(body.password, user.passwordHash)) {
    return fail(401, 'Invalid email or password', { code: 'invalid_credentials' })
  }

  const { token, expiresAt } = await createSession(user.id)

  await audit({
    orgId: user.orgId,
    actorType: 'user',
    actorId: user.id,
    action: 'auth.login',
    entity: 'user',
    entityId: user.id,
    meta: { email: user.email },
  })

  const res = json({
    ok: true,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  })
  res.headers.append('set-cookie', sessionCookie(token, expiresAt))
  return res
})
