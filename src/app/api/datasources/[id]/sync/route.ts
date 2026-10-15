import { withAuth, json } from '@/lib/api'
import { audit } from '@/lib/audit'
import { syncDataSource } from '@/lib/datasources/sync'

/**
 * POST /api/datasources/[id]/sync (owner/admin)
 * Pulls rows from the external source and (re)indexes them into the RAG pipeline.
 * Idempotent: unchanged rows are skipped, removed rows are deleted from the index.
 */
export const POST = withAuth(
  async (_req, ctx, params) => {
    const result = await syncDataSource(ctx.org.id, params.id)

    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'datasource.synced',
      entity: 'data_source',
      entityId: params.id,
      meta: { ...result.stats, documentCount: result.documentCount, chunkCount: result.chunkCount },
    })

    const s = result.stats
    return json({
      ok: true,
      result,
      message:
        `Read ${s.fetched} row${s.fetched === 1 ? '' : 's'} — ${s.created} new, ${s.updated} updated, ` +
        `${s.deleted} removed, ${s.unchanged} unchanged${s.failed ? `, ${s.failed} failed to index` : ''} ` +
        `(${result.chunkCount} chunks indexed) in ${s.ms} ms.`,
    })
  },
  { roles: ['owner', 'admin'] }
)
