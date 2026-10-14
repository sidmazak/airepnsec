import { z } from 'zod'
import { withAuth, json, fail, parseBody } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { parseJson } from '@/lib/org'
import { indexDocument } from '@/lib/ai/embeddings'

const patchSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  content: z.string().min(1).max(200_000).optional(),
  approved: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(24).optional(),
})

/** PATCH /api/knowledge/[id] — edits a doc; re-indexes when content/approved changed */
export const PATCH = withAuth(async (req, ctx, params) => {
  const body = await parseBody(req, patchSchema)

  const doc = await db.knowledgeDoc.findFirst({ where: { id: params.id, orgId: ctx.org.id } })
  if (!doc) return fail(404, 'Knowledge document not found', { code: 'not_found' })

  const updated = await db.knowledgeDoc.update({
    where: { id: doc.id },
    data: {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.content !== undefined ? { content: body.content } : {}),
      ...(body.approved !== undefined ? { approved: body.approved } : {}),
      ...(body.tags !== undefined ? { tags: JSON.stringify(body.tags) } : {}),
    },
  })

  let indexed: Awaited<ReturnType<typeof indexDocument>> | null = null
  if (body.content !== undefined || body.approved !== undefined) {
    indexed = await indexDocument(ctx.org.id, doc.id, updated.content)
  }

  await audit({
    orgId: ctx.org.id,
    actorType: 'user',
    actorId: ctx.user.id,
    action: 'knowledge.updated',
    entity: 'knowledge_doc',
    entityId: doc.id,
    meta: {
      title: updated.title,
      approved: updated.approved,
      reindexed: indexed !== null,
      chunkCount: indexed?.chunkCount ?? null,
      embeddingModel: indexed?.model ?? null,
    },
  })

  return json({
    doc: {
      ...updated,
      tags: parseJson<string[]>(updated.tags, []),
      chunkCount: indexed?.chunkCount ?? (await db.knowledgeChunk.count({ where: { docId: doc.id } })),
      embeddingModel: indexed?.model ?? null,
    },
  })
})

/** DELETE /api/knowledge/[id] — removes doc + chunks (cascade) */
export const DELETE = withAuth(async (req, ctx, params) => {
  const doc = await db.knowledgeDoc.findFirst({ where: { id: params.id, orgId: ctx.org.id } })
  if (!doc) return fail(404, 'Knowledge document not found', { code: 'not_found' })

  await db.knowledgeDoc.delete({ where: { id: doc.id } })

  await audit({
    orgId: ctx.org.id,
    actorType: 'user',
    actorId: ctx.user.id,
    action: 'knowledge.deleted',
    entity: 'knowledge_doc',
    entityId: doc.id,
    meta: { title: doc.title },
  })

  return json({ ok: true })
})
