import { z } from 'zod'
import { withAuth, json, fail, parseBody, ApiError } from '@/lib/api'
import { revokeInvite } from '@/lib/users'

const schema = z.object({ id: z.string().min(1, 'An invite id is required') })

/** POST /api/users/invites/revoke — revoke a pending invitation (owner/admin). */
export const POST = withAuth(
  async (req, ctx) => {
    try {
      const body = await parseBody(req, schema)
      await revokeInvite(ctx.org.id, body.id, ctx.user.id)
      return json({ ok: true, revoked: true })
    } catch (err) {
      if (err instanceof ApiError) return fail(err.status, err.message, { code: err.code })
      return fail(400, err instanceof Error ? err.message : 'Could not revoke the invite', { code: 'bad_request' })
    }
  },
  { roles: ['owner', 'admin'] }
)
