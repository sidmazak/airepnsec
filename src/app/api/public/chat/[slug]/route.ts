import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { withPublic, parseBody, json, fail, handleError, rateLimit } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { randomToken } from '@/lib/crypto'
import { handleReceptionistTurn } from '@/lib/ai/receptionist'
import { emitEvent } from '@/lib/automation/engine'

export const maxDuration = 60

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-chat-token',
  'access-control-max-age': '86400',
}

function cors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v)
  return res
}

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{1,60}$/
const TOKEN_RE = /^[A-Za-z0-9_-]{16,80}$/

const postSchema = z.object({
  message: z.string().trim().min(1, 'message is required').max(2000),
  token: z.string().trim().regex(TOKEN_RE, 'invalid chat token').optional(),
  name: z.string().trim().max(120).optional(),
})

function clientIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local'
}

function threadRef(token: string): string {
  return `web:${token}`
}

/** Public chat transcript rows safe to expose to the visitor (no system notes). */
function publicMessages(rows: Array<{ role: string; content: string; createdAt: Date }>) {
  return rows.map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt }))
}

export const OPTIONS = withPublic(async () => cors(new NextResponse(null, { status: 204 })))

/**
 * POST /api/public/chat/[slug] {message, token?, name?}
 * Public web-chat channel for the AI receptionist. First call returns a new chat
 * token (keep it client-side and send it back on every message). The visitor only
 * ever sees their own thread; staff see it in the Inbox like any other channel.
 * Replies are generated synchronously and returned — an AI failure is reported
 * honestly and the conversation is handed to staff.
 */
export const POST = withPublic(async (req, params) => {
  try {
    const slug = params.slug ?? ''
    if (!SLUG_RE.test(slug)) return cors(fail(404, 'Unknown business'))
    if (!rateLimit(`webchat:${clientIp(req)}:${slug}`, 30, 60_000)) {
      return cors(fail(429, 'Too many messages — please slow down.'))
    }

    const body = await parseBody(req, postSchema)
    const org = await db.organization.findUnique({ where: { slug } })
    if (!org) return cors(fail(404, 'Unknown business'))

    let token = body.token ?? ''
    let conversation = token
      ? await db.conversation.findFirst({ where: { orgId: org.id, channel: 'web', externalRef: threadRef(token) } })
      : null

    if (token && !conversation) return cors(fail(404, 'Chat session not found — start a new chat.'))
    if (!token) {
      token = randomToken(24)
      conversation = await db.conversation.create({
        data: {
          orgId: org.id,
          channel: 'web',
          status: 'open',
          contactName: body.name || 'Web visitor',
          externalRef: threadRef(token),
        },
      })
      await audit({
        orgId: org.id, actorType: 'webhook', actorId: 'web_chat',
        action: 'conversation.created', entity: 'conversation', entityId: conversation.id,
        meta: { channel: 'web', contactName: conversation.contactName },
      })
    }

    if (conversation!.status === 'closed') {
      conversation = await db.conversation.update({ where: { id: conversation!.id }, data: { status: 'open' } })
    }

    await db.message.create({
      data: { conversationId: conversation!.id, orgId: org.id, role: 'customer', content: body.message, meta: JSON.stringify({ source: 'web' }) },
    })

    if (!conversation!.aiEnabled) {
      return cors(
        json({
          token,
          reply: '',
          aiUsed: false,
          status: conversation!.status,
          note: 'Your message was received — a team member will reply here.',
        })
      )
    }

    const statusBefore = conversation!.status
    const result = await handleReceptionistTurn(org, conversation!.id, body.message, { skipInboundPersist: true })
    const fresh = await db.conversation.findUnique({ where: { id: conversation!.id } })
    if (statusBefore !== 'waiting_human' && fresh?.status === 'waiting_human') {
      await emitEvent(org.id, 'conversation_escalated', { conversationId: conversation!.id, entityId: conversation!.id })
    }

    return cors(
      json({
        token,
        reply: result.reply,
        aiUsed: result.aiUsed,
        error: result.error,
        status: fresh?.status ?? conversation!.status,
        note: !result.aiUsed && !result.error ? 'The AI assistant is paused — a team member will reply here.' : undefined,
      })
    )
  } catch (err) {
    return cors(handleError(err))
  }
})

/**
 * GET /api/public/chat/[slug] with `x-chat-token` header (or ?token=)
 * Poll the visitor's own transcript (customer/assistant/agent messages only).
 */
export const GET = withPublic(async (req, params) => {
  try {
    const slug = params.slug ?? ''
    if (!SLUG_RE.test(slug)) return cors(fail(404, 'Unknown business'))
    const token = req.headers.get('x-chat-token')?.trim() || new URL(req.url).searchParams.get('token')?.trim() || ''
    if (!TOKEN_RE.test(token)) return cors(fail(401, 'Missing or invalid chat token', { code: 'unauthorized' }))

    const org = await db.organization.findUnique({ where: { slug } })
    if (!org) return cors(fail(404, 'Unknown business'))

    const conversation = await db.conversation.findFirst({
      where: { orgId: org.id, channel: 'web', externalRef: threadRef(token) },
    })
    if (!conversation) return cors(fail(404, 'Chat session not found', { code: 'not_found' }))

    const recent = await db.message.findMany({
      where: { conversationId: conversation.id, role: { in: ['customer', 'assistant', 'agent'] } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    recent.reverse()

    return cors(
      json({
        business: org.name,
        status: conversation.status,
        aiEnabled: conversation.aiEnabled,
        messages: publicMessages(recent),
      })
    )
  } catch (err) {
    return cors(handleError(err))
  }
})
