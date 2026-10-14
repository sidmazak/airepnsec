import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { invoiceOutstanding } from '@/lib/business/invoice'
import { getEnabledStripe, createStripePaymentLink } from '@/lib/integrations/stripe'

export type ReminderTemplateVars = {
  customerName: string
  invoiceNumber: string
  amountDue: string
  dueDate: string
  businessName: string
  paymentLink: string
}

export function renderTemplate(template: string, vars: ReminderTemplateVars): string {
  return template
    .replaceAll('{{customer_name}}', vars.customerName)
    .replaceAll('{{invoice_number}}', vars.invoiceNumber)
    .replaceAll('{{amount_due}}', vars.amountDue)
    .replaceAll('{{due_date}}', vars.dueDate)
    .replaceAll('{{business_name}}', vars.businessName)
    .replaceAll('{{payment_link}}', vars.paymentLink)
}

export function inQuietHours(quietStart: string, quietEnd: string, now = new Date()): boolean {
  if (!quietStart || !quietEnd || quietStart === quietEnd) return false
  const [sh, sm] = quietStart.split(':').map(Number)
  const [eh, em] = quietEnd.split(':').map(Number)
  const mins = now.getHours() * 60 + now.getMinutes()
  const startM = sh * 60 + sm
  const endM = eh * 60 + em
  return startM <= endM ? mins >= startM && mins < endM : mins >= startM || mins < endM
}

export type QueueReminderInput = {
  invoiceId: string
  dayOffset: number // days after due date, used for dedupe
  template: string
  channel?: 'email' | 'sms' | 'inapp'
}

/**
 * Queue a collection reminder for an overdue invoice.
 * Honest delivery states: if no external channel is configured the message is stored
 * in the outbox as "queued" with an explicit reason — it is never reported as sent.
 * Deduped per invoice+day so reminders never repeat within a run.
 */
export async function queueInvoiceReminder(orgId: string, input: QueueReminderInput): Promise<{ queued: boolean; reason: string; outboxId?: string }> {
  const invoice = await db.invoice.findFirst({ where: { id: input.invoiceId, orgId } })
  if (!invoice) return { queued: false, reason: 'invoice not found' }
  if (['paid', 'void'].includes(invoice.status)) return { queued: false, reason: `invoice is ${invoice.status}` }

  const customer = await db.customer.findFirst({ where: { id: invoice.customerId, orgId } })
  if (!customer) return { queued: false, reason: 'customer not found' }
  if (customer.optOut || !customer.consentContact) return { queued: false, reason: 'customer opted out of communications' }

  const outstanding = invoiceOutstanding(invoice.totalCents, invoice.paidCents)
  if (outstanding <= 0) return { queued: false, reason: 'invoice fully settled (verified ledger balance)' }

  const org = await db.organization.findUnique({ where: { id: orgId } })
  if (!org) return { queued: false, reason: 'organization not found' }

  const now = new Date()
  const dayKey = new Date(now.getTime() + input.dayOffset * 0).toISOString().slice(0, 10)
  const dedupeKey = `inv_reminder:${invoice.id}:${dayKey}:${input.dayOffset}`
  const existing = await db.outboxMessage.findUnique({ where: { dedupeKey } })
  if (existing) return { queued: false, reason: 'reminder already sent today for this stage (deduplicated)' }

  const channel = input.channel ?? 'email'

  // Real Stripe payment link when the integration is enabled; a plain-language
  // fallback keeps the reminder honest (never a fake URL) when Stripe is off or fails.
  let paymentLink = '(payment instructions from business profile)'
  if (await getEnabledStripe(orgId)) {
    try {
      const link = await createStripePaymentLink(orgId, { id: invoice.id, number: invoice.number, currency: invoice.currency }, outstanding)
      paymentLink = link.url
    } catch (err) {
      paymentLink = `(payment link unavailable: ${err instanceof Error ? err.message : 'Stripe error'})`
    }
  }

  const body = renderTemplate(input.template, {
    customerName: customer.name,
    invoiceNumber: invoice.number,
    amountDue: `$${(outstanding / 100).toFixed(2)}`,
    dueDate: invoice.dueDate.toISOString().slice(0, 10),
    businessName: org.name,
    paymentLink,
  })

  const recipient = channel === 'email' ? customer.email : channel === 'sms' ? customer.phone : customer.id
  if (channel !== 'inapp' && !recipient) {
    await db.outboxMessage.create({
      data: { orgId, channel, recipient: '', subject: `Payment reminder — ${invoice.number}`, body, status: 'failed', statusReason: `no ${channel} address on file for customer`, relatedType: 'invoice', relatedId: invoice.id, dedupeKey },
    })
    return { queued: false, reason: `customer has no ${channel} address` }
  }
  const isInapp = channel === 'inapp'
  const hasExternalChannel =
    isInapp ||
    Boolean(await db.appSetting.findUnique({ where: { orgId_key: { orgId, key: `channel_${channel}` } } }))

  const msg = await db.outboxMessage.create({
    data: {
      orgId,
      channel,
      recipient,
      subject: `Payment reminder — ${invoice.number}`,
      body,
      status: hasExternalChannel ? (isInapp ? 'sent' : 'queued') : 'queued',
      statusReason: hasExternalChannel ? '' : 'no external channel configured — visible here and in in-app notifications',
      relatedType: 'invoice',
      relatedId: invoice.id,
      dedupeKey,
      ...(isInapp ? { sentAt: now } : {}),
    },
  })

  await audit({ orgId, actorType: 'system', action: 'collections.reminder_queued', entity: 'invoice', entityId: invoice.id, meta: { channel, dedupeKey, status: msg.status } })
  return { queued: true, reason: msg.status === 'sent' ? 'delivered in-app' : 'queued in outbox', outboxId: msg.id }
}
