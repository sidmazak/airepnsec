import { withAuth, json, fail } from '@/lib/api'
import { audit } from '@/lib/audit'
import { tick } from '@/lib/automation/engine'
import { runWithWorkerLease } from '@/lib/concurrency'

/**
 * POST /api/automations/run — manual tick for this org (worker also ticks every 60s).
 * Returns honest stats: {evaluated, executed, failed, skipped}. The worker lease
 * prevents a manual click from racing the scheduled tick (or another instance).
 */
export const POST = withAuth(async (req, ctx) => {
  const outcome = await runWithWorkerLease('automation', () => tick(ctx.org.id))
  if (!outcome.ran) {
    return fail(409, 'The automation worker is already running. Try again in a moment.', { code: 'worker_busy' })
  }
  const stats = outcome.result

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
