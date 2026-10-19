import { z } from 'zod'
import { withAuth, json, fail, parseBody, rateLimit } from '@/lib/api'
import { db } from '@/lib/db'
import { decryptSecret, secretIsEncrypted } from '@/lib/crypto'
import { verifyTotp } from '@/lib/security/totp'
import { audit } from '@/lib/audit'

const schema = z.object({
  code: z.string().min(6, 'Enter the 6-digit code').max(10),
})

/**
 * POST /api/auth/2fa/enable {code}
 * Confirms the enrollment secret with a live authenticator code and turns 2FA on.
 * A wrong code changes nothing — the pending secret stays until confirmed or replaced.
 */
export const POST = withAuth(async (req, ctx) => {
  if (!rateLimit(`2fa-enable:${ctx.user.id}`, 10, 60_000)) return fail(429, 'Too many attempts. Try again in a minute.')

  const body = await parseBody(req, schema)
  const user = await db.user.findUnique({ where: { id: ctx.user.id } })
  if (!user || !user.twoFactorSecret) {
    return fail(409, 'Start two-factor setup first', { code: 'no_pending_setup' })
  }
  if (user.twoFactorEnabled) return json({ enabled: true })

  const secret = decryptSecretValue(user.twoFactorSecret)
  if (!secret) return fail(500, 'Stored two-factor secret cannot be read — run setup again', { code: 'secret_unreadable' })
  if (!verifyTotp(secret, body.code)) {
    return fail(422, 'That code is not valid right now — check your authenticator clock and try the current code', { code: 'invalid_code' })
  }

  await db.user.update({ where: { id: user.id }, data: { twoFactorEnabled: true } })
  await audit({
    orgId: user.orgId, actorType: 'user', actorId: user.id,
    action: 'auth.2fa_enabled', entity: 'user', entityId: user.id,
  })
  return json({ enabled: true })
})

/** Tolerate a raw (unencrypted) secret only if someone imported one manually — never silently. */
function decryptSecretValue(stored: string): string | null {
  if (secretIsEncrypted(stored)) {
    try {
      return decryptSecret(stored)
    } catch {
      return null
    }
  }
  return /^[A-Z2-7]+$/.test(stored) ? stored : null
}
