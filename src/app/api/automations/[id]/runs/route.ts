import { withAuth, json, fail } from '@/lib/api'
import { db } from '@/lib/db'

/** GET /api/automations/[id]/runs — run history for one automation (latest 100). */
export const GET = withAuth(async (req, ctx, params) => {
  const automation = await db.automation.findFirst({
    where: { id: params.id, orgId: ctx.org.id },
    select: { id: true },
  })
  if (!automation) return fail(404, 'Automation not found', { code: 'not_found' })

  const runs = await db.automationRun.findMany({
    where: { automationId: automation.id },
    orderBy: { scheduledFor: 'desc' },
    take: 100,
  })

  return json({ runs })
})
