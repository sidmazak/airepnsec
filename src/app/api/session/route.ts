import { withPublic, json, getCtx } from '@/lib/api'
import { db } from '@/lib/db'

/**
 * GET /api/session
 * Bootstrapping endpoint for the single-page app.
 * - No users at all            → { needsSetup: true }
 * - Valid session cookie       → { authenticated: true, user, org, demoAvailable }
 * - Users exist, no session    → { authenticated: false, needsSetup: false, demoAvailable }
 * demoAvailable = a demo organization exists (its credentials are only
 * revealed by POST /api/demo/seed; hashes are never exposed here).
 */
export const GET = withPublic(async (req) => {
  const userCount = await db.user.count()
  if (userCount === 0) return json({ needsSetup: true })

  const demoAvailable = Boolean(await db.organization.findUnique({ where: { slug: 'demo' } }))

  const ctx = await getCtx(req)
  if (!ctx) return json({ authenticated: false, needsSetup: false, demoAvailable })

  return json({
    authenticated: true,
    user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email, role: ctx.user.role },
    org: {
      id: ctx.org.id,
      name: ctx.org.name,
      slug: ctx.org.slug,
      demo: ctx.org.demo,
      setupComplete: ctx.org.setupComplete,
      dataMode: ctx.org.dataMode,
      timezone: ctx.org.timezone,
      currency: ctx.org.currency,
      businessType: ctx.org.businessType,
    },
    demoAvailable,
  })
})
