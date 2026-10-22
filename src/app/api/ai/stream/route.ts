import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth, fail, parseBody, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { handleReceptionistTurn } from '@/lib/ai/receptionist'
import { emitEvent } from '@/lib/automation/engine'

const schema = z.object({
  conversationId: z.string().min(1).optional(),
  message: z.string().trim().min(1, 'Message content is required').max(4000),
  channel: z.enum(['dashboard', 'web', 'sms', 'whatsapp', 'voice', 'realtime']).optional(),
})

/**
 * POST /api/ai/stream — one receptionist turn as a Server-Sent Events stream.
 *
 * Event protocol (JSON in `data:`):
 *   {type:'delta', text}  — a fragment of the assistant reply
 *   {type:'tool', tool, ok, summary} — the assistant called a tool (the client
 *                            should drop any partial text it has shown)
 *   {type:'done', reply, toolCalls, aiUsed, nativeTools}
 *   {type:'error', message}
 *
 * The turn itself is the same validated tool loop as the non-streaming route —
 * streaming only changes how the answer reaches the browser. When the model
 * does not support provider-native tool calling, the strict JSON protocol is
 * used and the answer arrives as a single delta at the end (never a partially
 * rendered JSON document).
 */
export const POST = withAuth(async (req, ctx) => {
  let body: z.infer<typeof schema>
  try {
    body = await parseBody(req, schema)
  } catch (err) {
    if (err instanceof ApiError) return fail(err.status, err.message, { code: err.code })
    return fail(400, 'Invalid request body', { code: 'bad_request' })
  }

  let conversationId = body.conversationId ?? ''
  if (conversationId) {
    const existing = await db.conversation.findFirst({ where: { id: conversationId, orgId: ctx.org.id }, select: { id: true } })
    if (!existing) return fail(404, 'Conversation not found', { code: 'not_found' })
  } else {
    const created = await db.conversation.create({
      data: { orgId: ctx.org.id, channel: 'web', contactName: 'Dashboard chat' },
    })
    conversationId = created.id
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
        } catch {
          /* the client disconnected */
        }
      }

      try {
        const statusBefore = (await db.conversation.findUnique({ where: { id: conversationId }, select: { status: true } }))?.status ?? 'open'

        const result = await handleReceptionistTurn(ctx.org, conversationId, body.message, {
          channel: body.channel ?? 'dashboard',
          onDelta: (delta) => send({ type: 'delta', text: delta }),
          onTool: (info) => send({ type: 'tool', tool: info.tool, ok: info.ok, summary: info.summary }),
        })

        const fresh = await db.conversation.findUnique({ where: { id: conversationId }, select: { status: true } })
        if (statusBefore !== 'waiting_human' && fresh?.status === 'waiting_human') {
          await emitEvent(ctx.org.id, 'conversation_escalated', { conversationId, entityId: conversationId })
        }

        send({
          type: 'done',
          conversationId,
          reply: result.reply,
          toolCalls: result.toolCalls,
          aiUsed: result.aiUsed,
          nativeTools: result.nativeTools ?? false,
          error: result.error ?? null,
          skipped: result.skipped ?? null,
        })
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : 'AI turn failed' })
      } finally {
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }
    },
  })

  return new NextResponse(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}, { roles: ['owner', 'admin', 'agent'] })
