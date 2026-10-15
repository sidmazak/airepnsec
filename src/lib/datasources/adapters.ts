import { DEFAULT_LIMIT, HARD_LIMIT, type DataSourceConfig, type DataSourceKind } from './registry'

/**
 * Data-source adapters. Each kind is normalized to a raw row array so the sync
 * layer can map columns -> documents without knowing the vendor.
 *
 * Safety:
 *  - SQL is restricted to a single read-only SELECT / WITH statement (no DDL/DML,
 *    no stacked statements). The result set is always capped.
 *  - http_json blocks private/loopback/link-local addresses unless the admin
 *    explicitly set allowPrivate (SSRF protection). Both the literal hostname
 *    and every DNS-resolved address are checked.
 *  - Secrets/connection strings are passed in already decrypted and are never logged.
 */

export type RawFetchResult = {
  rows: Array<Record<string, unknown>>
  columns: string[]
}

export type AdapterTestResult = {
  ok: boolean
  message: string
  latencyMs: number
  rowCount?: number
  columns?: string[]
  preview?: Array<Record<string, unknown>>
}

export type Connection = Record<string, unknown>

/* ---------------- SQL safety ---------------- */

export function assertReadOnlySql(query: string): string {
  const q = query.trim().replace(/;\s*$/, '')
  if (!q) throw new Error('A SQL query is required')
  if (q.includes(';')) throw new Error('Only a single SQL statement is allowed (no ";")')
  const lower = q.toLowerCase()
  if (!(lower.startsWith('select') || lower.startsWith('with'))) {
    throw new Error('Only read-only SELECT / WITH queries are allowed')
  }
  // Reject obvious write/DDL keywords appearing as a word. Includes statement
  // forms that can mutate or exfiltrate even when they start with SELECT/WITH:
  // SELECT ... INTO OUTFILE (MySQL), SELECT ... INTO (SQL Server), COPY,
  // CALL/DO/EXECUTE (stored procedures), LOAD/LOAD_FILE/LOAD DATA,
  // PRAGMA/ATTACH (SQLite), plus DDL/DML.
  if (
    /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|attach|detach|pragma|vacuum|replace|merge|into|copy|call|do|exec|execute|load|outfile|dumpfile|load_file|load_extension|reindex)\b/.test(
      lower
    )
  ) {
    throw new Error('The query contains a write operation — only read-only SELECT queries are allowed')
  }
  return q
}

export function buildSql(config: DataSourceConfig, limit: number): string {
  const raw = config.query?.trim()
    || (config.table ? `SELECT * FROM ${assertSafeTable(config.table)}` : '')
  if (!raw) throw new Error('Provide either a SQL query or a table name')
  const safe = assertReadOnlySql(raw)
  const capped = Math.min(Math.max(1, Math.floor(limit)), HARD_LIMIT)
  // Wrap in a subquery so an existing LIMIT/OFFSET cannot be bypassed and we always cap rows.
  return `SELECT * FROM (\n${safe}\n) AS ais_sub LIMIT ${capped}`
}

function assertSafeTable(table: string): string {
  const t = table.trim()
  if (!/^[A-Za-z0-9_."`\[\]]+$/.test(t)) throw new Error('Invalid table name')
  return t
}

/* ---------------- SSRF guard for http_json ---------------- */

function isPrivateIp(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  if (h.startsWith('fc') || h.startsWith('fd')) return true // unique local IPv6
  if (h.startsWith('fe80')) return true // link-local IPv6
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 10) return true
    if (a === 127) return true
    if (a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
  }
  return false
}

async function assertUrlAllowed(raw: string, allowPrivate: boolean): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('url is not a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed')
  }
  if (!allowPrivate) {
    // Guard 1: literal hostname (fast path, catches bracketed/numeric hosts).
    if (isPrivateIp(url.hostname)) {
      throw new Error('This URL points to a private/local address. Enable "allow private addresses" if this is intentional (SSRF protection).')
    }
    // Guard 2: resolve the hostname and reject if ANY resolved address is private.
    // Defends against DNS records that point at internal ranges. (A determined
    // attacker could still rebind DNS between this check and the fetch; this
    // closes the common case and is documented as a known limitation.)
    let addresses: Array<{ address: string }> = []
    try {
      const dns = await import('node:dns/promises')
      addresses = await dns.lookup(url.hostname, { all: true })
    } catch {
      throw new Error('Could not resolve the endpoint hostname (DNS lookup failed)')
    }
    if (addresses.some((a) => isPrivateIp(a.address))) {
      throw new Error('This URL resolves to a private/local address. Enable "allow private addresses" if this is intentional (SSRF protection).')
    }
  }
  return url
}

function getByPath(data: unknown, path: string | undefined): unknown {
  if (!path || !path.trim()) return data
  let cur: unknown = data
  for (const seg of path.split('.').map((s) => s.trim()).filter(Boolean)) {
    if (cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg]
    } else {
      return undefined
    }
  }
  return cur
}

/* ---------------- per-kind fetchers ---------------- */

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function fetchSqlite(connection: Connection, sql: string): Promise<RawFetchResult> {
  const filePath = String(connection.path ?? '')
  if (!filePath) throw new Error('SQLite file path is required')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(filePath, { readOnly: true })
  try {
    const stmt = db.prepare(sql)
    const rows = stmt.all() as Array<Record<string, unknown>>
    const columns = rows.length > 0 ? Object.keys(rows[0]) : []
    return { rows, columns }
  } finally {
    db.close()
  }
}

async function fetchPostgres(connection: Connection, sql: string): Promise<RawFetchResult> {
  const connectionString = String(connection.connectionString ?? '')
  if (!connectionString) throw new Error('PostgreSQL connection string is required')
  const pg = await import('pg')
  const Client = pg.Client ?? (pg as unknown as { default: typeof pg }).default?.Client
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000, statement_timeout: 20_000 })
  await client.connect()
  try {
    const res = await client.query(sql)
    const columns = res.fields?.map((f) => f.name) ?? (res.rows[0] ? Object.keys(res.rows[0]) : [])
    return { rows: res.rows as Array<Record<string, unknown>>, columns }
  } finally {
    await client.end().catch(() => {})
  }
}

async function fetchMysql(connection: Connection, sql: string): Promise<RawFetchResult> {
  const connectionString = String(connection.connectionString ?? '')
  if (!connectionString) throw new Error('MySQL connection URL is required')
  const mysql = await import('mysql2/promise')
  const conn = await mysql.createConnection(connectionString)
  try {
    const [rows, fields] = await conn.query(sql)
    const arr = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []
    const columns = (fields as Array<{ name?: string }> | undefined)?.map((f) => f.name ?? '').filter(Boolean)
      ?? (arr[0] ? Object.keys(arr[0]) : [])
    return { rows: arr, columns }
  } finally {
    await conn.end().catch(() => {})
  }
}

async function fetchHttpJson(connection: Connection, config: DataSourceConfig, limit: number): Promise<RawFetchResult> {
  const rawUrl = String(connection.url ?? '')
  if (!rawUrl) throw new Error('Endpoint URL is required')
  const url = await assertUrlAllowed(rawUrl, Boolean(config.allowPrivate))
  const authHeader = String(connection.authHeader ?? '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(authHeader ? { authorization: authHeader } : {}),
      },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`Endpoint returned HTTP ${res.status}`)
    const data = await res.json().catch(() => { throw new Error('Response was not valid JSON') })
    const items = getByPath(data, config.itemsPath)
    if (!Array.isArray(items)) {
      throw new Error('Response did not contain a JSON array' + (config.itemsPath ? ` at path "${config.itemsPath}"` : ''))
    }
    const rows = (items as Array<unknown>)
      .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object' && !Array.isArray(r))
      .slice(0, Math.min(limit, HARD_LIMIT))
    const columns = rows[0] ? Object.keys(rows[0]) : []
    return { rows, columns }
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchRawRows(
  kind: DataSourceKind,
  connection: Connection,
  config: DataSourceConfig,
  limit = DEFAULT_LIMIT
): Promise<RawFetchResult> {
  switch (kind) {
    case 'sqlite':
      return withTimeout(fetchSqlite(connection, buildSql(config, limit)), 25_000, 'SQLite query')
    case 'postgres':
      return withTimeout(fetchPostgres(connection, buildSql(config, limit)), 25_000, 'PostgreSQL query')
    case 'mysql':
      return withTimeout(fetchMysql(connection, buildSql(config, limit)), 25_000, 'MySQL query')
    case 'http_json':
      return withTimeout(fetchHttpJson(connection, config, limit), 25_000, 'HTTP fetch')
    default:
      throw new Error(`Unsupported data source kind: ${kind}`)
  }
}

/** Connect + run the configured query (capped) and return a preview. Never logs secrets. */
export async function testDataSource(
  kind: DataSourceKind,
  connection: Connection,
  config: DataSourceConfig
): Promise<AdapterTestResult> {
  const started = Date.now()
  try {
    const { rows, columns } = await fetchRawRows(kind, connection, config, config.limit ?? DEFAULT_LIMIT)
    return {
      ok: true,
      message: `Connected and read ${rows.length} row${rows.length === 1 ? '' : 's'} — ${columns.length} column${columns.length === 1 ? '' : 's'} detected.`,
      latencyMs: Date.now() - started,
      rowCount: rows.length,
      columns,
      preview: rows.slice(0, 3),
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Connection failed', latencyMs: Date.now() - started }
  }
}
