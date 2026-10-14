import { withAuth, json, SESSION_COOKIE, clearSessionCookie } from '@/lib/api'
import { db } from '@/lib/db'
import { sha256 } from '@/lib/crypto'
import { audit } from '@/lib/audit'

/**
 * POST /api/auth/logout (auth)
 * Deletes the session row (hash of the cookie token is the lookup key)
 * and clears the cookie in the browser.
 */
export const POST = withAuth(async (req, ctx) => {
  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (token) {
    await db.session.deleteMany({ where: { tokenHash: sha256(token) } })
  }

  await audit({
    orgId: ctx.org.id,
    actorType: 'user',
    actorId: ctx.user.id,
    action: 'auth.logout',
    entity: 'user',
    entityId: ctx.user.id,
  })

  const res = json({ ok: true })
  res.headers.append('set-cookie', clearSessionCookie())
  return res
})
