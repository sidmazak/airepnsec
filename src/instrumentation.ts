/**
 * Background worker (in-process). Runs the automation tick every 60 seconds.
 * Registered once per Next.js server via instrumentation hook.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const globalKey = globalThis as unknown as { __aisWorkerStarted?: boolean }
  if (globalKey.__aisWorkerStarted) return
  globalKey.__aisWorkerStarted = true

  const { tick } = await import('@/lib/automation/engine')

  const run = async () => {
    try {
      await tick()
    } catch (err) {
      console.error('[worker] automation tick failed:', err instanceof Error ? err.message : err)
    }
  }

  // initial tick shortly after boot, then every 60s
  setTimeout(run, 5_000)
  setInterval(run, 60_000)
  console.log('[worker] automation worker started (60s interval)')

  // Outbox dispatcher: delivers queued messages through configured integrations
  // (SMTP / Twilio / outbound webhooks). 10s after boot, then every 30s.
  const { dispatchOutbox } = await import('@/lib/integrations/dispatcher')
  const dispatch = async () => {
    try {
      await dispatchOutbox()
    } catch (err) {
      console.error('[worker] outbox dispatch failed:', err instanceof Error ? err.message : err)
    }
  }
  setTimeout(dispatch, 10_000)
  setInterval(dispatch, 30_000)
  console.log('[worker] outbox dispatcher started (30s interval)')

  // External data-source auto-sync: re-pulls enabled sources whose interval is due.
  // 90s after boot, then every 5 minutes (per-source interval is honored inside).
  const { runDueDataSourceSyncs } = await import('@/lib/datasources/sync')
  const dataSync = async () => {
    try {
      const { ran, failed } = await runDueDataSourceSyncs()
      if (ran || failed) console.log(`[worker] data-source auto-sync: ${ran} synced, ${failed} failed`)
    } catch (err) {
      console.error('[worker] data-source auto-sync failed:', err instanceof Error ? err.message : err)
    }
  }
  setTimeout(dataSync, 90_000)
  setInterval(dataSync, 5 * 60_000)

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
