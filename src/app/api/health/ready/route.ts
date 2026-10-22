import { withPublic, json } from '@/lib/api'
import { db } from '@/lib/db'

/**
 * GET /api/health/ready — PUBLIC readiness probe.
 *
 * Unlike `/api/health` (process liveness), this performs a real database
 * round-trip and returns 503 when the app cannot serve data. Container
 * orchestration/reverse proxies should use this for readiness checks so a
 * broken DB never receives traffic or reports healthy.
 */
export const GET = withPublic(async () => {
  const started = Date.now()
  try {
    await db.$queryRaw`SELECT 1`
    return json({ ok: true, db: 'ok', latencyMs: Date.now() - started, time: new Date().toISOString() })
  } catch {
    return json({ ok: false, db: 'unreachable', time: new Date().toISOString() }, 503)
  }
}, { rateLimit: { limit: 300 } })
