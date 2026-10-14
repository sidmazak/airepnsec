import { withPublic, json } from '@/lib/api'

/** GET /api/health — PUBLIC liveness probe. No data, no auth. */
export const GET = withPublic(async () => {
  return json({ ok: true, time: new Date().toISOString() })
})
