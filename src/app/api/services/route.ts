import { z } from 'zod'
import { withAuth, json, parseBody } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'

const createSchema = z.object({
  name: z.string().trim().min(1, 'Service name is required').max(120),
  description: z.string().max(2000).optional(),
  category: z.string().trim().max(60).optional(),
  durationMin: z.number().int().min(5, 'Duration must be at least 5 minutes').max(24 * 60),
  priceCents: z.number().int().min(0, 'Price must be a non-negative integer (cents)'),
  bufferBeforeMin: z.number().int().min(0).max(240).optional(),
  bufferAfterMin: z.number().int().min(0).max(240).optional(),
  maxPerSlot: z.number().int().min(1).max(50).optional(),
  requiresDeposit: z.boolean().optional(),
  depositCents: z.number().int().min(0).optional(),
})

/** GET /api/services — full catalog for the org (active first, then newest). */
export const GET = withAuth(async (req, ctx) => {
  const services = await db.service.findMany({
    where: { orgId: ctx.org.id },
    orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
  })
  return json({ services })
})

/** POST /api/services — create a bookable service. */
export const POST = withAuth(async (req, ctx) => {
  const body = await parseBody(req, createSchema)

  const service = await db.service.create({
    data: {
      orgId: ctx.org.id,
      name: body.name,
      description: body.description ?? '',
      category: body.category ?? 'general',
      durationMin: body.durationMin,
      priceCents: body.priceCents,
      currency: ctx.org.currency,
      bufferBeforeMin: body.bufferBeforeMin ?? 0,
      bufferAfterMin: body.bufferAfterMin ?? 0,
      maxPerSlot: body.maxPerSlot ?? 1,
      requiresDeposit: body.requiresDeposit ?? false,
      depositCents: body.depositCents ?? 0,
    },
  })

  await audit({
    orgId: ctx.org.id,
    actorType: 'user',
    actorId: ctx.user.id,
    action: 'service.created',
    entity: 'service',
    entityId: service.id,
    meta: { name: service.name, durationMin: service.durationMin, priceCents: service.priceCents },
  })

  return json(service, 201)
}, { roles: ['owner', 'admin'] })
