import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { withAuth, json, parseBody } from '@/lib/api'
import { z } from 'zod'
import { runReceptionistTool } from '@/lib/ai/receptionist'

const schema = z.object({
  conversationId: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
})

export const POST = withAuth(async (req, ctx) => {
  const data = await parseBody(req, schema)
  const conv = await db.conversation.findFirst({ where: { id: data.conversationId, orgId: ctx.org.id } })
  if (!conv) return json({ error: 'conversation_not_found' }, 404)
  const result = await runReceptionistTool(ctx.org, data.conversationId, data.tool, (data.args as Record<string, unknown>) || {})
  return json({ tool: data.tool, result })
}, { roles: ['owner', 'admin', 'viewer'] })
