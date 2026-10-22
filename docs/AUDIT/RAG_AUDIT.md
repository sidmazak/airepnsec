# RAG Audit — AI Secretary

> **Historical baseline (iteration 1).** The pipeline description remains broadly accurate
> (local neural default, hybrid cosine+BM25, approved-only); see [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md)
> and [ITERATION_LOG.md](./ITERATION_LOG.md) for later changes. Vectors are still JSON in SQLite —
> the Postgres/pgvector deployment does not switch the vector store.

Core: `src/lib/ai/embeddings.ts`. Storage: `KnowledgeDoc` + `KnowledgeChunk` (SQLite).
Vectors are stored as JSON strings in `KnowledgeChunk.vector`; **no pgvector**.

## Pipeline
1. **Ingest** — knowledge docs (manual/FAQ/upload) and BYO data-source rows (`src/lib/datasources/sync.ts`).
2. **Chunk** — `chunkText`: size **600**, overlap **80**; `MAX_CHUNKS_PER_DOC` = **400**.
3. **Embed** — org embedding provider (default `local_neural`, 384-d); each chunk stores `vector`, `model`, `dim`.
4. **Search** — `searchKnowledge`: in-process **hybrid** = cosine similarity + **BM25**, weighted **72/28**;
   returns only `approved:true` chunks.
5. **Reindex** — `reindexOrgKnowledge` re-embeds on demand; `/api/knowledge/reindex` (owner/admin).

## Verified behavior (E2E)
- BYO SQLite source synced 3 rows → 3 docs → 3 chunks; re-sync idempotent (0 changed).
- Mutating source (update + delete) → re-sync applied 1 updated / 1 deleted / 1 unchanged via `contentHash`.
- Search ranked "Return policy" #1 (0.595) reflecting updated source text.
- DELETE of data source cascaded; docs disappeared from search.

## Gaps
| Gap | Sev | Detail |
|---|---|---|
| No reranking | P2 | `rerank` capability declared but not applied to results. |
| No vector index | P3 | In-process scan; fine for small corpora, not for large. |
| Restricted formats | P2 | Text/markdown/JSON only; no PDF/DOCX/HTML ingestion pipeline. |
| Single embedding space | P3 | Changing embedding model requires full reindex; no dual-index migration. |
| Chunk size fixed | P3 | No per-source tuning. |

## Security posture relevant to RAG
- BYO SQL is restricted to a single read-only `SELECT`/`WITH`; result capped at `HARD_LIMIT` (5000).
- `http_json` blocks private/loopback/link-local hosts **and now every DNS-resolved address**.
- Retrieved text is treated as untrusted content, never as instructions.
