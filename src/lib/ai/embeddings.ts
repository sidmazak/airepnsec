import { db } from '@/lib/db'

/**
 * Local lexical retrieval (deterministic, no external service, no model download).
 * Produces a hashed bag-of-words vector; cosine similarity powers knowledge search.
 * This is an honest, lightweight retriever — swap in a neural embedding model via
 * Settings → AI providers (Ollama / OpenAI-compatible) for semantic search.
 */

export const EMBED_DIM = 256

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

/** Split content into overlapping chunks suitable for retrieval. */
export function chunkText(text: string, size = 600, overlap = 80): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim()
  if (clean.length <= size) return clean ? [clean] : []
  const chunks: string[] = []
  let cursor = 0
  while (cursor < clean.length) {
    let end = Math.min(cursor + size, clean.length)
    if (end < clean.length) {
      const breakAt = clean.lastIndexOf('\n', end)
      if (breakAt > cursor + size * 0.5) end = breakAt
    }
    chunks.push(clean.slice(cursor, end).trim())
    if (end >= clean.length) break
    cursor = end - overlap
  }
  return chunks.filter(Boolean)
}

/** Chunk + embed + persist for a document. */
export async function indexDocument(orgId: string, docId: string, content: string): Promise<number> {
  await db.knowledgeChunk.deleteMany({ where: { docId } })
  const chunks = chunkText(content)
  let ord = 0
  for (const text of chunks) {
    await db.knowledgeChunk.create({
      data: { orgId, docId, ord: ord++, text, vector: JSON.stringify(embedLocal(text)) },
    })
  }
  return chunks.length
}

export type KnowledgeHit = { docId: string; docTitle: string; chunkId: string; text: string; score: number }

/** Search APPROVED knowledge for a query. Only approved docs are ever returned. */
export async function searchKnowledge(orgId: string, query: string, k = 5): Promise<KnowledgeHit[]> {
  const docs = await db.knowledgeDoc.findMany({ where: { orgId, approved: true }, select: { id: true, title: true } })
  if (docs.length === 0) return []
  const docMap = new Map(docs.map((d) => [d.id, d.title]))

  const queryTokens = new Set(tokenize(query))
  const queryVec = embedLocal(query)
  const chunks = await db.knowledgeChunk.findMany({ where: { orgId, docId: { in: docs.map((d) => d.id) } } })

  const scored = chunks.map((c) => {
    let vec: number[] = []
    try {
      vec = JSON.parse(c.vector)
    } catch {
      vec = []
    }
    const semantic = cosine(queryVec, vec)
    const tokens = tokenize(c.text)
    const overlap = tokens.filter((t) => queryTokens.has(t)).length
    const lexical = tokens.length ? overlap / Math.sqrt(tokens.length) : 0
    return { docId: c.docId, docTitle: docMap.get(c.docId) ?? '', chunkId: c.id, text: c.text, score: semantic * 0.5 + lexical * 0.5 }
  })

  return scored
    .filter((s) => s.score > 0.02)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
}
