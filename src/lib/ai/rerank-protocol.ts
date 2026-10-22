/**
 * Pure helpers for the rerank protocol (no runtime imports — unit-testable).
 */

export type RerankHit = { index: number; score: number }

/**
 * Parse a rerank response.
 *
 * Accepts the Cohere-style `{ results: [{ index, relevance_score }] }` shape
 * and the common `{ results: [{ index, score }] }` variant. Entries without a
 * usable index/score are ignored instead of poisoning the order.
 */
export function parseRerankResponse(payload: unknown): RerankHit[] {
  const results = (payload as { results?: unknown })?.results
  if (!Array.isArray(results)) return []
  const hits: RerankHit[] = []
  for (const raw of results) {
    const r = raw as { index?: unknown; relevance_score?: unknown; score?: unknown }
    const index = Number(r?.index)
    const score = Number(r?.relevance_score ?? r?.score)
    if (!Number.isFinite(index) || !Number.isFinite(score)) continue
    hits.push({ index, score })
  }
  return hits.sort((a, b) => b.score - a.score)
}

/**
 * Apply rerank scores to the candidate order.
 * Candidates the reranker did not score keep their relative position at the end.
 */
export function applyRerank<T>(candidates: T[], hits: RerankHit[], weight = 0.5): T[] {
  const reordered: T[] = []
  const used = new Set<number>()
  for (const hit of hits) {
    const candidate = candidates[hit.index]
    if (!candidate || used.has(hit.index)) continue
    used.add(hit.index)
    const base = (candidates[hit.index] as unknown as { score?: number }).score ?? 0
    reordered.push({ ...candidate, score: base * (1 - weight) + hit.score * weight } as unknown as T)
  }
  for (let i = 0; i < candidates.length; i++) {
    if (!used.has(i)) reordered.push(candidates[i])
  }
  return reordered
}
