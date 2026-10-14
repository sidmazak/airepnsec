import { z } from 'zod'
import { withAuth, json, parseBody } from '@/lib/api'
import { db } from '@/lib/db'
import { createInvoice, invoiceOutstanding } from '@/lib/business/invoice'

/**
 * GET /api/invoices?status&customerId
 * Latest first, with customer name and computed outstandingCents.
 */
export const GET = withAuth(async (req, ctx) => {
  const url = new URL(req.url)
  const status = url.searchParams.get('status') || undefined
  const customerId = url.searchParams.get('customerId') || undefined

  const invoices = await db.invoice.findMany({
    where: {
      orgId: ctx.org.id,
      ...(status ? { status } : {}),
      ...(customerId ? { customerId } : {}),
    },
    orderBy: { issueDate: 'desc' },
    take: 200,
    include: { customer: { select: { id: true, name: true } } },
  })

  return json({
    invoices: invoices.map((inv) => ({
      ...inv,
      outstandingCents: invoiceOutstanding(inv.totalCents, inv.paidCents),
    })),
  })
})

const rentalPeriodSchema = z.object({
  start: z.string().min(1, 'rental period start is required'),
  end: z.string().min(1, 'rental period end is required'),
  recurrence: z.string().max(40).optional(),
})

const itemSchema = z.object({
  description: z.string().trim().min(1, 'Line item description is required').max(300),
  qty: z.number().int('qty must be a whole number').min(1, 'qty must be at least 1'),
  unitPriceCents: z.number().int('unitPriceCents must be an integer (cents)').min(0),
})

const createSchema = z.object({
  customerId: z.string().min(1, 'customerId is required'),
  items: z.array(itemSchema).min(1, 'An invoice needs at least one line item').max(100),
  taxCents: z.number().int().min(0).optional(),
  dueInDays: z.number().int().min(0).max(365).optional(),
  rentalPeriod: rentalPeriodSchema.nullable().optional(),
  notes: z.string().max(4000).optional(),
})

/** POST /api/invoices (owner/admin) — issues an invoice via createInvoice (audited there). */
export const POST = withAuth(
  async (req, ctx) => {
    const body = await parseBody(req, createSchema)

    const invoice = await createInvoice(
      ctx.org.id,
      {
        customerId: body.customerId,
        items: body.items,
        taxCents: body.taxCents,
        dueInDays: body.dueInDays,
        rentalPeriod: body.rentalPeriod ?? null,
        notes: body.notes,
      },
      { type: 'user', id: ctx.user.id }
    )

    const full = await db.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
      include: {
        items: true,
        customer: { select: { id: true, name: true } },
      },
    })

    return json({ ...full, outstandingCents: invoiceOutstanding(full.totalCents, full.paidCents) }, 201)
  },
  { roles: ['owner', 'admin'] }
)
