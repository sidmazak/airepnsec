/**
 * Background workers (in-process). Registered once per Next.js server via the
 * instrumentation hook.
 *
 * Production topology:
 * - Every worker is single-flight across app instances via a database lease, so
 *   scaling the web tier never double-sends an outbox message or double-fires an
 *   automation.
 * - Set `AIS_DISABLE_WORKERS=1` on a web-only instance and run a dedicated worker
 *   instance instead. Individual workers can be toggled with
 *   `AIS_WORKER_AUTOMATION`, `AIS_WORKER_OUTBOX`, `AIS_WORKER_DATASOURCES`.
 * - Lease state and last-run/error are surfaced by GET /api/health/detail.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const globalKey = globalThis as unknown as { __aisWorkerStarted?: boolean }
  if (globalKey.__aisWorkerStarted) return
  globalKey.__aisWorkerStarted = true

  const { runWithWorkerLease, isWorkerEnabled } = await import('@/lib/concurrency')

  // SQLite tuning must happen before concurrent requests hit the database.
  try {
    const { tuneDatabase } = await import('@/lib/db-tuning')
    const tuning = await tuneDatabase()
    if (tuning.kind === 'sqlite') {
      console.log(`[db] sqlite journal_mode=${tuning.journalMode} busy_timeout=${tuning.busyTimeoutMs ?? 0}ms`)
    }
  } catch (err) {
    console.error('[db] tuning failed:', err instanceof Error ? err.message : err)
  }

  // Schedule a worker without permitting overlapping invocations inside this
  // process. The DB lease still protects across instances; this guard avoids
  // piling up lease attempts when a slow tick exceeds its interval.
  const schedule = (label: string, initialDelayMs: number, intervalMs: number, task: () => Promise<void>) => {
    let inFlight = false
    const run = async () => {
      if (inFlight) return
      inFlight = true
      try {
        await task()
      } catch (err) {
        console.error(`[worker] ${label} failed:`, err instanceof Error ? err.message : err)
      } finally {
        inFlight = false
      }
    }
    setTimeout(run, initialDelayMs)
    setInterval(run, intervalMs)
  }

  // Automation engine: an initial tick shortly after boot, then every 60s.
  if (isWorkerEnabled('automation')) {
    const { tick } = await import('@/lib/automation/engine')
    schedule('automation tick', 5_000, 60_000, async () => {
      const outcome = await runWithWorkerLease('automation', () => tick())
      if (!outcome.ran) return
    })
    console.log('[worker] automation worker started (60s interval, lease-protected)')
  } else {
    console.log('[worker] automation worker disabled by environment')
  }

  // Outbox dispatcher: delivers queued messages through configured integrations
  // (SMTP / Twilio / SMS gateways / outbound webhooks). 10s after boot, then 30s.
  if (isWorkerEnabled('outbox')) {
    const { dispatchOutbox } = await import('@/lib/integrations/dispatcher')
    schedule('outbox dispatch', 10_000, 30_000, async () => {
      await runWithWorkerLease('outbox', () => dispatchOutbox())
    })
    console.log('[worker] outbox dispatcher started (30s interval, lease-protected)')
  } else {
    console.log('[worker] outbox dispatcher disabled by environment')
  }

  // External data-source auto-sync: re-pulls enabled sources whose interval is due.
  // Checked every 5 minutes (per-source interval is honored inside).
  if (isWorkerEnabled('datasources')) {
    const { runDueDataSourceSyncs } = await import('@/lib/datasources/sync')
    schedule('data-source auto-sync', 90_000, 5 * 60_000, async () => {
      const outcome = await runWithWorkerLease('datasources', () => runDueDataSourceSyncs())
      if (!outcome.ran) return
      const { ran, failed } = outcome.result
      if (ran || failed) console.log(`[worker] data-source auto-sync: ${ran} synced, ${failed} failed`)
    })
    console.log('[worker] data-source sync started (5m interval, lease-protected)')
  } else {
    console.log('[worker] data-source sync disabled by environment')
  }

  // Scheduled database backups: checked hourly, a snapshot is taken once a day at
  // the configured hour and old snapshots are pruned by the retention policy.
  if (isWorkerEnabled('backups')) {
    const { runBackupScheduler } = await import('@/lib/backup')
    schedule('backup scheduler', 45_000, 60 * 60_000, async () => {
      const outcome = await runWithWorkerLease('backups', () => runBackupScheduler())
      if (!outcome.ran) return
      if (outcome.result.length) {
        console.log(`[worker] backups: ${outcome.result.length} snapshot(s) created`)
      }
    })
    console.log('[worker] backup scheduler started (hourly interval, lease-protected)')
  } else {
    console.log('[worker] backup scheduler disabled by environment')
  }

  // Pre-load the local embedding model so the first knowledge search / AI answer is fast.
  // Fire-and-forget: a failed load is logged and search degrades to lexical scoring.
  void (async () => {
    try {
      const { warmEmbeddingModel } = await import('@/lib/ai/embeddings')
      const ok = await warmEmbeddingModel()
      console.log(ok ? '[ai] local embedding model ready' : '[ai] local embedding model FAILED to load — search will fall back to lexical scoring')
    } catch (err) {
      console.error('[ai] embedding warmup error:', err instanceof Error ? err.message : err)
    }
  })()
}
