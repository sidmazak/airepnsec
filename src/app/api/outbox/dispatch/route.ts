import { withAuth, json } from '@/lib/api'
import { dispatchOutbox, nudgeChannel } from '@/lib/integrations/dispatcher'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'

/**
 * POST /api/outbox/dispatch (owner/admin) — run the outbox dispatcher NOW for
 * this org and return honest stats. Operational button for "flush the outbox"
 * after configuring/fixing a channel; the 30s worker still does the routine work.
 * A nudge first releases messages whose recheck backoff predates a channel fix.
 */
export const POST = withAuth(
  async (req, ctx) => {
    // Release backoff for every channel this org has an enabled integration for.
    const enabled = await db.integration.findMany({ where: { orgId: ctx.org.id, enabled: true }, select: { kind: true } })
    for (const { kind } of enabled) {
      await nudgeChannel(ctx.org.id, kind)
    }

    const stats = await dispatchOutbox()

    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'outbox.dispatched',
      entity: 'outbox',
      meta: { ...stats, enabledKinds: enabled.map((e) => e.kind) },
    })

    return json({ ok: true, stats })
  },
  { roles: ['owner', 'admin'] }
)
