import { withAuth, json, fail } from '@/lib/api'
import { audit } from '@/lib/audit'
import { reindexOrgKnowledge } from '@/lib/ai/embeddings'

/**
 * POST /api/knowledge/reindex — re-embed every knowledge document with the
 * org's active embedding provider (owner/admin). Required after switching
 * embedding models: vectors from different models are not comparable.
 */
export const POST = withAuth(
  async (_req, ctx) => {
    const summary = await reindexOrgKnowledge(ctx.org.id)

    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'knowledge.reindexed',
      entity: 'knowledge_index',
      entityId: ctx.org.id,
      meta: { docs: summary.docs, chunks: summary.chunks, model: summary.model, provider: summary.provider, ms: summary.ms, errors: summary.errors.length },
    })

    if (summary.docs === 0) {
      return json({ ok: true, summary, message: 'No knowledge documents to index yet.' })
    }
    if (summary.errors.length > 0) {
      return fail(500, `Reindexed ${summary.chunks} chunks but ${summary.errors.length} document(s) failed: ${summary.errors.map((e) => `${e.title} (${e.error})`).join('; ')}`.slice(0, 500), { code: 'partial_reindex', summary })
    }

    return json({
      ok: true,
      summary,
      message: `Indexed ${summary.docs} document${summary.docs === 1 ? '' : 's'} into ${summary.chunks} chunks with ${summary.model} (${summary.ms} ms).`,
    })
  },
  { roles: ['owner', 'admin'] }
)
