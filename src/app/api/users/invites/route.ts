import { z } from 'zod'
import { withAuth, json, parseBody } from '@/lib/api'
import { createInvite, listInvites } from '@/lib/users'

const inviteSchema = z.object({
  email: z.string().min(3, 'Email is required').max(200),
  name: z.string().trim().max(80).optional(),
  role: z.enum(['admin', 'agent', 'viewer']).default('agent'),
})

/**
 * GET /api/users/invites — pending invitations (owner/admin).
 */
export const GET = withAuth(
  async (_req, ctx) => {
    const invites = await listInvites(ctx.org.id)
    return json({ invites })
  },
  { roles: ['owner', 'admin'] }
)

/**
 * POST /api/users/invites — create an invitation (owner/admin).
 * The invitation email is queued in the outbox. The single-use join link is
 * returned once so the inviter can hand it over when email is not configured.
 */
export const POST = withAuth(
  async (req, ctx) => {
    const body = await parseBody(req, inviteSchema)
    const { invite, inviteUrl } = await createInvite(ctx.org.id, ctx.user.id, body)
    return json(
      {
        ok: true,
        inviteId: invite.id,
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expiresAt,
        inviteUrl,
      },
      201
    )
  },
  { roles: ['owner', 'admin'] }
)
