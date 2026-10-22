import { z } from 'zod'
import { withAuth, json, fail, parseBody, ApiError } from '@/lib/api'
import { updateMember } from '@/lib/users'

const patchSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(80).optional(),
    role: z.enum(['admin', 'agent', 'viewer']).optional(),
    active: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'No fields to update' })

/**
 * PATCH /api/users/[id] — update a member's name, role or active status.
 * Owner/admin only. The role may only be set to admin/agent/viewer (owner is
 * assigned at bootstrap); the last active owner can never be demoted or
 * deactivated, and only an owner may manage another owner.
 */
export const PATCH = withAuth(
  async (req, ctx, params) => {
    try {
      const body = await parseBody(req, patchSchema)
      const member = await updateMember(ctx.org.id, ctx.user.id, ctx.user.role, params.id, body)
      return json({ ok: true, member })
    } catch (err) {
      if (err instanceof ApiError) return fail(err.status, err.message, { code: err.code })
      return fail(400, err instanceof Error ? err.message : 'Could not update the member', { code: 'bad_request' })
    }
  },
  { roles: ['owner', 'admin'] }
)
