import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { queueInvoiceReminder, inQuietHours } from '@/lib/business/collections'
import { invoiceOutstanding } from '@/lib/business/invoice'
import { parseJson, getSetting, setSetting } from '@/lib/org'
import { integrationConfig, str } from '@/lib/integrations/connectors'
import { renderBookingEmail } from '@/lib/integrations/templates'
import { outboxCountFor } from '@/lib/automation/actions'

export type TriggerType = 'invoice_overdue' | 'booking_created' | 'conversation_escalated' | 'manual'

export type Condition = { field: string; op: 'eq' | 'neq' | 'gt' | 'lt' | 'contains'; value: string | number }
export type ActionDef = {
  type: 'send_invoice_reminder' | 'notify_inapp' | 'flag_for_review' | 'send_email' | 'send_sms' | 'send_webhook'
  cfg: Record<string, unknown>
}

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
  id: string; orgId: string; name: string; testMode: boolean; triggerType: string; conditions: string; actions: string; quietHours: string; maxRunsPerDay: number
}, run: { id: string; input: string; attempt: number; dedupeKey: string }): Promise<'executed' | 'skipped'> {
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
  const sendsMessage =
    actions.some((a) => a.type === 'send_invoice_reminder' || a.type === 'notify_inapp') ||
    actions.some((a) => a.type === 'send_email' || a.type === 'send_sms' || a.type === 'send_webhook')
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

  // Message-action context: resolve customer (and service/start time) for the
  // new direct-send actions. booking_created/conversation_escalated payloads
  // carry customerId; invoice triggers resolve through the invoice.
  let customer: { id: string; name: string; email: string; phone: string; optOut: boolean; consentContact: boolean } | null = null
  let serviceName = ''
  let startTime = ''
  if (typeof input.customerId === 'string' && input.customerId) {
    customer = await db.customer.findFirst({ where: { id: String(input.customerId), orgId: automation.orgId } })
  }
  if (typeof input.bookingId === 'string' && input.bookingId) {
    const booking = await db.booking.findFirst({ where: { id: String(input.bookingId), orgId: automation.orgId }, include: { service: { select: { name: true } } } })
    if (booking) {
      serviceName = booking.service.name
      startTime = booking.startAt.toISOString()
      customer = customer ?? (await db.customer.findFirst({ where: { id: booking.customerId, orgId: automation.orgId } }))
    }
  }
  if (customer && !serviceName && typeof input.serviceName === 'string') serviceName = input.serviceName
  if (customer && !startTime && typeof input.startAt === 'string') startTime = input.startAt

  let actionInvoice: { number: string; totalCents: number; paidCents: number; dueDate: Date } | null = null
  if (typeof input.invoiceId === 'string' && input.invoiceId) {
    actionInvoice = await db.invoice.findFirst({
      where: { id: String(input.invoiceId), orgId: automation.orgId },
      select: { number: true, totalCents: true, paidCents: true, dueDate: true },
    })
    if (actionInvoice && !customer) {
      const inv = await db.invoice.findFirst({ where: { id: String(input.invoiceId), orgId: automation.orgId }, select: { customerId: true } })
      customer = inv ? await db.customer.findFirst({ where: { id: inv.customerId, orgId: automation.orgId } }) : null
    }
  }

  const outstandingForVars = actionInvoice ? invoiceOutstanding(actionInvoice.totalCents, actionInvoice.paidCents) : (typeof input.outstandingCents === 'number' ? input.outstandingCents : 0)
  const vars: Record<string, string> = {
    customer_name: customer?.name ?? '',
    business_name: org.name,
    invoice_number: actionInvoice?.number ?? (typeof input.invoiceNumber === 'string' ? input.invoiceNumber : ''),
    amount_due: `$${(outstandingForVars / 100).toFixed(2)}`,
    due_date: actionInvoice ? actionInvoice.dueDate.toISOString().slice(0, 10) : '',
    service_name: serviceName,
    start_time: startTime,
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
    } else if (action.type === 'send_email' || action.type === 'send_sms' || action.type === 'send_webhook') {
      if (automation.testMode) {
        outputs.push({ action: action.type, result: 'TEST MODE: would queue a direct message in the outbox', testMode: true })
        continue
      }
      if (!customer) {
        outputs.push({ action: action.type, result: 'skipped: no customer found for this trigger', testMode: false })
        continue
      }
      if (customer.optOut || !customer.consentContact) {
        outputs.push({ action: action.type, result: 'skipped: customer opted out of communications', testMode: false })
        continue
      }
      const result = await runDirectSendAction(automation, run, action, customer, vars, input)
      outputs.push({ action: action.type, result, testMode: false })
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

/** collections.renderTemplate-style substitution, extended with service/start-time vars. */
function renderAutomationTemplate(template: string, vars: Record<string, string>): string {
  let out = template
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, value)
  }
  return out
}

type AutomationRow = {
  id: string
  orgId: string
  name: string
  triggerType: string
  testMode: boolean
}
type RunRow = { id: string; dedupeKey: string }
type CustomerRow = { id: string; name: string; email: string; phone: string; optOut: boolean; consentContact: boolean }

/**
 * Direct-send actions (send_email / send_sms / send_webhook): create honest
 * OutboxMessage rows. Delivery itself is the dispatcher's job — an unconfigured
 * channel queues with an explicit "waiting for <channel> integration" reason.
 */
async function runDirectSendAction(
  automation: AutomationRow,
  run: RunRow,
  action: ActionDef,
  customer: CustomerRow,
  vars: Record<string, string>,
  input: Record<string, unknown>
): Promise<string> {
  const actionIdx = String(Math.abs(hashString(`${automation.id}:${run.id}:${action.type}`)) % 1000)

  if (action.type === 'send_email') {
    if (!customer.email) return 'skipped: customer has no email address on file'

    // Booking triggers use the rich booking-confirmation template (html + text,
    // with a link to the booking's .ics calendar file) unless a custom body is set.
    let rendered: { subject: string; text: string; html: string } | null = null
    if (typeof input.bookingId === 'string' && input.bookingId && !(typeof action.cfg.body === 'string' && action.cfg.body.trim())) {
      const booking = await db.booking.findFirst({
        where: { id: String(input.bookingId), orgId: automation.orgId },
        include: { service: { select: { name: true, priceCents: true, currency: true } } },
      })
      const org = await db.organization.findUnique({ where: { id: automation.orgId }, select: { name: true } })
      if (booking && org) {
        rendered = renderBookingEmail({
          booking,
          service: booking.service,
          customer: { name: customer.name },
          org: { name: org.name },
          icsPath: `/api/calendar/bookings/${booking.id}.ics`,
        })
      }
    }

    const subject = rendered ? rendered.subject : renderAutomationTemplate(
      typeof action.cfg.subject === 'string' && action.cfg.subject.trim() ? action.cfg.subject : `A message from {{business_name}}`,
      vars
    )
    const body = rendered ? rendered.text : renderAutomationTemplate(
      typeof action.cfg.body === 'string' && action.cfg.body.trim() ? action.cfg.body : 'Hi {{customer_name}}, this is a message from {{business_name}}.',
      vars
    )
    const msg = await db.outboxMessage.create({
      data: {
        orgId: automation.orgId,
        channel: 'email',
        recipient: customer.email,
        subject,
        body,
        ...(rendered ? { html: rendered.html } : {}),
        status: 'queued',
        relatedType: 'automation',
        relatedId: automation.id,
        dedupeKey: `automation:${automation.id}:${run.dedupeKey}:${actionIdx}`,
      },
    }).catch(() => null)
    return msg ? `queued in outbox (message ${msg.id} — delivered once an email integration is configured)` : 'skipped: duplicate message for this run (deduplicated)'
  }

  if (action.type === 'send_sms') {
    if (!customer.phone) return 'skipped: customer has no phone number on file'
    const body = renderAutomationTemplate(
      typeof action.cfg.body === 'string' && action.cfg.body.trim() ? action.cfg.body : 'Hi {{customer_name}} — a message from {{business_name}}.',
      vars
    )
    const msg = await db.outboxMessage.create({
      data: {
        orgId: automation.orgId,
        channel: 'sms',
        recipient: customer.phone,
        subject: '',
        body,
        status: 'queued',
        relatedType: 'automation',
        relatedId: automation.id,
        dedupeKey: `automation:${automation.id}:${run.dedupeKey}:${actionIdx}`,
      },
    }).catch(() => null)
    return msg ? `queued in outbox (message ${msg.id} — delivered once an SMS integration is configured)` : 'skipped: duplicate message for this run (deduplicated)'
  }

  // send_webhook — recipient is the destination URL of a webhook_out integration.
  const destinationId = typeof action.cfg.destinationId === 'string' ? action.cfg.destinationId : ''
  const webhookIntegration = destinationId
    ? await db.integration.findFirst({ where: { id: destinationId, orgId: automation.orgId, kind: 'webhook_out' } })
    : null
  if (!webhookIntegration) return 'skipped: webhook destination not found (configure a webhook_out integration and reference its id)'
  const url = str(integrationConfig(webhookIntegration), 'url')
  if (!url) return 'skipped: webhook_out integration has no destination URL'

  const payload = {
    event: `automation.${automation.triggerType}`,
    automation: automation.name,
    input,
  }
  const msg = await db.outboxMessage.create({
    data: {
      orgId: automation.orgId,
      channel: 'webhook',
      recipient: url,
      subject: `automation.${automation.triggerType}`,
      body: JSON.stringify(payload),
      status: 'queued',
      relatedType: 'automation',
      relatedId: automation.id,
      dedupeKey: `automation:${automation.id}:${run.dedupeKey}:${actionIdx}`,
    },
  }).catch(() => null)
  return msg ? `queued in outbox (message ${msg.id} — POSTed to ${url} by the dispatcher)` : 'skipped: duplicate message for this run (deduplicated)'
}

function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0
  }
  return hash
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
