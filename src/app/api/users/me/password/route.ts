import { z } from 'zod'
import { withAuth, json, fail, parseBody, ApiError, SESSION_COOKIE, clearSessionCookie } from '@/lib/api'
import { changeOwnPassword } from '@/lib/users'

const schema = z.object({
  currentPassword: z.string().min(1, 'Your current password is required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters').max(200),
})

/**
 * PATCH /api/users/me/password — change your own password.
 * The current password is required. Every session of the account (including the
 * current one) is revoked afterwards, so sign in again with the new password.
 */
export const PATCH = withAuth(async (req, ctx) => {
  try {
    const body = await parseBody(req, schema)
    const revoked = await changeOwnPassword(ctx.user.id, ctx.org.id, body)
    const res = json({ ok: true, sessionsRevoked: true, revoked })
    res.headers.append('set-cookie', clearSessionCookie())
    return res
  } catch (err) {
    if (err instanceof ApiError) return fail(err.status, err.message, { code: err.code })
    return fail(400, err instanceof Error ? err.message : 'Could not update your password', { code: 'bad_request' })
  }
})
