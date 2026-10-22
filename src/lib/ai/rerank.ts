import { getActiveProvider, getApiKey, assertAiPolicy } from '@/lib/ai/providers'
import { parseRerankResponse, type RerankHit } from '@/lib/ai/rerank-protocol'

export { parseRerankResponse }
export type { RerankHit }

/**
 * Reranking.
 *
 * An optional second-stage ranker: the hybrid retriever produces candidates,
 * the reranker scores them against the query and the order is corrected. The
 * endpoint shape is the Cohere-style `/rerank` API, which most self-hosted
 * rerankers (and several OpenAI-compatible gateways) expose:
 *
 *   POST {baseUrl}/rerank
 *   { model, query, documents: string[], top_n }
 *   -> { results: [{ index, relevance_score }] }
 *
 * When no reranker is configured (or the call fails) the retriever's own order
 * is kept — reranking improves precision, it must never break retrieval.
 */

export type RerankOutcome = {
  /** True when a real reranker call happened. */
  applied: boolean
  /** The reordered results (empty when not applied). */
  results: RerankHit[]
  /** Why the reranker was not used. */
  reason: string
  latencyMs: number
}

/** Rerank the given documents against the query. Never throws. */
export async function rerankDocuments(
  orgId: string,
  query: string,
  documents: string[]
): Promise<RerankOutcome> {
  const started = Date.now()
  if (!documents.length) return { applied: false, results: [], reason: 'no candidates', latencyMs: 0 }

  const row = await getActiveProvider(orgId, 'rerank')
  if (!row) return { applied: false, results: [], reason: 'no reranker configured', latencyMs: 0 }
  if (!row.baseUrl) return { applied: false, results: [], reason: 'reranker has no base URL', latencyMs: 0 }
  if (row.provider !== 'openai_compatible') {
    return { applied: false, results: [], reason: `provider kind "${row.provider}" cannot rerank`, latencyMs: 0 }
  }

  try {
    await assertAiPolicy(orgId, row.provider, row.baseUrl)
  } catch (err) {
    return { applied: false, results: [], reason: err instanceof Error ? err.message : 'blocked by data mode', latencyMs: 0 }
  }

  const key = getApiKey(row)
  try {
    const res = await fetch(`${row.baseUrl.replace(/\/$/, '')}/rerank`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model: row.model || 'rerank-english-v3.0',
        query,
        documents,
        top_n: documents.length,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      return { applied: false, results: [], reason: `reranker returned HTTP ${res.status}`, latencyMs: Date.now() - started }
    }
    const payload = await res.json()
    const hits = parseRerankResponse(payload)
    if (!hits.length) {
      return { applied: false, results: [], reason: 'reranker returned no usable scores', latencyMs: Date.now() - started }
    }
    return { applied: true, results: hits, reason: 'reranked', latencyMs: Date.now() - started }
  } catch (err) {
    return {
      applied: false,
      results: [],
      reason: err instanceof Error ? err.message : 'reranker unreachable',
      latencyMs: Date.now() - started,
    }
  }
}
