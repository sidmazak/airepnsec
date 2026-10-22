import { withAuth, json, fail, ApiError } from '@/lib/api'
import { revokeMemberSessions } from '@/lib/users'

/**
 * POST /api/users/[id]/revoke-sessions — revoke every live session of a member.
 * Members may do this for themselves; admins/owners may do it for anybody.
 */
export const POST = withAuth(async (_req, ctx, params) => {
  try {
    const target = params.id
    if (target !== ctx.user.id && !['owner', 'admin'].includes(ctx.user.role)) {
      return fail(403, 'You can only sign out your own sessions', { code: 'forbidden' })
    }
    const count = await revokeMemberSessions(ctx.org.id, target, ctx.user.id)
    return json({ ok: true, revoked: count })
  } catch (err) {
    if (err instanceof ApiError) return fail(err.status, err.message, { code: err.code })
    return fail(400, err instanceof Error ? err.message : 'Could not revoke sessions', { code: 'bad_request' })
  }
})
