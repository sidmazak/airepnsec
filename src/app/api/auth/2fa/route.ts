import { withAuth, json } from '@/lib/api'
import { db } from '@/lib/db'

/** GET /api/auth/2fa — current user's two-factor state (never the secret). */
export const GET = withAuth(async (_req, ctx) => {
  const user = await db.user.findUnique({ where: { id: ctx.user.id }, select: { twoFactorEnabled: true, twoFactorSecret: true } })
  return json({ enabled: Boolean(user?.twoFactorEnabled), enrollmentPending: Boolean(user?.twoFactorSecret) && !user?.twoFactorEnabled })
})
