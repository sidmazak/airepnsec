import { z } from 'zod'
import { withAuth, json, fail, parseBody } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'

const replySchema = z.object({
  content: z.string().trim().min(1, 'Message content is required').max(4000),
})

/**
 * POST /api/conversations/[id]/agent-reply {content}
 * Human agent message. If the conversation was waiting for a human it flips
 * back to open (the human has taken over).
 */
export const POST = withAuth(async (req, ctx, params) => {
  const body = await parseBody(req, replySchema)

  const conversation = await db.conversation.findFirst({
    where: { id: params.id, orgId: ctx.org.id },
  })
  if (!conversation) return fail(404, 'Conversation not found', { code: 'not_found' })

  const message = await db.message.create({
    data: {
      conversationId: conversation.id,
      orgId: ctx.org.id,
      role: 'agent',
      content: body.content,
    },
  })

  if (conversation.status === 'waiting_human') {
    await db.conversation.update({ where: { id: conversation.id }, data: { status: 'open' } })
  }

  await audit({
    orgId: ctx.org.id,
    actorType: 'user',
    actorId: ctx.user.id,
    action: 'conversation.agent_replied',
    entity: 'conversation',
    entityId: conversation.id,
    meta: { length: body.content.length },
  })

  return json({ message }, 201)
})
