import { z } from 'zod'
import { withAuth, json, parseBody, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'

const patchSchema = z
  .object({
    name: z.string().trim().min(1, 'Name cannot be empty').max(120),
    role: z.string().trim().max(80),
    email: z.string().trim().max(120),
    phone: z.string().trim().max(40),
    active: z.boolean(),
  })
  .partial()
  .refine((data) => Object.keys(data).length > 0, { message: 'No fields to update' })

/** PATCH /api/staff/[id] — any subset of profile fields (incl. active). */
export const PATCH = withAuth(async (req, ctx, params) => {
  const staff = await db.staff.findFirst({ where: { id: params.id, orgId: ctx.org.id } })
  if (!staff) throw new ApiError(404, 'Staff member not found', 'not_found')

  const body = await parseBody(req, patchSchema)
  const updated = await db.staff.update({ where: { id: staff.id }, data: body })

  await audit({
    orgId: ctx.org.id,
    actorType: 'user',
    actorId: ctx.user.id,
    action: 'staff.updated',
    entity: 'staff',
    entityId: staff.id,
    meta: { fields: Object.keys(body), name: updated.name },
  })

  return json(updated)
})
