import { withPublic, json, fail, rateLimit } from '@/lib/api'
import { seedDemo } from '@/lib/demo/seed'

/**
 * POST /api/demo/seed — public, rate-limited, idempotent.
 * Seeds a full demo organization (takes a few seconds) and returns its
 * login credentials so evaluators can try the product immediately.
 */
export const POST = withPublic(async (req) => {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local'
  if (!rateLimit(`demo-seed:${ip}`, 4, 60_000)) {
    return fail(429, 'Demo seeding is rate limited. Please wait a moment and try again.')
  }

  const result = await seedDemo()
  return json(result, 201)
})
