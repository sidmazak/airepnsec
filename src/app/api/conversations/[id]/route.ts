import { z } from 'zod'
import { withAuth, json, fail, parseBody } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'

const patchSchema = z.object({
  status: z.enum(['open', 'waiting_human', 'closed']).optional(),
  aiEnabled: z.boolean().optional(),
})

/** GET /api/conversations/[id] — conversation + messages (asc) */
export const GET = withAuth(async (req, ctx, params) => {
  const conversation = await db.conversation.findFirst({
    where: { id: params.id, orgId: ctx.org.id },
    include: { customer: { select: { id: true, name: true, phone: true, email: true } } },
  })
  if (!conversation) return fail(404, 'Conversation not found', { code: 'not_found' })

  const messages = await db.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: 'asc' },
    take: 500,
  })

  return json({ conversation, messages })
})

/** PATCH /api/conversations/[id] {status?, aiEnabled?} — take over / close / resume AI */
export const PATCH = withAuth(async (req, ctx, params) => {
  const body = await parseBody(req, patchSchema)

  const conversation = await db.conversation.findFirst({
    where: { id: params.id, orgId: ctx.org.id },
  })
  if (!conversation) return fail(404, 'Conversation not found', { code: 'not_found' })

  const updated = await db.conversation.update({
    where: { id: conversation.id },
    data: {
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.aiEnabled !== undefined ? { aiEnabled: body.aiEnabled } : {}),
    },
  })

  await audit({
    orgId: ctx.org.id,
    actorType: 'user',
    actorId: ctx.user.id,
    action: 'conversation.updated',
    entity: 'conversation',
    entityId: conversation.id,
    meta: {
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.aiEnabled !== undefined ? { aiEnabled: body.aiEnabled } : {}),
    },
  })

  return json({ conversation: updated })
}, { roles: ['owner', 'admin', 'agent'] })
