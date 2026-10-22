import { withAuth, json } from '@/lib/api'
import { listMembers } from '@/lib/users'

/**
 * GET /api/users — list team members (owner/admin).
 * Never exposes the password hash or the TOTP secret.
 */
export const GET = withAuth(
  async (_req, ctx) => {
    const members = await listMembers(ctx.org.id)
    return json({ members })
  },
  { roles: ['owner', 'admin'] }
)
