import { withAuth, json } from '@/lib/api'
import { getKnowledgeIndexStatus } from '@/lib/ai/embeddings'

/** GET /api/knowledge/index — embedding index status (model, coverage, needsReindex) */
export const GET = withAuth(async (_req, ctx) => {
  const status = await getKnowledgeIndexStatus(ctx.org.id)
  return json({ index: status })
})
