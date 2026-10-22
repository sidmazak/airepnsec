import { withAuth, json, fail, ApiError } from '@/lib/api'
import { issueResetLink } from '@/lib/users'

/**
 * POST /api/users/[id]/reset-password — owner only.
 * Issues a one-time reset token and queues the reset email in the outbox.
 * The single-use link is returned ONCE so an operator can hand it over when
 * email delivery is not configured.
 */
export const POST = withAuth(
  async (_req, ctx, params) => {
    try {
      const { link } = await issueResetLink(ctx.org.id, params.id, ctx.user.id, ctx.user.role)
      return json({ ok: true, link })
    } catch (err) {
      if (err instanceof ApiError) return fail(err.status, err.message, { code: err.code })
      return fail(400, err instanceof Error ? err.message : 'Could not issue a reset link', { code: 'bad_request' })
    }
  },
  { roles: ['owner'] }
)
