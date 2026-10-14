import { withAuth, json, fail } from '@/lib/api'
import { searchKnowledge } from '@/lib/ai/embeddings'

/** GET /api/knowledge/search?q=&k= — retrieval over APPROVED documents only */
export const GET = withAuth(async (req, ctx) => {
  const url = new URL(req.url)
  const q = (url.searchParams.get('q') ?? '').trim()
  if (!q) return fail(422, 'Missing required query parameter: q', { code: 'validation' })

  const kRaw = Number(url.searchParams.get('k') ?? '5')
  const k = Number.isFinite(kRaw) ? Math.min(Math.max(Math.floor(kRaw), 1), 20) : 5

  const hits = await searchKnowledge(ctx.org.id, q, k)

  return json({ hits })
})
