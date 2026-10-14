import { withAuth, json } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'

/** POST /api/setup/complete — mark onboarding as complete (owner/admin). */
export const POST = withAuth(
  async (req, ctx) => {
    const org = await db.organization.update({
      where: { id: ctx.org.id },
      data: { setupComplete: true },
    })

    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'setup.completed',
      entity: 'organization',
      entityId: org.id,
      meta: { setupComplete: true },
    })

    return json({ ok: true, setupComplete: org.setupComplete })
  },
  { roles: ['owner', 'admin'] }
)
