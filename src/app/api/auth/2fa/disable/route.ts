import { z } from 'zod'
import { withAuth, json, fail, parseBody, rateLimit } from '@/lib/api'
import { db } from '@/lib/db'
import { decryptSecret, secretIsEncrypted, verifyPassword } from '@/lib/crypto'
import { verifyTotp } from '@/lib/security/totp'
import { audit } from '@/lib/audit'

const schema = z.object({
  password: z.string().min(1, 'Password is required'),
  code: z.string().max(10).optional(),
})

/**
 * POST /api/auth/2fa/disable {password, code?}
 * Disabling requires the account password AND (while enabled) a current
 * authenticator code — a stolen session alone can never remove 2FA.
 */
export const POST = withAuth(async (req, ctx) => {
  if (!rateLimit(`2fa-disable:${ctx.user.id}`, 10, 60_000)) return fail(429, 'Too many attempts. Try again in a minute.')

  const body = await parseBody(req, schema)
  const user = await db.user.findUnique({ where: { id: ctx.user.id } })
  if (!user || !verifyPassword(body.password, user.passwordHash)) {
    return fail(401, 'Password is incorrect', { code: 'invalid_password' })
  }

  if (user.twoFactorEnabled) {
    let secret = ''
    try {
      secret = user.twoFactorSecret
        ? secretIsEncrypted(user.twoFactorSecret)
          ? decryptSecret(user.twoFactorSecret)
          : /^[A-Z2-7]+$/.test(user.twoFactorSecret)
            ? user.twoFactorSecret
            : ''
        : ''
    } catch {
      secret = ''
    }
    if (!secret || !verifyTotp(secret, body.code ?? '')) {
      return fail(422, 'A current 6-digit authenticator code is required to disable two-factor authentication', { code: 'invalid_code' })
    }
  }

  await db.user.update({ where: { id: user.id }, data: { twoFactorEnabled: false, twoFactorSecret: '' } })
  await audit({
    orgId: user.orgId, actorType: 'user', actorId: user.id,
    action: 'auth.2fa_disabled', entity: 'user', entityId: user.id,
  })
  return json({ enabled: false })
})
