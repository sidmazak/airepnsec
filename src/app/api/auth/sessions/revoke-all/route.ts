import { withAuth, json } from '@/lib/api'
import { db } from '@/lib/db'
import { sha256 } from '@/lib/crypto'
import { audit } from '@/lib/audit'

/**
 * POST /api/auth/sessions/revoke-all (any authenticated user)
 * Revokes every active session for the signed-in user except the current one.
 * Persistent (revokedAt) — survives restarts. Useful after a suspected leak.
 */
export const POST = withAuth(async (req, ctx) => {
  const current = req.cookies.get('session')?.value
  const currentHash = current ? sha256(current) : null
  const result = await db.session.updateMany({
    where: {
      userId: ctx.user.id,
      revokedAt: null,
      ...(currentHash ? { tokenHash: { not: currentHash } } : {}),
    },
    data: { revokedAt: new Date(), expiresAt: new Date() },
  })
  await audit({
    orgId: ctx.org.id, actorType: 'user', actorId: ctx.user.id,
    action: 'auth.sessions_revoked', entity: 'user', entityId: ctx.user.id,
    meta: { count: result.count, keptCurrent: Boolean(currentHash) },
  })
  return json({ revoked: result.count })
})
