import { db } from '@/lib/db'
import { ApiError } from '@/lib/api'
import { decryptSecret, sha256 } from '@/lib/crypto'
import { parseJson } from '@/lib/org'
import { indexDocument } from '@/lib/ai/embeddings'
import { fetchRawRows, testDataSource, type AdapterTestResult, type Connection } from './adapters'
import { DEFAULT_LIMIT, isDataSourceKind, type DataSourceConfig, type DataSourceKind } from './registry'

/**
 * Ingest external data-source rows into the knowledge/RAG pipeline.
 * Every row becomes a KnowledgeDoc (source:"datasource") linked to its
 * external id, chunked + embedded with the org's active embedding provider.
 * Repeated syncs are idempotent: unchanged rows are skipped and rows that
 * disappeared from the source are deleted from the index.
 */

export type SyncStats = {
  fetched: number
  created: number
  updated: number
  unchanged: number
  deleted: number
  failed: number
  ms: number
}

function toText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export function rowToDocument(row: Record<string, unknown>, config: DataSourceConfig, sourceName: string) {
  const idCol = config.idColumn?.trim()
  let externalId = idCol ? toText(row[idCol]).trim() : ''
  if (!externalId) externalId = sha256(JSON.stringify(row)).slice(0, 32)

  const cols = config.textColumns?.length
    ? config.textColumns
    : Object.keys(row).filter((k) => k !== idCol)

  let text: string
  if (config.template?.trim()) {
    text = config.template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, key: string) => toText(row[key.trim()]))
  } else {
    text = cols.map((c) => `${c}: ${toText(row[c])}`).join('\n')
  }
  if (config.contentPrefix) text = `${config.contentPrefix}\n${text}`

  const titleCol = config.titleColumn?.trim()
  let title = titleCol ? toText(row[titleCol]).trim() : ''
  if (!title) {
    // fall back to the first non-empty text column, else the external id
    const firstVal = cols.map((c) => toText(row[c]).trim()).find((t) => t.length > 0)
    title = firstVal ? firstVal.slice(0, 120) : `${sourceName} · ${externalId}`
  }

  return { externalId, title: title.slice(0, 280), text: text.slice(0, 200_000) }
}

function connectionOf(source: { connectionEnc: string }): Connection {
  if (!source.connectionEnc) return {}
  try {
    return JSON.parse(decryptSecret(source.connectionEnc) || '{}') as Connection
  } catch {
    return {}
  }
}

async function loadSource(orgId: string, sourceId: string) {
  const source = await db.dataSource.findFirst({ where: { id: sourceId, orgId } })
  if (!source) throw new ApiError(404, 'Data source not found', 'not_found')
  if (!isDataSourceKind(source.kind)) throw new ApiError(422, `Unsupported data source kind: ${source.kind}`, 'bad_kind')
  return source
}

/** Test the stored connection + query and return a small preview. Never exposes secrets. */
export async function testStoredDataSource(orgId: string, sourceId: string): Promise<AdapterTestResult> {
  const source = await loadSource(orgId, sourceId)
  const kind = source.kind as DataSourceKind
  const config = parseJson<DataSourceConfig>(source.configJson, {})
  const result = await testDataSource(kind, connectionOf(source), { ...config, limit: config.limit ?? 20 })
  await db.dataSource.update({
    where: { id: source.id },
    data: {
      lastTestAt: new Date(),
      lastTestOk: result.ok,
      lastTestError: result.ok ? '' : result.message.slice(0, 500),
    },
  })
  return result
}

export type SyncResult = {
  ok: boolean
  stats: SyncStats
  documentCount: number
  chunkCount: number
}

/** Run a full sync for one source. Throws ApiError(502) on connection/query failure. */
export async function syncDataSource(orgId: string, sourceId: string): Promise<SyncResult> {
  const source = await loadSource(orgId, sourceId)
  const kind = source.kind as DataSourceKind
  const connection = connectionOf(source)
  const config = parseJson<DataSourceConfig>(source.configJson, {})
  const limit = config.limit ?? DEFAULT_LIMIT
  const approved = config.approved ?? true

  const started = Date.now()
  const stats: SyncStats = { fetched: 0, created: 0, updated: 0, unchanged: 0, deleted: 0, failed: 0, ms: 0 }

  try {
    const { rows } = await fetchRawRows(kind, connection, config, limit)
    stats.fetched = rows.length
    const seen = new Set<string>()

    for (const row of rows) {
      const doc = rowToDocument(row, config, source.name)
      if (!doc.text.trim()) continue
      seen.add(doc.externalId)
      const contentHash = sha256(doc.text)

      const existing = await db.knowledgeDoc.findFirst({
        where: { dataSourceId: source.id, externalId: doc.externalId },
        select: { id: true, contentHash: true, title: true, approved: true },
      })

      if (!existing) {
        const created = await db.knowledgeDoc.create({
          data: {
            orgId,
            title: doc.title,
            content: doc.text,
            approved,
            source: 'datasource',
            tags: JSON.stringify(['datasource', source.name]),
            dataSourceId: source.id,
            externalId: doc.externalId,
            contentHash,
          },
        })
        try {
          await indexDocument(orgId, created.id, doc.text)
        } catch (err) {
          stats.failed++
          console.error('[datasource] index failed for new row:', err instanceof Error ? err.message : err)
        }
        stats.created++
      } else if (existing.contentHash !== contentHash) {
        await db.knowledgeDoc.update({
          where: { id: existing.id },
          data: { title: doc.title, content: doc.text, approved, contentHash },
        })
        try {
          await indexDocument(orgId, existing.id, doc.text)
        } catch (err) {
          stats.failed++
          console.error('[datasource] index failed for updated row:', err instanceof Error ? err.message : err)
        }
        stats.updated++
      } else if (existing.title !== doc.title || existing.approved !== approved) {
        await db.knowledgeDoc.update({ where: { id: existing.id }, data: { title: doc.title, approved } })
        stats.updated++
      } else {
        stats.unchanged++
      }
    }

    // Remove documents that no longer exist in the source (cascades their chunks).
    const all = await db.knowledgeDoc.findMany({ where: { dataSourceId: source.id }, select: { id: true, externalId: true } })
    const staleIds = all.filter((d) => !seen.has(d.externalId)).map((d) => d.id)
    if (staleIds.length) {
      await db.knowledgeDoc.deleteMany({ where: { id: { in: staleIds } } })
      stats.deleted = staleIds.length
    }

    const documentCount = await db.knowledgeDoc.count({ where: { dataSourceId: source.id } })
    const docIds = await db.knowledgeDoc.findMany({ where: { dataSourceId: source.id }, select: { id: true } })
    const chunkCount = await db.knowledgeChunk.count({ where: { orgId, docId: { in: docIds.map((d) => d.id) } } })
    stats.ms = Date.now() - started

    await db.dataSource.update({
      where: { id: source.id },
      data: {
        lastSyncAt: new Date(),
        lastSyncOk: true,
        lastSyncError: '',
        lastSyncStats: JSON.stringify(stats),
        documentCount,
        chunkCount,
      },
    })

    return { ok: true, stats, documentCount, chunkCount }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sync failed'
    stats.ms = Date.now() - started
    await db.dataSource.update({
      where: { id: source.id },
      data: { lastSyncAt: new Date(), lastSyncOk: false, lastSyncError: message.slice(0, 500), lastSyncStats: JSON.stringify(stats) },
    })
    if (err instanceof ApiError) throw err
    throw new ApiError(502, `Data source sync failed: ${message}`, 'sync_failed')
  }
}

/**
 * Run all due auto-sync sources (called by the background worker). Each source is
 * isolated so one failure cannot abort the loop. Returns a compact summary.
 */
export async function runDueDataSourceSyncs(now = new Date()): Promise<{ ran: number; failed: number }> {
  const sources = await db.dataSource.findMany({ where: { enabled: true, autoSync: true }, take: 50 })
  let ran = 0
  let failed = 0
  for (const source of sources) {
    const due = !source.lastSyncAt || now.getTime() - source.lastSyncAt.getTime() >= source.syncIntervalMin * 60_000
    if (!due) continue
    try {
      await syncDataSource(source.orgId, source.id)
      ran++
    } catch (err) {
      failed++
      console.error(`[datasource] auto-sync failed for ${source.id}:`, err instanceof Error ? err.message : err)
    }
  }
  return { ran, failed }
}
