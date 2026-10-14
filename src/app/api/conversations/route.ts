import { z } from 'zod'
import { withAuth, json, parseBody, requireCustomer } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'

const createSchema = z.object({
  contactName: z.string().trim().max(200).optional(),
  customerId: z.string().min(1).optional(),
  channel: z.enum(['web', 'voice_test', 'phone', 'sms']).optional(),
})

const STATUSES = ['open', 'waiting_human', 'closed']

/** GET /api/conversations?status= — inbox list with last-message preview + customer name */
export const GET = withAuth(async (req, ctx) => {
  const url = new URL(req.url)
  const status = url.searchParams.get('status') ?? ''

  const conversations = await db.conversation.findMany({
    where: { orgId: ctx.org.id, ...(status && STATUSES.includes(status) ? { status } : {}) },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    include: { customer: { select: { name: true } } },
  })

  const withPreview = await Promise.all(
    conversations.map(async (c) => {
      const last = await db.message.findFirst({
        where: { conversationId: c.id },
        orderBy: { createdAt: 'desc' },
      })
      return {
        id: c.id,
        channel: c.channel,
        status: c.status,
        aiEnabled: c.aiEnabled,
        contactName: c.contactName,
        customerId: c.customerId,
        customerName: c.customer?.name ?? '',
        summary: c.summary,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        lastMessage: last
          ? { role: last.role, content: last.content.slice(0, 240), createdAt: last.createdAt }
          : null,
      }
    })
  )

  return json({ conversations: withPreview })
})

/** POST /api/conversations {contactName?, customerId?, channel?} — open a conversation */
export const POST = withAuth(async (req, ctx) => {
  const body = await parseBody(req, createSchema)

  if (body.customerId) await requireCustomer(ctx.org.id, body.customerId)

  const conversation = await db.conversation.create({
    data: {
      orgId: ctx.org.id,
      contactName: body.contactName ?? '',
      customerId: body.customerId ?? null,
      channel: body.channel ?? 'web',
      status: 'open',
    },
  })

  await audit({
    orgId: ctx.org.id,
    actorType: 'user',
    actorId: ctx.user.id,
    action: 'conversation.created',
    entity: 'conversation',
    entityId: conversation.id,
    meta: { channel: conversation.channel, contactName: conversation.contactName },
  })

  return json({ conversation }, 201)
})
