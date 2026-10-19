import { z } from 'zod'
import { withAuth, json, fail, parseBody } from '@/lib/api'
import { db } from '@/lib/db'

const schema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'agent', 'tool']),
        content: z.string().trim().min(1).max(4000),
      })
    )
    .min(1)
    .max(50),
})

/**
 * POST /api/conversations/[id]/transcript {messages:[{role,content}]}
 * Persists transcript turns produced outside the text pipeline (WebRTC realtime
 * voice) so voice conversations are not lost. Tool events stay client-side only.
 * Does NOT trigger an AI turn — this is a record, not a request.
 */
export const POST = withAuth(async (req, ctx, params) => {
  const conversation = await db.conversation.findFirst({ where: { id: params.id, orgId: ctx.org.id } })
  if (!conversation) return fail(404, 'Conversation not found', { code: 'not_found' })

  const body = await parseBody(req, schema)
  let saved = 0
  for (const m of body.messages) {
    if (m.role === 'tool') continue
    await db.message.create({
      data: {
        conversationId: conversation.id,
        orgId: ctx.org.id,
        role: m.role === 'user' ? 'customer' : m.role,
        content: m.content,
        meta: JSON.stringify({ source: 'realtime' }),
      },
    })
    saved++
  }
  if (saved > 0) {
    await db.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } })
  }
  return json({ saved }, 201)
}, { roles: ['owner', 'admin', 'agent'] })
