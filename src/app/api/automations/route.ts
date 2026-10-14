import { z } from 'zod'
import { withAuth, json, parseBody } from '@/lib/api'
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

const TRIGGERS = ['invoice_overdue', 'booking_created', 'conversation_escalated', 'manual'] as const

const createSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z.string().max(2000).optional(),
  triggerType: z.enum(TRIGGERS),
  triggerCfg: z.record(z.string(), z.unknown()).optional(),
  conditions: z.array(conditionSchema).max(20).optional(),
  delayMinutes: z.number().int().min(0).max(60 * 24 * 30).optional(),
  actions: z.array(actionSchema).min(1, 'At least one action is required').max(20),
  maxRunsPerDay: z.number().int().min(1).max(500).optional(),
  quietHours: z.object({ start: z.string().max(5).optional(), end: z.string().max(5).optional() }).optional(),
  testMode: z.boolean().optional(),
  enabled: z.boolean().optional(),
})

/** GET /api/automations — all automations with their last 5 runs. */
export const GET = withAuth(async (req, ctx) => {
  const automations = await db.automation.findMany({
    where: { orgId: ctx.org.id },
    orderBy: { createdAt: 'desc' },
  })

  const withRuns = await Promise.all(
    automations.map(async (a) => {
      const runs = await db.automationRun.findMany({
        where: { automationId: a.id },
        orderBy: { scheduledFor: 'desc' },
        take: 5,
      })
      return { ...a, runs }
    })
  )

  return json({ automations: withRuns })
})

/** POST /api/automations (owner/admin) — create an automation. */
export const POST = withAuth(
  async (req, ctx) => {
    const body = await parseBody(req, createSchema)

    const automation = await db.automation.create({
      data: {
        orgId: ctx.org.id,
        name: body.name,
        description: body.description ?? '',
        triggerType: body.triggerType,
        triggerCfg: JSON.stringify(body.triggerCfg ?? {}),
        conditions: JSON.stringify(body.conditions ?? []),
        delayMinutes: body.delayMinutes ?? 0,
        actions: JSON.stringify(body.actions.map((a) => ({ type: a.type, cfg: a.cfg ?? {} }))),
        maxRunsPerDay: body.maxRunsPerDay ?? 20,
        quietHours: JSON.stringify(body.quietHours ?? {}),
        testMode: body.testMode ?? true,
        enabled: body.enabled ?? false,
      },
    })

    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'automation.created',
      entity: 'automation',
      entityId: automation.id,
      meta: { name: automation.name, triggerType: automation.triggerType, enabled: automation.enabled, testMode: automation.testMode },
    })

    return json({ automation }, 201)
  },
  { roles: ['owner', 'admin'] }
)
