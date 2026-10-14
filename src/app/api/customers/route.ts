import { z } from 'zod'
import { withAuth, json, parseBody } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { parseJson } from '@/lib/org'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const emailField = z.union([z.literal(''), z.string().regex(EMAIL_RE, 'Invalid email address')])

const createSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  email: emailField.optional(),
  phone: z.string().trim().max(40).optional(),
  notes: z.string().max(4000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(24).optional(),
})

/**
 * GET /api/customers?query=
 * Search across name/email/phone. SQLite has no case-insensitive matching in
 * Prisma, so we fetch the most recently touched 200 rows for the org and
 * filter in JS — bounded and fast for a self-hosted instance.
 */
export const GET = withAuth(async (req, ctx) => {
  const url = new URL(req.url)
  const query = (url.searchParams.get('query') ?? '').trim().toLowerCase()

  const rows = await db.customer.findMany({
    where: { orgId: ctx.org.id },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  })

  const filtered = query
    ? rows.filter(
        (c) =>
          c.name.toLowerCase().includes(query) ||
          c.email.toLowerCase().includes(query) ||
          c.phone.toLowerCase().includes(query)
      )
    : rows

  const customers = filtered.slice(0, 100).map((c) => ({
    id: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone,
    notes: c.notes,
    tags: parseJson<string[]>(c.tags, []),
    optOut: c.optOut,
    consentContact: c.consentContact,
    createdAt: c.createdAt,
  }))

  return json({ customers })
})

/** POST /api/customers {name, email?, phone?, notes?, tags?} */
export const POST = withAuth(async (req, ctx) => {
  const body = await parseBody(req, createSchema)

  const customer = await db.customer.create({
    data: {
      orgId: ctx.org.id,
      name: body.name,
      email: (body.email ?? '').trim().toLowerCase(),
      phone: body.phone ?? '',
      notes: body.notes ?? '',
      tags: JSON.stringify(body.tags ?? []),
    },
  })

  await audit({
    orgId: ctx.org.id,
    actorType: 'user',
    actorId: ctx.user.id,
    action: 'customer.created',
    entity: 'customer',
    entityId: customer.id,
    meta: { name: customer.name, email: customer.email },
  })

  return json({ ...customer, tags: parseJson<string[]>(customer.tags, []) }, 201)
})
