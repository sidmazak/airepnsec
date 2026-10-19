import { z } from 'zod'
import { withAuth, json, parseBody } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'

const createSchema = z.object({
  name: z.string().trim().min(1, 'Staff name is required').max(120),
  role: z.string().trim().max(80).optional(),
  email: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(40).optional(),
})

/** GET /api/staff — members with their service links and working hours. */
export const GET = withAuth(async (req, ctx) => {
  const staff = await db.staff.findMany({
    where: { orgId: ctx.org.id },
    orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
    include: {
      serviceLinks: { select: { serviceId: true } },
      workingHours: { orderBy: [{ dow: 'asc' }, { startMin: 'asc' }] },
    },
  })

  return json({
    staff: staff.map((s) => ({
      ...s,
      serviceIds: s.serviceLinks.map((l) => l.serviceId),
    })),
  })
})

/** POST /api/staff {name, role?, email?, phone?} */
export const POST = withAuth(async (req, ctx) => {
  const body = await parseBody(req, createSchema)

  const staff = await db.staff.create({
    data: {
      orgId: ctx.org.id,
      name: body.name,
      role: body.role ?? '',
      email: body.email ?? '',
      phone: body.phone ?? '',
    },
  })

  await audit({
    orgId: ctx.org.id,
    actorType: 'user',
    actorId: ctx.user.id,
    action: 'staff.created',
    entity: 'staff',
    entityId: staff.id,
    meta: { name: staff.name },
  })

  return json(staff, 201)
}, { roles: ['owner', 'admin'] })
