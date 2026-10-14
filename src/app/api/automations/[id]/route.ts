import { z } from 'zod'
import { withAuth, json, fail, parseBody } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'

const conditionSchema = z.object({
  field: z.string().min(1).max(100),
  op: z.enum(['eq', 'neq', 'gt', 'lt', 'contains']),
  value: z.union([z.string().max(500), z.number()]),
})

const actionSchema = z.object({
  type: z.enum(['send_invoice_reminder', 'notify_inapp', 'flag_for_review']),
  cfg: z.record(z.string(), z.unknown()).optional(),
})

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  triggerType: z.enum(['invoice_overdue', 'booking_created', 'conversation_escalated', 'manual']).optional(),
  triggerCfg: z.record(z.string(), z.unknown()).optional(),
  conditions: z.array(conditionSchema).max(20).optional(),
  delayMinutes: z.number().int().min(0).max(60 * 24 * 30).optional(),
  actions: z.array(actionSchema).min(1).max(20).optional(),
  maxRunsPerDay: z.number().int().min(1).max(500).optional(),
  quietHours: z.object({ start: z.string().max(5).optional(), end: z.string().max(5).optional() }).optional(),
  testMode: z.boolean().optional(),
  enabled: z.boolean().optional(),
})

/** PATCH /api/automations/[id] (owner/admin) — partial update; only provided fields change. */
export const PATCH = withAuth(
  async (req, ctx, params) => {
    const body = await parseBody(req, patchSchema)

    const automation = await db.automation.findFirst({ where: { id: params.id, orgId: ctx.org.id } })
    if (!automation) return fail(404, 'Automation not found', { code: 'not_found' })

    const updated = await db.automation.update({
      where: { id: automation.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.triggerType !== undefined ? { triggerType: body.triggerType } : {}),
        ...(body.triggerCfg !== undefined ? { triggerCfg: JSON.stringify(body.triggerCfg) } : {}),
        ...(body.conditions !== undefined ? { conditions: JSON.stringify(body.conditions) } : {}),
        ...(body.delayMinutes !== undefined ? { delayMinutes: body.delayMinutes } : {}),
        ...(body.actions !== undefined
          ? { actions: JSON.stringify(body.actions.map((a) => ({ type: a.type, cfg: a.cfg ?? {} }))) }
          : {}),
        ...(body.maxRunsPerDay !== undefined ? { maxRunsPerDay: body.maxRunsPerDay } : {}),
        ...(body.quietHours !== undefined ? { quietHours: JSON.stringify(body.quietHours) } : {}),
        ...(body.testMode !== undefined ? { testMode: body.testMode } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      },
    })

    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'automation.updated',
      entity: 'automation',
      entityId: automation.id,
      meta: {
        name: updated.name,
        enabled: updated.enabled,
        testMode: updated.testMode,
        changed: Object.keys(body),
      },
    })

    return json({ automation: updated })
  },
  { roles: ['owner', 'admin'] }
)

/** DELETE /api/automations/[id] (owner/admin) — runs cascade-delete with the automation. */
export const DELETE = withAuth(
  async (req, ctx, params) => {
    const automation = await db.automation.findFirst({ where: { id: params.id, orgId: ctx.org.id } })
    if (!automation) return fail(404, 'Automation not found', { code: 'not_found' })

    await db.automation.delete({ where: { id: automation.id } })

    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'automation.deleted',
      entity: 'automation',
      entityId: automation.id,
      meta: { name: automation.name },
    })

    return json({ ok: true })
  },
  { roles: ['owner', 'admin'] }
)
