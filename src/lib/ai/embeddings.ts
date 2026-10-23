import path from 'node:path'
import { db } from '@/lib/db'
import { getActiveProvider, getApiKey, assertAiPolicy } from '@/lib/ai/providers'

/**
 * Knowledge retrieval (RAG) pipeline.
 *
 * Embedding providers, in order of recommendation:
 *  - local_neural      Built-in ONNX sentence transformer (all-MiniLM-L6-v2, 384-d) running
 *                      fully on this machine via transformers.js. Real semantic embeddings,
 *                      no API key, no data leaving the server. Default.
 *  - ollama            Local Ollama /api/embeddings (e.g. nomic-embed-text). Data stays local.
 *  - openai_compatible Any OpenAI-compatible /embeddings endpoint (BYOK). Data leaves the machine.
 *  - local_lexical     Legacy hashed bag-of-words fallback (deterministic, no model). Kept for
 *                      offline resilience; also used automatically if a neural provider fails.
 *
 * Retrieval is hybrid: dense cosine similarity (only when chunk.model === active model) fused
 * with BM25 lexical scoring, so search degrades gracefully instead of breaking.
 *
 * Indexing stores the embedding model + dimension per chunk; switching models marks the index
 * stale ("needs reindex") and controlled re-embedding is available via reindexOrgKnowledge().
 */

export const LOCAL_NEURAL_MODEL = 'Xenova/all-MiniLM-L6-v2'
export const LOCAL_NEURAL_DIM = 384
/** Legacy hashed bag-of-words dimension (kept for the lexical fallback engine). */
export const EMBED_DIM = 256
export const LEXICAL_HASH_MODEL = 'local_lexical_hash'
/** Batch size for embedding calls against HTTP providers. */
const EMBED_BATCH = 16
/** Max chunks indexed per document (guards runaway content). */
const MAX_CHUNKS_PER_DOC = 400

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that', 'with', 'as', 'by', 'from', 'you', 'we', 'our', 'your', 'i'])

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

function hashToken(token: string): number {
  let h = 2166136261
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

export function embedLocal(text: string): number[] {
  const vec = new Array<number>(EMBED_DIM).fill(0)
  const tokens = tokenize(text)
  for (const t of tokens) {
    const h = hashToken(t)
    vec[h % EMBED_DIM] += 1
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
  return vec.map((v) => v / norm)
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i]
  return dot
}

/* ------------------------------------------------------------------ */
/* Chunking — heading/sentence aware                                   */
/* ------------------------------------------------------------------ */

/**
 * Split content into overlapping, retrieval-friendly chunks.
 * Prefers markdown headings and paragraph boundaries, then sentence boundaries;
 * never splits mid-word. Overlap keeps cross-chunk context for retrieval.
 */
export function chunkText(text: string, size = 600, overlap = 80): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim()
  if (!clean) return []
  if (clean.length <= size) return [clean]

  // Candidate blocks: markdown headings, list items and paragraphs are boundaries.
  const blocks = clean
    .split(/(?=\n#{1,6}\s)|\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)

  const chunks: string[] = []
  let current = ''

  const flush = () => {
    if (current.trim()) chunks.push(current.trim())
    current = ''
  }

  for (const block of blocks) {
    if (block.length > size) {
      // Oversized block: split by sentence, keeping an overlap tail.
      flush()
      const sentences = block.match(/[^.!?\n]+[.!?]*\s*|\n/g) ?? [block]
      let buf = ''
      for (const s of sentences) {
        if ((buf + s).length > size && buf.trim()) {
          chunks.push(buf.trim())
          buf = buf.slice(Math.max(0, buf.length - overlap))
        }
        buf += s
      }
      if (buf.trim()) chunks.push(buf.trim())
      continue
    }
    if ((current + '\n\n' + block).length > size && current) {
      flush()
      // carry a little context from the previous chunk into the next one
      current = current.slice(Math.max(0, current.length - overlap)) + '\n\n'
    }
    current = current ? `${current}\n\n${block}` : block
  }
  flush()

  return chunks.filter(Boolean).slice(0, MAX_CHUNKS_PER_DOC)
}

/* ------------------------------------------------------------------ */
/* Neural engine (transformers.js / ONNX) — lazy singleton             */
/* ------------------------------------------------------------------ */

type Extractor = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean }
) => Promise<{ tolist: () => number[][] }>

type NeuralEngine = { extractor: Extractor; model: string; dim: number }

let enginePromise: Promise<NeuralEngine> | null = null

async function getNeuralEngine(): Promise<NeuralEngine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const transformers = await import('@huggingface/transformers')
      const env = transformers.env
      env.cacheDir = path.join(process.cwd(), '.models') // persistent local cache
      env.allowLocalModels = false
      const extractor = await transformers.pipeline('feature-extraction', LOCAL_NEURAL_MODEL, {
        dtype: 'q8',
      })
      return { extractor: extractor as unknown as Extractor, model: LOCAL_NEURAL_MODEL, dim: LOCAL_NEURAL_DIM }
    })().catch((err) => {
      enginePromise = null // allow a later retry after a failed load
      throw err
    })
  }
  return enginePromise
}

/**
 * Pre-load the local embedding model (e.g. at server boot) so the first search is fast.
 * Returns false if the model could not be loaded — callers must degrade gracefully.
 */
export async function warmEmbeddingModel(): Promise<boolean> {
  try {
    const engine = await getNeuralEngine()
    await engine.extractor(['warmup'], { pooling: 'mean', normalize: true })
    return true
  } catch (err) {
    console.error('[embeddings] neural model warmup failed:', err instanceof Error ? err.message : err)
    return false
  }
}

/** Direct neural embedding — used by provider tests and the default local engine. */
export async function embedNeural(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const engine = await getNeuralEngine()
  const out = await engine.extractor(texts, { pooling: 'mean', normalize: true })
  return out.tolist()
}

/* ------------------------------------------------------------------ */
/* Provider-aware embedding                                            */
/* ------------------------------------------------------------------ */

export type EmbedderInfo = { provider: string; model: string; dim: number; label: string }
export type Embedder = { info: EmbedderInfo; embed: (texts: string[]) => Promise<number[][]> }

async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 20_000, ...rest } = init
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...rest, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function embedOllama(row: { baseUrl: string; model: string }, texts: string[]): Promise<number[][]> {
  const base = row.baseUrl.replace(/\/$/, '')
  const out: number[][] = []
  for (const text of texts) {
    // Modern Ollama exposes /api/embed; fall back to the legacy /api/embeddings.
    let res = await fetchWithTimeout(`${base}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: row.model, input: [text] }),
    })
    if (res.ok) {
      const data = (await res.json()) as { embeddings?: number[][] }
      if (data.embeddings?.[0]) {
        out.push(data.embeddings[0])
        continue
      }
    } else if (res.status !== 404) {
      throw new Error(`Ollama embeddings returned HTTP ${res.status}`)
    }
    res = await fetchWithTimeout(`${base}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: row.model, prompt: text }),
    })
    if (!res.ok) throw new Error(`Ollama embeddings returned HTTP ${res.status}`)
    const data = (await res.json()) as { embedding?: number[] }
    if (!data.embedding?.length) throw new Error('Ollama returned an empty embedding')
    out.push(data.embedding)
  }
  return out
}

async function embedOpenAiCompatible(
  row: { baseUrl: string; model: string; apiKeyEnc: string },
  texts: string[]
): Promise<number[][]> {
  if (!row.baseUrl) throw new Error('Embedding endpoint base URL is not configured')
  const key = getApiKey(row)
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH)
    const res = await fetchWithTimeout(`${row.baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: row.model, input: batch }),
    })
    if (!res.ok) throw new Error(`Embedding endpoint returned HTTP ${res.status}`)
    const data = (await res.json()) as { data?: Array<{ index?: number; embedding: number[] }> }
    const items = [...(data.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    for (const item of items) out.push(item.embedding)
  }
  return out
}

async function embedGoogle(
  row: { baseUrl: string; model: string; apiKeyEnc: string },
  texts: string[]
): Promise<number[][]> {
  if (!row.baseUrl) throw new Error('Gemini embedding base URL is not configured')
  const { googleHeaders, normalizeGoogleBase } = await import('@/lib/ai/google')
  const key = getApiKey(row)
  const base = normalizeGoogleBase(row.baseUrl)
  const model = row.model || 'gemini-embedding-001'
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH)
    const res = await fetchWithTimeout(`${base}/models/${encodeURIComponent(model)}:batchEmbedContents`, {
      method: 'POST',
      headers: googleHeaders(key),
      body: JSON.stringify({
        requests: batch.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] } })),
      }),
    })
    if (!res.ok) throw new Error(`Gemini embedding endpoint returned HTTP ${res.status}`)
    const data = (await res.json()) as { embeddings?: Array<{ values?: number[] }> }
    for (const item of data.embeddings ?? []) {
      if (!item.values?.length) throw new Error('Gemini returned an empty embedding')
      out.push(item.values)
    }
  }
  return out
}

async function embedAzure(
  row: { baseUrl: string; model: string; apiKeyEnc: string; configJson?: string },
  texts: string[]
): Promise<number[][]> {
  if (!row.baseUrl) throw new Error('Azure OpenAI embedding deployment is not configured')
  const { azureHeaders, azureUrl } = await import('@/lib/ai/azure')
  const key = getApiKey(row)
  let apiVersion = '2024-10-21'
  try {
    const config = JSON.parse(row.configJson || '{}') as { apiVersion?: unknown }
    if (typeof config.apiVersion === 'string' && config.apiVersion) apiVersion = config.apiVersion
  } catch { /* keep default */ }
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH)
    const res = await fetchWithTimeout(azureUrl(row.baseUrl, row.model, 'embeddings', apiVersion), {
      method: 'POST',
      headers: azureHeaders(key),
      body: JSON.stringify({ model: row.model, input: batch }),
    })
    if (!res.ok) throw new Error(`Azure OpenAI embedding endpoint returned HTTP ${res.status}`)
    const data = (await res.json()) as { data?: Array<{ index?: number; embedding: number[] }> }
    const items = [...(data.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    for (const item of items) out.push(item.embedding)
  }
  return out
}

const EMBEDDER_LABELS: Record<string, string> = {
  local_neural: 'Built-in neural model (local ONNX)',
  ollama: 'Ollama (local)',
  openai_compatible: 'OpenAI-compatible endpoint',
  google: 'Google Gemini embeddings',
  azure_openai: 'Azure OpenAI embeddings',
  local_lexical: 'Legacy keyword index (local)',
}

/**
 * Resolve the active embedding engine for an org. Never throws for missing rows —
 * falls back to the built-in neural model, then the lexical hash if neural fails.
 */
export async function resolveEmbedder(orgId: string): Promise<Embedder> {
  const row = await getActiveProvider(orgId, 'embedding').catch(() => null)

  const provider = row?.provider ?? 'local_neural'
  const model = row?.model ?? ''
  const baseInfo = {
    label: EMBEDDER_LABELS[provider] ?? provider,
    provider,
  }

  if (provider === 'ollama') {
    const info: EmbedderInfo = { ...baseInfo, provider, model: model || 'nomic-embed-text', dim: 0 }
    return {
      info,
      embed: async (texts) => {
        const vectors = await embedOllama({ baseUrl: row!.baseUrl, model: info.model }, texts)
        info.dim = vectors[0]?.length ?? 0
        return vectors
      },
    }
  }

  if (provider === 'openai_compatible') {
    const info: EmbedderInfo = { ...baseInfo, provider, model: model || 'text-embedding-3-small', dim: 0 }
    return {
      info,
      embed: async (texts) => {
        await assertAiPolicy(orgId, 'openai_compatible', row!.baseUrl) // local-only mode blocks cloud embeddings; self-hosted endpoints stay allowed
        const vectors = await embedOpenAiCompatible(
          { baseUrl: row!.baseUrl, model: info.model, apiKeyEnc: row!.apiKeyEnc },
          texts
        )
        info.dim = vectors[0]?.length ?? 0
        return vectors
      },
    }
  }

  if (provider === 'google') {
    const info: EmbedderInfo = { ...baseInfo, provider, model: model || 'gemini-embedding-001', dim: 0 }
    return {
      info,
      embed: async (texts) => {
        await assertAiPolicy(orgId, 'google', row!.baseUrl)
        const vectors = await embedGoogle({ baseUrl: row!.baseUrl, model: info.model, apiKeyEnc: row!.apiKeyEnc }, texts)
        info.dim = vectors[0]?.length ?? 0
        return vectors
      },
    }
  }

  if (provider === 'azure_openai') {
    const info: EmbedderInfo = { ...baseInfo, provider, model: model || 'text-embedding-3-small', dim: 0 }
    return {
      info,
      embed: async (texts) => {
        await assertAiPolicy(orgId, 'azure_openai', row!.baseUrl)
        const vectors = await embedAzure({ baseUrl: row!.baseUrl, model: info.model, apiKeyEnc: row!.apiKeyEnc, configJson: row!.configJson }, texts)
        info.dim = vectors[0]?.length ?? 0
        return vectors
      },
    }
  }

  if (provider === 'local_lexical') {
    const info: EmbedderInfo = { ...baseInfo, provider, model: LEXICAL_HASH_MODEL, dim: EMBED_DIM }
    return { info, embed: async (texts) => texts.map(embedLocal) }
  }

  // local_neural (default) — and the honest fallback if the model cannot load.
  const info: EmbedderInfo = { ...baseInfo, provider: 'local_neural', model: LOCAL_NEURAL_MODEL, dim: LOCAL_NEURAL_DIM }
  return {
    info,
    embed: async (texts) => {
      try {
        return await embedNeural(texts)
      } catch (err) {
        console.error('[embeddings] neural engine unavailable, using lexical fallback:', err instanceof Error ? err.message : err)
        info.provider = 'local_lexical'
        info.model = LEXICAL_HASH_MODEL
        info.dim = EMBED_DIM
        info.label = 'Legacy keyword index (neural model unavailable)'
        return texts.map(embedLocal)
      }
    },
  }
}

/* ------------------------------------------------------------------ */
/* Indexing                                                            */
/* ------------------------------------------------------------------ */

export type IndexResult = { chunkCount: number; model: string; dim: number; provider: string }

/** Chunk + embed + persist a document with the org's active embedding provider. */
export async function indexDocument(orgId: string, docId: string, content: string): Promise<IndexResult> {
  const embedder = await resolveEmbedder(orgId)
  const chunks = chunkText(content)
  let vectors: number[][] = []
  try {
    vectors = chunks.length ? await embedder.embed(chunks) : []
  } catch (err) {
    // A failing remote provider must not make documents unindexable — degrade honestly.
    console.error('[embeddings] provider embed failed during indexing, using lexical fallback:', err instanceof Error ? err.message : err)
    vectors = chunks.map(embedLocal)
    return persistChunks(orgId, docId, chunks, vectors, LEXICAL_HASH_MODEL, EMBED_DIM, 'local_lexical')
  }
  return persistChunks(orgId, docId, chunks, vectors, embedder.info.model, embedder.info.dim || EMBED_DIM, embedder.info.provider)
}

async function persistChunks(
  orgId: string,
  docId: string,
  chunks: string[],
  vectors: number[][],
  model: string,
  dim: number,
  provider: string
): Promise<IndexResult> {
  await db.knowledgeChunk.deleteMany({ where: { docId } })
  if (chunks.length) {
    await db.knowledgeChunk.createMany({
      data: chunks.map((text, i) => ({
        orgId,
        docId,
        ord: i,
        text,
        vector: JSON.stringify(vectors[i] ?? []),
        model,
        dim,
      })),
    })
  }
  return { chunkCount: chunks.length, model, dim, provider }
}

/* ------------------------------------------------------------------ */
/* Search — hybrid dense + BM25                                        */
/* ------------------------------------------------------------------ */

export type KnowledgeHit = {
  docId: string
  docTitle: string
  chunkId: string
  text: string
  score: number
  scores: { dense: number | null; lexical: number }
}

/** BM25 parameters (standard-ish). */
const BM25_K1 = 1.4
const BM25_B = 0.75

/**
 * Hybrid retrieval over APPROVED knowledge. Dense cosine (when chunk vectors were
 * produced by the same model as the query embedding) is fused with BM25 lexical
 * scoring. Only approved documents are ever returned.
 */
export async function searchKnowledge(orgId: string, query: string, k = 5): Promise<KnowledgeHit[]> {
  const docs = await db.knowledgeDoc.findMany({ where: { orgId, approved: true }, select: { id: true, title: true } })
  if (docs.length === 0) return []
  const docMap = new Map(docs.map((d) => [d.id, d.title]))

  const chunks = await db.knowledgeChunk.findMany({ where: { orgId, docId: { in: docs.map((d) => d.id) } } })
  if (chunks.length === 0) return []

  // Resolve the query embedding; a failing provider degrades to lexical-only.
  let queryVec: number[] | null = null
  let activeModel = ''
  try {
    const embedder = await resolveEmbedder(orgId)
    activeModel = embedder.info.model
    const [v] = await embedder.embed([query])
    if (v?.length) queryVec = v
  } catch (err) {
    console.error('[embeddings] query embedding failed, lexical-only search:', err instanceof Error ? err.message : err)
  }

  // ---- BM25 over the candidate chunk set ----
  const chunkTokens = chunks.map((c) => tokenize(c.text))
  const docFreq = new Map<string, number>()
  for (const tokens of chunkTokens) {
    for (const t of new Set(tokens)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1)
  }
  const avgdl = chunkTokens.reduce((s, t) => s + t.length, 0) / chunkTokens.length || 1
  const queryTokens = Array.from(new Set(tokenize(query)))
  const bm25Scores = chunkTokens.map((tokens, idx) => {
    const tf = new Map<string, number>()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    let score = 0
    for (const q of queryTokens) {
      const df = docFreq.get(q) ?? 0
      if (df === 0) continue
      const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5))
      const f = tf.get(q) ?? 0
      score += idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * (tokens.length / avgdl))))
    }
    return { idx, score }
  })
  const maxBm25 = Math.max(...bm25Scores.map((s) => s.score), 0)

  // ---- fuse ----
  const scored = chunks.map((c, idx) => {
    const bm25 = maxBm25 > 0 ? (bm25Scores[idx].score / maxBm25) : 0

    let dense: number | null = null
    if (queryVec && c.model === activeModel && c.dim === queryVec.length) {
      try {
        const vec = JSON.parse(c.vector) as number[]
        if (Array.isArray(vec) && vec.length === queryVec.length) {
          dense = Math.max(0, Math.min(1, cosine(queryVec, vec))) // cosine can be slightly negative; clamp
        }
      } catch {
        dense = null
      }
    }

    const score = dense !== null ? 0.72 * dense + 0.28 * bm25 : bm25
    return {
      docId: c.docId,
      docTitle: docMap.get(c.docId) ?? '',
      chunkId: c.id,
      text: c.text,
      score,
      scores: { dense, lexical: bm25 },
    }
  })

  const candidates = scored
    .filter((s) => s.score > 0.02)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)

  if (!candidates.length) return candidates

  // Optional second stage: a real reranker re-orders the candidates. When no
  // reranker is configured (or it fails) the hybrid order is kept.
  const { rerankDocuments } = await import('@/lib/ai/rerank')
  const outcome = await rerankDocuments(orgId, query, candidates.map((c) => c.text))
  if (!outcome.applied || !outcome.results.length) return candidates

  const { applyRerank } = await import('@/lib/ai/rerank-protocol')
  return applyRerank(candidates, outcome.results).slice(0, k)
}

/* ------------------------------------------------------------------ */
/* Index status + controlled reindex                                   */
/* ------------------------------------------------------------------ */

export type KnowledgeIndexStatus = {
  provider: string
  model: string
  enabled: boolean
  providerLabel: string
  docs: number
  approvedDocs: number
  totalChunks: number
  chunksWithCurrentModel: number
  needsReindex: boolean
  neuralReady: boolean
}

export async function getKnowledgeIndexStatus(orgId: string): Promise<KnowledgeIndexStatus> {
  const [row, docs, modelGroups] = await Promise.all([
    getActiveProvider(orgId, 'embedding').catch(() => null),
    db.knowledgeDoc.findMany({ where: { orgId }, select: { approved: true } }),
    db.knowledgeChunk.groupBy({ by: ['model'], where: { orgId }, _count: { _all: true } }),
  ])

  const provider = row?.provider ?? 'local_neural'
  let model = LOCAL_NEURAL_MODEL
  let neuralReady = true
  if (provider === 'local_neural') {
    try {
      await getNeuralEngine()
    } catch {
      neuralReady = false
      model = LEXICAL_HASH_MODEL // runtime fallback target
    }
  } else if (provider === 'local_lexical') {
    model = LEXICAL_HASH_MODEL
  } else {
    model = row?.model || (provider === 'ollama' ? 'nomic-embed-text' : 'text-embedding-3-small')
  }

  const totalChunks = modelGroups.reduce((s, g) => s + g._count._all, 0)
  const chunksWithCurrentModel = modelGroups.find((g) => g.model === model)?._count._all ?? 0
  const approvedDocs = docs.filter((d) => d.approved).length

  return {
    provider,
    model,
    enabled: row?.enabled ?? true,
    providerLabel: EMBEDDER_LABELS[provider] ?? provider,
    docs: docs.length,
    approvedDocs,
    totalChunks,
    chunksWithCurrentModel,
    needsReindex: approvedDocs > 0 && chunksWithCurrentModel < totalChunks,
    neuralReady,
  }
}

export type ReindexSummary = {
  docs: number
  chunks: number
  model: string
  dim: number
  provider: string
  ms: number
  errors: Array<{ docId: string; title: string; error: string }>
}

/** Re-embed every knowledge document with the org's active embedding provider. */
export async function reindexOrgKnowledge(orgId: string): Promise<ReindexSummary> {
  const started = Date.now()
  const embedder = await resolveEmbedder(orgId)
  const docs = await db.knowledgeDoc.findMany({ where: { orgId }, select: { id: true, title: true, content: true }, take: 500 })

  let chunks = 0
  const errors: ReindexSummary['errors'] = []
  for (const doc of docs) {
    try {
      const result = await indexDocument(orgId, doc.id, doc.content)
      chunks += result.chunkCount
    } catch (err) {
      errors.push({ docId: doc.id, title: doc.title, error: err instanceof Error ? err.message : 'indexing failed' })
    }
  }

  return {
    docs: docs.length,
    chunks,
    model: embedder.info.model,
    dim: embedder.info.dim || EMBED_DIM,
    provider: embedder.info.provider,
    ms: Date.now() - started,
    errors,
  }
}
