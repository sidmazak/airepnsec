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
}
