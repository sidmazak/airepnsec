import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { queueInvoiceReminder, inQuietHours } from '@/lib/business/collections'
import { invoiceOutstanding } from '@/lib/business/invoice'
import { parseJson, getSetting, setSetting } from '@/lib/org'
import { outboxCountFor } from '@/lib/automation/actions'

export type TriggerType = 'invoice_overdue' | 'booking_created' | 'conversation_escalated' | 'manual'

export type Condition = { field: string; op: 'eq' | 'neq' | 'gt' | 'lt' | 'contains'; value: string | number }
export type ActionDef = { type: 'send_invoice_reminder' | 'notify_inapp' | 'flag_for_review'; cfg: Record<string, unknown> }

/**
 * Native, persistent automation engine.
 * - `tick()` is invoked by the worker interval (instrumentation) and by POST /api/automations/run.
 * - Trigger evaluation is idempotent via dedupe keys on AutomationRun.
 * - Failed runs retry with backoff (5m, 30m), up to 3 attempts.
 * - testMode=true executions evaluate everything and log what WOULD happen without side effects.
 */
export async function tick(orgId?: string): Promise<{ evaluated: number; executed: number; failed: number; skipped: number }> {
  const stats = { evaluated: 0, executed: 0, failed: 0, skipped: 0 }

  const orgs = orgId ? [{ id: orgId }] : await db.organization.findMany({ select: { id: true }, where: { setupComplete: true } })

  for (const { id: oid } of orgs) {
    const automations = await db.automation.findMany({ where: { orgId: oid, enabled: true } })

    for (const automation of automations) {
      // 1) trigger evaluation → create scheduled runs (deduped)
      const created = await evaluateTrigger(automation)
      stats.evaluated += created

      // 2) process due runs
      const due = await db.automationRun.findMany({
        where: { automationId: automation.id, status: 'running', scheduledFor: { lte: new Date() } },
        take: 10,
      })
      for (const run of due) {
        try {
          const outcome = await executeRun(automation, run)
          if (outcome === 'executed') stats.executed++
          else stats.skipped++
        } catch (err) {
          const message = err instanceof Error ? err.message : 'unknown error'
          if (run.attempt < 3) {
            const backoffMin = run.attempt === 1 ? 5 : 30
            await db.automationRun.create({
              data: {
                orgId: oid,
                automationId: automation.id,
                status: 'running',
                attempt: run.attempt + 1,
                dedupeKey: `${run.dedupeKey}:retry${run.attempt + 1}`,
                input: run.input,
                scheduledFor: new Date(Date.now() + backoffMin * 60_000),
              },
            }).catch(() => undefined) // dedupe collision means a retry already exists
            await db.automationRun.update({ where: { id: run.id }, data: { status: 'failed', error: `Attempt ${run.attempt} failed: ${message}; retrying`, finishedAt: new Date() } })
          } else {
            await db.automationRun.update({ where: { id: run.id }, data: { status: 'failed', error: `Attempt ${run.attempt} failed: ${message}; no more retries`, finishedAt: new Date() } })
          }
          stats.failed++
        }
      }
    }

    await setSetting(oid, 'automation.lastTick', new Date().toISOString())
  }

  return stats
}

async function evaluateTrigger(automation: { id: string; orgId: string; triggerType: string; triggerCfg: string; delayMinutes: number }): Promise<number> {
  let created = 0
  const cfg = parseJson<Record<string, unknown>>(automation.triggerCfg, {})

  if (automation.triggerType === 'invoice_overdue') {
    const now = new Date()
    const invoices = await db.invoice.findMany({
      where: { orgId: automation.orgId, status: { in: ['sent', 'partial'] }, dueDate: { lt: now } },
      take: 200,
    })
    for (const invoice of invoices) {
      const outstanding = invoiceOutstanding(invoice.totalCents, invoice.paidCents)
      if (outstanding <= 0) continue
      const daysOverdue = Math.floor((now.getTime() - invoice.dueDate.getTime()) / 86_400_000)
      const minDays = typeof cfg.minDaysOverdue === 'number' ? cfg.minDaysOverdue : 1
      if (daysOverdue < minDays) continue
      // one run per invoice per automation per overdue-stage (deduped forever per day bucket)
      const dedupeKey = `overdue:${automation.id}:${invoice.id}:${Math.min(daysOverdue, 30)}`
      const exists = await db.automationRun.findUnique({
        where: { automationId_dedupeKey: { automationId: automation.id, dedupeKey } },
      })
      if (exists) continue
      await db.automationRun.create({
        data: {
          orgId: automation.orgId,
          automationId: automation.id,
          dedupeKey,
          input: JSON.stringify({ invoiceId: invoice.id, invoiceNumber: invoice.number, daysOverdue, outstandingCents: outstanding }),
          scheduledFor: new Date(Date.now() + automation.delayMinutes * 60_000),
        },
      })
      created++
    }
  }

  return created
}

async function executeRun(automation: {
  id: string; orgId: string; name: string; testMode: boolean; conditions: string; actions: string; quietHours: string; maxRunsPerDay: number
}, run: { id: string; input: string; attempt: number }): Promise<'executed' | 'skipped'> {
  const input = parseJson<Record<string, unknown>>(run.input, {})
  const conditions = parseJson<Condition[]>(automation.conditions, [])
  const actions = parseJson<ActionDef[]>(automation.actions, [])
  const quiet = parseJson<{ start?: string; end?: string }>(automation.quietHours, {})
  const org = await db.organization.findUnique({ where: { id: automation.orgId } })
  if (!org) throw new Error('organization missing')

  await db.automationRun.update({ where: { id: run.id }, data: { startedAt: new Date() } })

  // daily cap
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const runsToday = await db.automationRun.count({
    where: { automationId: automation.id, status: 'success', startedAt: { gte: dayStart } },
  })
  if (runsToday >= automation.maxRunsPerDay) {
    await db.automationRun.update({
      where: { id: run.id },
      data: { status: 'skipped', error: `Daily limit of ${automation.maxRunsPerDay} executions reached`, finishedAt: new Date(), output: JSON.stringify({ skipped: 'daily_limit' }) },
    })
    return 'skipped'
  }

  // quiet hours (only for message-sending actions)
  const sendsMessage = actions.some((a) => a.type === 'send_invoice_reminder' || a.type === 'notify_inapp')
  if (sendsMessage && inQuietHours(quiet.start ?? '', quiet.end ?? '')) {
    await db.automationRun.update({
      where: { id: run.id },
      data: { status: 'skipped', error: `Quiet hours (${quiet.start}–${quiet.end})`, finishedAt: new Date(), output: JSON.stringify({ skipped: 'quiet_hours' }) },
    })
    return 'skipped'
  }

  // conditions: e.g. {field: 'outstandingCents', op: 'gt', value: 0} against run input + fresh DB state
  if (input.invoiceId) {
    const invoice = await db.invoice.findFirst({ where: { id: String(input.invoiceId), orgId: automation.orgId } })
    if (!invoice) {
      await db.automationRun.update({ where: { id: run.id }, data: { status: 'skipped', error: 'Invoice no longer exists', finishedAt: new Date() } })
      return 'skipped'
    }
    const customer = await db.customer.findFirst({ where: { id: invoice.customerId }, select: { optOut: true, consentContact: true } })
    if (customer?.optOut || customer?.consentContact === false) {
      await db.automationRun.update({
        where: { id: run.id },
        data: { status: 'skipped', error: 'Customer opted out of communications', finishedAt: new Date(), output: JSON.stringify({ skipped: 'opt_out' }) },
      })
      return 'skipped'
    }
    const outstanding = invoiceOutstanding(invoice.totalCents, invoice.paidCents)
    if (outstanding <= 0) {
      await db.automationRun.update({
        where: { id: run.id },
        data: { status: 'skipped', error: `Invoice ${invoice.number} is settled — no reminder sent`, finishedAt: new Date(), output: JSON.stringify({ skipped: 'settled' }) },
      })
      return 'skipped'
    }
    if (['paid', 'void'].includes(invoice.status)) {
      await db.automationRun.update({
        where: { id: run.id },
        data: { status: 'skipped', error: `Invoice is ${invoice.status}`, finishedAt: new Date() },
      })
      return 'skipped'
    }
  }

  const outputs: Array<{ action: string; result: string; testMode: boolean }> = []

  for (const action of actions) {
    if (action.type === 'send_invoice_reminder' && input.invoiceId) {
      if (automation.testMode) {
        outputs.push({ action: action.type, result: 'TEST MODE: would queue a payment reminder through the configured channel', testMode: true })
        continue
      }
      const template = typeof action.cfg.template === 'string' ? action.cfg.template : 'Hi {{customer_name}}, a friendly reminder that invoice {{invoice_number}} ({{amount_due}}) was due on {{due_date}}. — {{business_name}}'
      const channel = action.cfg.channel === 'sms' ? 'sms' : action.cfg.channel === 'inapp' ? 'inapp' : 'email'
      const result = await queueInvoiceReminder(automation.orgId, { invoiceId: String(input.invoiceId), dayOffset: Number(input.daysOverdue ?? 1), template, channel })
      outputs.push({ action: action.type, result: `${result.queued ? 'queued' : 'not queued'}: ${result.reason}`, testMode: false })
    } else if (action.type === 'notify_inapp') {
      const body = typeof action.cfg.body === 'string' ? action.cfg.body : `Automation "${automation.name}" ran for ${String(input.invoiceNumber ?? 'record')}`
      if (!automation.testMode) {
        await db.outboxMessage.create({
          data: { orgId: automation.orgId, channel: 'inapp', recipient: 'staff', subject: `Automation: ${automation.name}`, body, status: 'sent', sentAt: new Date(), relatedType: 'automation', relatedId: automation.id },
        })
      }
      outputs.push({ action: action.type, result: automation.testMode ? 'TEST MODE: would create an in-app notification' : 'created in-app notification', testMode: automation.testMode })
    } else if (action.type === 'flag_for_review') {
      if (!automation.testMode) {
        await audit({ orgId: automation.orgId, actorType: 'system', action: 'automation.flagged_for_review', entity: 'automation', entityId: automation.id, meta: { input } })
      }
      outputs.push({ action: action.type, result: automation.testMode ? 'TEST MODE: would flag for review' : 'flagged for review', testMode: automation.testMode })
    } else {
      outputs.push({ action: action.type, result: 'unknown action type — skipped', testMode: false })
    }
  }

  await db.automationRun.update({
    where: { id: run.id },
    data: { status: 'success', finishedAt: new Date(), output: JSON.stringify({ actions: outputs }) },
  })
  await audit({ orgId: automation.orgId, actorType: 'system', action: 'automation.executed', entity: 'automation', entityId: automation.id, meta: { runId: run.id, outputs } })
  return 'executed'
}

/** Emit an event to trigger-based automations (booking_created, conversation_escalated). */
export async function emitEvent(orgId: string, type: 'booking_created' | 'conversation_escalated', payload: Record<string, unknown>): Promise<void> {
  const automations = await db.automation.findMany({ where: { orgId, enabled: true, triggerType: type } })
  for (const automation of automations) {
    const dedupeKey = `${type}:${String(payload.entityId ?? Date.now())}`
    const exists = await db.automationRun.findUnique({ where: { automationId_dedupeKey: { automationId: automation.id, dedupeKey } } })
    if (exists) continue
    await db.automationRun.create({
      data: { orgId, automationId: automation.id, dedupeKey, input: JSON.stringify(payload), scheduledFor: new Date(Date.now() + automation.delayMinutes * 60_000) },
    })
  }
}

export async function workerHeartbeat(orgId: string): Promise<{ lastTick: string | null; healthy: boolean }> {
  const lastTick = await getSetting<string | null>(orgId, 'automation.lastTick', null)
  const healthy = lastTick ? Date.now() - new Date(lastTick).getTime() < 5 * 60_000 : false
  return { lastTick, healthy }
}

export { outboxCountFor }
