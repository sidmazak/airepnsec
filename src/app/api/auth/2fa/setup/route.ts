import { z } from 'zod'
import { withAuth, json, fail, parseBody, rateLimit } from '@/lib/api'
import { db } from '@/lib/db'
import { encryptSecret, verifyPassword } from '@/lib/crypto'
import { generateTotpSecret, otpauthUrl } from '@/lib/security/totp'
import { audit } from '@/lib/audit'

const schema = z.object({
  password: z.string().min(1, 'Password is required'),
})

/**
 * POST /api/auth/2fa/setup {password}
 * Starts TOTP enrollment: verifies the current password, then stores a fresh
 * encrypted secret WITHOUT enabling 2FA. The plaintext secret is returned exactly
 * once so the user can add it to an authenticator app; it must be confirmed via
 * /api/auth/2fa/enable before it takes effect.
 */
export const POST = withAuth(async (req, ctx) => {
  if (!rateLimit(`2fa-setup:${ctx.user.id}`, 5, 60_000)) return fail(429, 'Too many attempts. Try again in a minute.')

  const body = await parseBody(req, schema)
  const user = await db.user.findUnique({ where: { id: ctx.user.id } })
  if (!user || !verifyPassword(body.password, user.passwordHash)) {
    return fail(401, 'Password is incorrect', { code: 'invalid_password' })
  }
  if (user.twoFactorEnabled) {
    return fail(409, 'Two-factor authentication is already enabled — disable it first to re-enroll', { code: 'already_enabled' })
  }

  const secret = generateTotpSecret()
  await db.user.update({ where: { id: user.id }, data: { twoFactorSecret: encryptSecret(secret) } })

  await audit({
    orgId: user.orgId, actorType: 'user', actorId: user.id,
    action: 'auth.2fa_setup_started', entity: 'user', entityId: user.id,
  })

  return json({
    secret,
    otpauthUrl: otpauthUrl({ secret, account: user.email, issuer: `${ctx.org.name} (AI Secretary)` }),
    hint: 'Add this secret to your authenticator app, then confirm with a current 6-digit code.',
  })
})
