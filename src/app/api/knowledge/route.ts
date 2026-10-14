import { z } from 'zod'
import { withAuth, json, parseBody } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { parseJson } from '@/lib/org'
import { indexDocument } from '@/lib/ai/embeddings'

const createSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(300),
  content: z.string().min(1, 'Content is required').max(200_000),
  approved: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(24).optional(),
  source: z.enum(['manual', 'paste', 'file']).optional(),
})

/** GET /api/knowledge — documents with chunk counts */
export const GET = withAuth(async (req, ctx) => {
  const docs = await db.knowledgeDoc.findMany({
    where: { orgId: ctx.org.id },
    orderBy: { updatedAt: 'desc' },
    take: 500,
    include: { _count: { select: { chunks: true } } },
  })

  return json({
    docs: docs.map((d) => ({
      id: d.id,
      title: d.title,
      source: d.source,
      approved: d.approved,
      tags: parseJson<string[]>(d.tags, []),
      chunkCount: d._count.chunks,
      contentPreview: d.content.slice(0, 300),
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    })),
  })
})

/** POST /api/knowledge {title, content, approved?, tags?} — creates and indexes a document */
export const POST = withAuth(async (req, ctx) => {
  const body = await parseBody(req, createSchema)

  const doc = await db.knowledgeDoc.create({
    data: {
      orgId: ctx.org.id,
      title: body.title,
      content: body.content,
      approved: body.approved ?? false,
      tags: JSON.stringify(body.tags ?? []),
      source: body.source ?? 'manual',
    },
  })

  const chunkCount = await indexDocument(ctx.org.id, doc.id, body.content)

  await audit({
    orgId: ctx.org.id,
    actorType: 'user',
    actorId: ctx.user.id,
    action: 'knowledge.created',
    entity: 'knowledge_doc',
    entityId: doc.id,
    meta: { title: doc.title, approved: doc.approved, chunkCount },
  })

  return json(
    {
      doc: {
        ...doc,
        tags: parseJson<string[]>(doc.tags, []),
        chunkCount,
      },
    },
    201
  )
})
