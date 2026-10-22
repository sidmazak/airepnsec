import { z } from 'zod'
import { withPublic, json, fail, parseBody, ApiError, sessionCookie } from '@/lib/api'
import { acceptInvite } from '@/lib/users'

const schema = z.object({
  name: z.string().trim().max(80).optional(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
})

/**
 * POST /api/users/invites/[token]/accept — PUBLIC.
 * The invitee sets their own password to create the account. The invitation is
 * consumed exactly once and the response sets the session cookie.
 */
export const POST = withPublic(async (req, params) => {
  const token = params.token ?? ''
  if (!token) return fail(400, 'An invitation token is required', { code: 'bad_request' })
  try {
    const body = await parseBody(req, schema)
    const result = await acceptInvite(token, body)
    const res = json({ ok: true, user: result.user, expiresAt: result.sessionExpiresAt.toISOString() }, 200)
    res.headers.append('set-cookie', sessionCookie(result.sessionToken, result.sessionExpiresAt))
    return res
  } catch (err) {
    if (err instanceof ApiError) return fail(err.status, err.message, { code: err.code })
    return fail(400, err instanceof Error ? err.message : 'Could not process the invitation', { code: 'bad_request' })
  }
})
