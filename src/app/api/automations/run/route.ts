import { withAuth, json } from '@/lib/api'
import { audit } from '@/lib/audit'
import { tick } from '@/lib/automation/engine'

/**
 * POST /api/automations/run — manual tick for this org (worker also ticks every 60s).
 * Returns honest stats: {evaluated, executed, failed, skipped}.
 */
export const POST = withAuth(async (req, ctx) => {
  const stats = await tick(ctx.org.id)

  await audit({
    orgId: ctx.org.id,
    actorType: 'user',
    actorId: ctx.user.id,
    action: 'automation.tick_manual',
    entity: 'automation',
    meta: { ...stats },
  })

  return json(stats)
}, { roles: ['owner', 'admin'] })
