import { db } from '@/lib/db'

/**
 * Runtime SQLite tuning for concurrent traffic (parallel calls, SMS bursts).
 *
 * WAL lets readers proceed while a writer commits; `busy_timeout` makes contending
 * writers wait instead of failing immediately with SQLITE_BUSY; `synchronous=NORMAL`
 * is the standard WAL durability/throughput tradeoff (a crash can lose the last
 * transaction, never corrupt the database).
 *
 * Postgres deployments are untouched. Applied once at boot.
 */

export type DbTuning = {
  kind: 'sqlite' | 'postgres' | 'other'
  journalMode: string
  busyTimeoutMs: number | null
}

// Stored on globalThis because instrumentation.ts and route handlers may be
// bundled separately (dev), so a module-level variable is not shared.
const globalStore = globalThis as unknown as { __aisDbTuning?: DbTuning }
let cached: DbTuning | null = globalStore.__aisDbTuning ?? null

function remember(tuning: DbTuning): DbTuning {
  cached = tuning
  globalStore.__aisDbTuning = tuning
  return tuning
}

function detectKind(url: string): DbTuning['kind'] {
  if (url.startsWith('file:')) return 'sqlite'
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return 'postgres'
  return 'other'
}

export async function tuneDatabase(): Promise<DbTuning> {
  if (cached) return cached
  const url = process.env.DATABASE_URL ?? ''
  const kind = detectKind(url)

  if (kind !== 'sqlite') {
    return remember({ kind, journalMode: 'n/a', busyTimeoutMs: null })
  }

  let journalMode = 'unknown'
  let busyTimeoutMs: number | null = null

  try {
    const rows = (await db.$queryRawUnsafe('PRAGMA journal_mode=WAL')) as Array<Record<string, unknown>>
    const value = rows?.[0]?.journal_mode
    if (typeof value === 'string') journalMode = value.toLowerCase()
  } catch (err) {
    console.error('[db] could not enable WAL:', err instanceof Error ? err.message : err)
  }

  try {
    await db.$queryRawUnsafe('PRAGMA busy_timeout=5000')
    busyTimeoutMs = 5000
  } catch (err) {
    console.error('[db] could not set busy_timeout:', err instanceof Error ? err.message : err)
  }

  try {
    await db.$queryRawUnsafe('PRAGMA synchronous=NORMAL')
  } catch {
    // Non-fatal: WAL + busy_timeout are the important parts.
  }

  return remember({ kind, journalMode, busyTimeoutMs })
}

/** Live view for diagnostics; reads the connection if tuning did not run in this bundle. */
export async function getDbTuning(): Promise<DbTuning | null> {
  if (cached) return cached
  const kind = detectKind(process.env.DATABASE_URL ?? '')
  if (kind !== 'sqlite') return remember({ kind, journalMode: 'n/a', busyTimeoutMs: null })
  try {
    const j = (await db.$queryRawUnsafe('PRAGMA journal_mode')) as Array<Record<string, unknown>>
    const b = (await db.$queryRawUnsafe('PRAGMA busy_timeout')) as Array<Record<string, unknown>>
    const journalMode = typeof j?.[0]?.journal_mode === 'string' ? String(j[0].journal_mode).toLowerCase() : 'unknown'
    const busy = Number(b?.[0]?.timeout ?? b?.[0]?.busy_timeout ?? 0)
    return remember({ kind, journalMode, busyTimeoutMs: Number.isFinite(busy) ? busy : null })
  } catch {
    return null
  }
}
