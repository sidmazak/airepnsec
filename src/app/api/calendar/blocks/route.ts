import { z } from 'zod'
import { withAuth, json, parseBody, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { parseOrgDateTime } from '@/lib/timezone'

const listSchema = z.object({
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
})

const createSchema = z.object({
  start_at: z.string().min(4, 'start_at is required').max(40),
  end_at: z.string().min(4, 'end_at is required').max(40),
  title: z.string().max(120).optional(),
  staff_id: z.string().max(60).optional(),
  staff: z.string().max(120).optional(),
})

/**
 * GET /api/calendar/blocks?from=&to= — blocked periods (external calendar busy
 * windows + manual blocks). Overlapping blocks are never bookable.
 */
export const GET = withAuth(async (req, ctx) => {
  const url = new URL(req.url)
  const parsed = listSchema.safeParse({ from: url.searchParams.get('from') ?? undefined, to: url.searchParams.get('to') ?? undefined })
  if (!parsed.success) throw new ApiError(422, 'Invalid from/to', 'validation')
  const now = new Date()
  const from = parsed.data.from ? parseOrgDateTime(parsed.data.from, ctx.org.timezone) : now
  const to = parsed.data.to ? parseOrgDateTime(parsed.data.to, ctx.org.timezone) : new Date(now.getTime() + 30 * 24 * 3600 * 1000)
  if (!from || !to) throw new ApiError(422, 'from/to must be valid dates', 'validation')

  const blocks = await db.calendarBlock.findMany({
    where: { orgId: ctx.org.id, startAt: { lt: to }, endAt: { gt: from } },
    include: { staff: { select: { id: true, name: true } } },
    orderBy: { startAt: 'asc' },
    take: 500,
  })

  return json({
    blocks: blocks.map((b) => ({
      id: b.id,
      title: b.title,
      source: b.source,
      staffId: b.staffId,
      staffName: b.staff?.name ?? null,
      startAt: b.startAt.toISOString(),
      endAt: b.endAt.toISOString(),
      allDay: b.allDay,
    })),
    count: blocks.length,
  })
})

/**
 * POST /api/calendar/blocks (owner/admin/agent) — block a period.
 * The slot disappears from availability immediately; the booking service refuses
 * any booking that overlaps it.
 */
export const POST = withAuth(
  async (req, ctx) => {
    const body = await parseBody(req, createSchema)
    const start = parseOrgDateTime(body.start_at, ctx.org.timezone)
    const end = parseOrgDateTime(body.end_at, ctx.org.timezone)
    if (!start || !end) throw new ApiError(422, 'start_at and end_at must be valid date-times', 'validation')
    if (end.getTime() <= start.getTime()) throw new ApiError(422, 'end_at must be later than start_at', 'validation')

    let staffId: string | null = null
    const staffRef = body.staff_id || body.staff
    if (staffRef) {
      const staff = await db.staff.findFirst({ where: { orgId: ctx.org.id, name: staffRef } })
        ?? await db.staff.findFirst({ where: { orgId: ctx.org.id, id: staffRef } })
      if (!staff) throw new ApiError(404, `No staff member matching "${staffRef}"`, 'not_found')
      staffId = staff.id
    }

    const block = await db.calendarBlock.create({
      data: {
        orgId: ctx.org.id,
        staffId,
        source: 'manual',
        title: body.title?.trim() || 'Blocked',
        startAt: start,
        endAt: end,
      },
    })

    await audit({
      orgId: ctx.org.id, actorType: 'user', actorId: ctx.user.id,
      action: 'calendar.block_created', entity: 'calendar_block', entityId: block.id,
      meta: { startAt: start.toISOString(), endAt: end.toISOString(), staffId, source: 'manual' },
    })

    return json({
      block: {
        id: block.id,
        title: block.title,
        source: block.source,
        staffId: block.staffId,
        startAt: block.startAt.toISOString(),
        endAt: block.endAt.toISOString(),
        allDay: block.allDay,
      },
    }, 201)
  },
  { roles: ['owner', 'admin', 'agent'] }
)
