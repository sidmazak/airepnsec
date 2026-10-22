import { withPublic, json, fail } from '@/lib/api'
import { resolveInviteToken } from '@/lib/users'

/**
 * GET /api/users/invites/[token] — PUBLIC.
 * Lets the join screen show which email and role the invitation is for.
 * Only non-sensitive fields are returned; an invalid token is a 404.
 */
export const GET = withPublic(async (_req, params) => {
  const token = params.token ?? ''
  if (!token) return fail(400, 'An invitation token is required', { code: 'bad_request' })
  const invite = await resolveInviteToken(token)
  if (!invite) return fail(404, 'This invitation is invalid, expired, or already used', { code: 'invite_invalid' })
  return json({ invite: { email: invite.email, role: invite.role, expiresAt: invite.expiresAt } })
})
