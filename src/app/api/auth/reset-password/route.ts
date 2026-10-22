import { z } from 'zod'
import { withPublic, json, fail, parseBody, ApiError } from '@/lib/api'
import { resetPasswordWithToken } from '@/lib/users'

const schema = z.object({
  token: z.string().min(1, 'A reset token is required'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
})

/**
 * POST /api/auth/reset-password — PUBLIC (no session).
 * Sets a new password after a valid, one-time reset link. There is no
 * self-service recovery for a member who lost their password: an owner has to
 * issue a reset link (see /api/users/[id]/reset-password).
 */
export const POST = withPublic(async (req) => {
  try {
    const body = await parseBody(req, schema)
    const result = await resetPasswordWithToken(body.token, body.password)
    return json({ ok: true, email: result.email })
  } catch (err) {
    if (err instanceof ApiError) return fail(err.status, err.message, { code: err.code })
    return fail(400, err instanceof Error ? err.message : 'Reset failed', { code: 'bad_request' })
  }
})
