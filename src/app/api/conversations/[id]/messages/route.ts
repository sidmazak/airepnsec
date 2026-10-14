import { z } from 'zod'
import { withAuth, json, fail, parseBody } from '@/lib/api'
import { db } from '@/lib/db'
import { handleReceptionistTurn, type TurnResult } from '@/lib/ai/receptionist'
import { emitEvent } from '@/lib/automation/engine'

const messageSchema = z.object({
  content: z.string().trim().min(1, 'Message content is required').max(4000),
})

/**
 * POST /api/conversations/[id]/messages {content}
 * Runs one AI receptionist turn. If the conversation escalated to a human during
 * THIS turn (and it wasn't already waiting), the `conversation_escalated` event is
 * emitted so event-triggered automations can fire. AI errors are returned honestly
 * in the body — the receptionist has already stored a truthful fallback reply.
 */
export const POST = withAuth(async (req, ctx, params) => {
  const body = await parseBody(req, messageSchema)

  const conversation = await db.conversation.findFirst({
    where: { id: params.id, orgId: ctx.org.id },
  })
  if (!conversation) return fail(404, 'Conversation not found', { code: 'not_found' })

  const statusBefore = conversation.status

  let result: TurnResult
  try {
    result = await handleReceptionistTurn(ctx.org, conversation.id, body.content)
  } catch (err) {
    // The receptionist persists its own honest fallback; only unexpected crashes land here.
    const message = err instanceof Error ? err.message : 'AI turn failed'
    return json({ reply: '', assistantReply: '', toolCalls: [], aiUsed: false, error: message })
  }

  const fresh = await db.conversation.findUnique({ where: { id: conversation.id } })
  const statusAfter = fresh?.status ?? statusBefore
  if (statusBefore !== 'waiting_human' && statusAfter === 'waiting_human') {
    await emitEvent(ctx.org.id, 'conversation_escalated', {
      conversationId: conversation.id,
      entityId: conversation.id,
    })
  }

  return json({ ...result, assistantReply: result.reply })
})
