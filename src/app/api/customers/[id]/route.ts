import { z } from 'zod'
import { withAuth, json, parseBody, ApiError, requireCustomer } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { parseJson } from '@/lib/org'
import { invoiceOutstanding } from '@/lib/business/invoice'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const patchSchema = z
  .object({
    name: z.string().trim().min(1, 'Name cannot be empty').max(120),
    email: z.union([z.literal(''), z.string().regex(EMAIL_RE, 'Invalid email address')]),
    phone: z.string().trim().max(40),
    notes: z.string().max(4000),
    tags: z.array(z.string().trim().min(1).max(40)).max(24),
    optOut: z.boolean(),
    consentContact: z.boolean(),
    externalRef: z.string().max(120),
  })
  .partial()
  .refine((data) => Object.keys(data).length > 0, { message: 'No fields to update' })

/** GET /api/customers/[id] — profile + recent bookings + invoices summary. */
export const GET = withAuth(async (req, ctx, params) => {
  const customer = await requireCustomer(ctx.org.id, params.id)

  const [bookings, invoices] = await Promise.all([
    db.booking.findMany({
      where: { orgId: ctx.org.id, customerId: customer.id },
      orderBy: { startAt: 'desc' },
      take: 20,
      include: {
        service: { select: { id: true, name: true } },
        staff: { select: { id: true, name: true } },
      },
    }),
    db.invoice.findMany({
      where: { orgId: ctx.org.id, customerId: customer.id },
      orderBy: { issueDate: 'desc' },
      take: 20,
      select: {
        id: true,
        number: true,
        status: true,
        currency: true,
        totalCents: true,
        paidCents: true,
        issueDate: true,
        dueDate: true,
      },
    }),
  ])

  const outstandingCents = invoices.reduce(
    (sum, inv) => sum + invoiceOutstanding(inv.totalCents, inv.paidCents),
    0
  )

  return json({
    customer: { ...customer, tags: parseJson<string[]>(customer.tags, []) },
    bookings,
    invoices: invoices.map((inv) => ({ ...inv, outstandingCents: invoiceOutstanding(inv.totalCents, inv.paidCents) })),
    summary: {
      bookingCount: await db.booking.count({ where: { orgId: ctx.org.id, customerId: customer.id } }),
      invoiceCount: await db.invoice.count({ where: { orgId: ctx.org.id, customerId: customer.id } }),
      outstandingCents,
    },
  })
})

/** PATCH /api/customers/[id] — any subset of fields (owner/admin/agent). */
export const PATCH = withAuth(async (req, ctx, params) => {
  const customer = await requireCustomer(ctx.org.id, params.id)
  const body = await parseBody(req, patchSchema)

  const data: Record<string, unknown> = {}
  if (body.name !== undefined) data.name = body.name
  if (body.email !== undefined) data.email = body.email.trim().toLowerCase()
  if (body.phone !== undefined) data.phone = body.phone
  if (body.notes !== undefined) data.notes = body.notes
  if (body.tags !== undefined) data.tags = JSON.stringify(body.tags)
  if (body.optOut !== undefined) data.optOut = body.optOut
  if (body.consentContact !== undefined) data.consentContact = body.consentContact
  if (body.externalRef !== undefined) data.externalRef = body.externalRef

  const updated = await db.customer.update({ where: { id: customer.id }, data })

  await audit({
    orgId: ctx.org.id,
    actorType: 'user',
    actorId: ctx.user.id,
    action: 'customer.updated',
    entity: 'customer',
    entityId: customer.id,
    meta: { fields: Object.keys(data) },
  })

  return json({ ...updated, tags: parseJson<string[]>(updated.tags, []) })
}, { roles: ['owner', 'admin', 'agent'] })

/**
 * DELETE /api/customers/[id] (owner/admin)
 * Financial history is never destroyed: any invoice blocks deletion.
 * Active (pending/confirmed) bookings must be cancelled first; once clear,
 * the customer's remaining booking rows are removed, then the customer.
 */
export const DELETE = withAuth(async (req, ctx, params) => {
  const customer = await requireCustomer(ctx.org.id, params.id)

  const invoices = await db.invoice.findMany({
    where: { orgId: ctx.org.id, customerId: customer.id },
    select: { id: true, number: true, status: true, totalCents: true, paidCents: true },
  })

  if (invoices.length > 0) {
    const hasOutstanding = invoices.some((inv) => invoiceOutstanding(inv.totalCents, inv.paidCents) > 0)
    throw new ApiError(
      409,
      hasOutstanding
        ? 'Customer has outstanding invoices and cannot be deleted'
        : 'Customer has invoice records — financial history must be preserved',
      'has_invoices'
    )
  }

  const bookings = await db.booking.findMany({
    where: { orgId: ctx.org.id, customerId: customer.id },
    select: { id: true, status: true },
  })

  const activeStatuses = ['pending', 'confirmed']
  const activeCount = bookings.filter((b) => activeStatuses.includes(b.status)).length
  if (activeCount > 0) {
    throw new ApiError(
      409,
      `Customer has ${activeCount} active booking${activeCount === 1 ? '' : 's'} — cancel them first`,
      'has_active_bookings'
    )
  }

  // Booking rows have no cascade to Customer in this schema — remove them first.
  await db.booking.deleteMany({ where: { orgId: ctx.org.id, customerId: customer.id } })
  await db.customer.delete({ where: { id: customer.id } })

  await audit({
    orgId: ctx.org.id,
    actorType: 'user',
    actorId: ctx.user.id,
    action: 'customer.deleted',
    entity: 'customer',
    entityId: customer.id,
    meta: { name: customer.name, bookingsDeleted: bookings.length },
  })

  return json({ ok: true })
}, { roles: ['owner', 'admin'] })
