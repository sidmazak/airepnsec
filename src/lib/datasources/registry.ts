import { z } from 'zod'

/**
 * Bring-your-own data source registry.
 *
 * A data source is an external relational/SQL database or a JSON HTTP endpoint
 * whose rows are extracted as documents and indexed into the SAME knowledge/RAG
 * pipeline (chunked + embedded with the org's embedding provider). The core app
 * does not depend on any specific database vendor — every kind is normalized to
 * a list of { externalId, title, text } rows by an adapter in ./adapters.
 *
 * Adding a new kind = add metadata here + an adapter branch + a config schema.
 */

export const DATA_SOURCE_KINDS = ['postgres', 'mysql', 'sqlite', 'http_json'] as const
export type DataSourceKind = (typeof DATA_SOURCE_KINDS)[number]

export function isDataSourceKind(v: string): v is DataSourceKind {
  return (DATA_SOURCE_KINDS as readonly string[]).includes(v)
}

export type DataSourceKindInfo = {
  kind: DataSourceKind
  label: string
  /** Where the data is read from — shown honestly in the UI. */
  connectionSummary: string
  /** Fields that must be stored encrypted (credentials / connection string). */
  secretFields: Array<{ key: string; label: string; placeholder: string; required: boolean }>
  /** Non-secret config fields expected (free-form text). */
  configHints: {
    queryLabel: string
    queryHint: string
    idColumnHint: string
  }
  requiresDriver?: string
  notes: string
}

export const DATA_SOURCE_KIND_INFO: Record<DataSourceKind, DataSourceKindInfo> = {
  postgres: {
    kind: 'postgres',
    label: 'PostgreSQL',
    connectionSummary: 'Read-only SQL over a PostgreSQL connection string',
    secretFields: [{ key: 'connectionString', label: 'Connection string', placeholder: 'postgresql://user:password@host:5432/dbname', required: true }],
    configHints: {
      queryLabel: 'Read-only SQL query',
      queryHint: 'SELECT id, title, body FROM articles',
      idColumnHint: 'id',
    },
    requiresDriver: 'pg',
    notes: 'Only SELECT / WITH queries are permitted and the result set is capped. TLS is negotiated by the server (ssl=require in the connection string).',
  },
  mysql: {
    kind: 'mysql',
    label: 'MySQL / MariaDB',
    connectionSummary: 'Read-only SQL over a MySQL/MariaDB connection',
    secretFields: [{ key: 'connectionString', label: 'Connection URL', placeholder: 'mysql://user:password@host:3306/dbname', required: true }],
    configHints: {
      queryLabel: 'Read-only SQL query',
      queryHint: 'SELECT id, title, body FROM products',
      idColumnHint: 'id',
    },
    requiresDriver: 'mysql2',
    notes: 'Only SELECT / WITH queries are permitted and the result set is capped.',
  },
  sqlite: {
    kind: 'sqlite',
    label: 'SQLite file',
    connectionSummary: 'Read-only access to a SQLite database file on this server',
    secretFields: [{ key: 'path', label: 'Absolute path to the .db file', placeholder: '/data/reports.db', required: true }],
    configHints: {
      queryLabel: 'Read-only SQL query',
      queryHint: 'SELECT id, title, body FROM notes',
      idColumnHint: 'id',
    },
    notes: 'The file is opened in read-only mode via the Node.js built-in node:sqlite driver — no extra dependency.',
  },
  http_json: {
    kind: 'http_json',
    label: 'JSON HTTP endpoint (REST API)',
    connectionSummary: 'Fetches a JSON array (or an array under a given path) over HTTPS',
    secretFields: [
      { key: 'url', label: 'Endpoint URL', placeholder: 'https://api.example.com/v1/articles', required: true },
      { key: 'authHeader', label: 'Authorization header value (optional)', placeholder: 'Bearer sk-…', required: false },
    ],
    configHints: {
      queryLabel: 'Items path within the JSON response (optional)',
      queryHint: 'data.items  (leave blank if the response is already an array)',
      idColumnHint: 'id',
    },
    notes: 'Private/loopback addresses are blocked unless you explicitly allow them. Retrieved text is treated as untrusted content and never as instructions.',
  },
}

/** Inbound config (non-secret) — validated at the API boundary. */
export const dataSourceConfigSchema = z.object({
  query: z.string().max(20_000).optional(),
  table: z.string().max(200).optional(),
  itemsPath: z.string().max(300).optional(),
  idColumn: z.string().max(120).optional(),
  titleColumn: z.string().max(120).optional(),
  textColumns: z.array(z.string().min(1).max(120)).max(60).optional(),
  template: z.string().max(2_000).optional(),
  contentPrefix: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(5_000).optional(),
  approved: z.boolean().optional(),
  allowPrivate: z.boolean().optional(),
})

export type DataSourceConfig = z.infer<typeof dataSourceConfigSchema>

/** Per-kind connection schema (secrets) — validated before encryption. */
export const connectionSchemaFor: Record<DataSourceKind, z.ZodTypeAny> = {
  postgres: z.object({ connectionString: z.string().min(10, 'connectionString is required') }),
  mysql: z.object({ connectionString: z.string().min(10, 'connectionString is required') }),
  sqlite: z.object({ path: z.string().min(1, 'path is required') }),
  http_json: z.object({ url: z.string().url('url must be a valid http(s) URL'), authHeader: z.string().max(2_000).optional() }),
}

export const DEFAULT_LIMIT = 1_000
export const HARD_LIMIT = 5_000

/** Wire shape — config is parsed, credentials represented ONLY by `configured`. */
export function publicDataSource(row: {
  id: string
  name: string
  kind: string
  configJson: string
  connectionEnc: string
  enabled: boolean
  autoSync: boolean
  syncIntervalMin: number
  lastTestAt: Date | null
  lastTestOk: boolean
  lastTestError: string
  lastSyncAt: Date | null
  lastSyncOk: boolean
  lastSyncError: string
  lastSyncStats: string
  documentCount: number
  chunkCount: number
  createdAt: Date
}) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    config: (() => { try { return JSON.parse(row.configJson || '{}') } catch { return {} } })(),
    configured: Boolean(row.connectionEnc),
    enabled: row.enabled,
    autoSync: row.autoSync,
    syncIntervalMin: row.syncIntervalMin,
    lastTestAt: row.lastTestAt ? row.lastTestAt.toISOString() : null,
    lastTestOk: row.lastTestOk,
    lastTestError: row.lastTestError,
    lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
    lastSyncOk: row.lastSyncOk,
    lastSyncError: row.lastSyncError,
    lastSyncStats: (() => { try { return JSON.parse(row.lastSyncStats || '{}') } catch { return {} } })(),
    documentCount: row.documentCount,
    chunkCount: row.chunkCount,
    createdAt: row.createdAt.toISOString(),
  }
}
