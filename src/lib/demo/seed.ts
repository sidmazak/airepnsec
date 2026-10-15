import { db } from '@/lib/db'
import { hashPassword } from '@/lib/crypto'
import { createBooking } from '@/lib/business/booking'
import { createInvoice } from '@/lib/business/invoice'
import { recordVerifiedPayment, recordPaymentClaim } from '@/lib/business/payments'
import { indexDocument } from '@/lib/ai/embeddings'

export const DEMO_ORG_SLUG = 'demo'
export const DEMO_OWNER_EMAIL = 'demo@aisecretary.local'
export const DEMO_OWNER_PASSWORD = 'demo-1234'

function daysFromNow(days: number, hour = 10, minute = 0): Date {
  const d = new Date()
  d.setDate(d.getDate() + days)
  d.setHours(hour, minute, 0, 0)
  return d
}

// The demo org runs at fixed offset UTC+05:30 — availability is validated in the
// ORG's wall clock, so booking times must be computed there (not server-local).
const DEMO_TZ_OFFSET_MIN = 5 * 60 + 30

function wallClockAt(wallDay: Date, hour: number, minute = 0): Date {
  return new Date(wallDay.getTime() + (hour * 60 + minute - DEMO_TZ_OFFSET_MIN) * 60_000)
}

/** nth upcoming non-Sunday org-wall day (n = 1 → tomorrow, skipping Sundays — the salon is closed). */
function nthBusinessDay(n: number): Date {
  const d = new Date(Date.now() + DEMO_TZ_OFFSET_MIN * 60_000)
  d.setUTCHours(0, 0, 0, 0)
  let count = 0
  while (count < n) {
    d.setUTCDate(d.getUTCDate() + 1)
    if (d.getUTCDay() !== 0) count += 1
  }
  return d
}

/** Idempotent: seeds a clearly-labeled demo organization with realistic data. */
export async function seedDemo(): Promise<{ orgId: string; email: string; password: string }> {
  const existing = await db.organization.findUnique({ where: { slug: DEMO_ORG_SLUG } })
  if (existing) {
    const owner = await db.user.findFirst({ where: { orgId: existing.id, role: 'owner' } })
    return { orgId: existing.id, email: owner?.email ?? DEMO_OWNER_EMAIL, password: DEMO_OWNER_PASSWORD }
  }

  const org = await db.organization.create({
    data: {
      name: 'Harborview Salon & Spa (DEMO)',
      slug: DEMO_ORG_SLUG,
      businessType: 'salon',
      timezone: 'UTC+05:30',
      locale: 'en',
      currency: 'USD',
      address: '12 Marina Boulevard, Suite 200',
      phone: '+1 555 010 2233',
      email: 'hello@harborview.example',
      openingHours: JSON.stringify({
        '1': [['09:00', '18:00']], '2': [['09:00', '18:00']], '3': [['09:00', '18:00']],
        '4': [['09:00', '20:00']], '5': [['09:00', '20:00']], '6': [['10:00', '16:00']], '0': [],
      }),
      holidays: JSON.stringify([]),
      policies: JSON.stringify({ autoConfirmBookings: true, cancellation: { minHoursBefore: 24 }, deposit: { requiredForBooking: false }, quietHours: { start: '21:00', end: '08:00' } }),
      aiIdentity: JSON.stringify({ businessTone: 'friendly', greeting: 'Hi! Welcome to Harborview Salon & Spa. How can I help you today?', closing: 'Thank you for choosing Harborview!', escalationNote: 'a team member will follow up' }),
      collectionsCfg: JSON.stringify({ reminderDays: [1, 3, 7], maxTouchesPerInvoice: 4, quietStart: '21:00', quietEnd: '08:00' }),
      demo: true,
      setupComplete: true,
      setupState: JSON.stringify({ business: { done: true }, services: { done: true }, imports: { done: true }, knowledge: { done: true }, ai: { done: true }, channels: { done: true }, collections: { done: true }, tests: { done: true } }),
      dataMode: 'hybrid',
    },
  })

  await db.user.create({
    data: { orgId: org.id, email: DEMO_OWNER_EMAIL, passwordHash: hashPassword(DEMO_OWNER_PASSWORD), name: 'Demo Owner', role: 'owner' },
  })

  // staff
  const maya = await db.staff.create({ data: { orgId: org.id, name: 'Maya Chen', role: 'Senior Stylist', email: 'maya@harborview.example' } })
  const leo = await db.staff.create({ data: { orgId: org.id, name: 'Leo Park', role: 'Barber', email: 'leo@harborview.example' } })
  const ana = await db.staff.create({ data: { orgId: org.id, name: 'Ana Silva', role: 'Esthetician', email: 'ana@harborview.example' } })

  // services
  const cut = await db.service.create({ data: { orgId: org.id, name: 'Signature Haircut', description: 'Consultation, shampoo, cut & style', category: 'hair', durationMin: 60, priceCents: 6500, bufferBeforeMin: 0, bufferAfterMin: 10 } })
  const color = await db.service.create({ data: { orgId: org.id, name: 'Full Color Treatment', description: 'Color, gloss and blow-dry', category: 'hair', durationMin: 120, priceCents: 18000, bufferBeforeMin: 0, bufferAfterMin: 15 } })
  const beard = await db.service.create({ data: { orgId: org.id, name: 'Beard Trim & Shape', description: 'Precision beard shaping', category: 'grooming', durationMin: 30, priceCents: 3000, bufferAfterMin: 5 } })
  const facial = await db.service.create({ data: { orgId: org.id, name: 'Deep-Cleansing Facial', description: '60-minute customized facial', category: 'skin', durationMin: 60, priceCents: 9500, bufferAfterMin: 15 } })

  for (const [staffId, serviceId] of [[maya.id, cut.id], [maya.id, color.id], [leo.id, beard.id], [leo.id, cut.id], [ana.id, facial.id]] as const) {
    await db.staffService.create({ data: { staffId, serviceId } })
  }

  // working hours: org default Mon-Sat (staff inherit)
  const orgHours: Array<[number, number, number]> = [
    [1, 9 * 60, 18 * 60], [2, 9 * 60, 18 * 60], [3, 9 * 60, 18 * 60], [4, 9 * 60, 20 * 60], [5, 9 * 60, 20 * 60], [6, 10 * 60, 16 * 60],
  ]
  for (const [dow, startMin, endMin] of orgHours) {
    await db.workingHour.create({ data: { orgId: org.id, staffId: null, dow, startMin, endMin } })
  }

  // customers
  const customers = await Promise.all(
    [
      { name: 'Priya Sharma', email: 'priya.sharma@example.com', phone: '+1 555 201 8845', tags: ['regular'] },
      { name: 'James Wu', email: 'james.wu@example.com', phone: '+1 555 318 2210', tags: [] },
      { name: 'Sofia Martinez', email: 'sofia.m@example.com', phone: '+1 555 774 9032', tags: ['vip'] },
      { name: 'Daniel Okafor', email: 'd.okafor@example.com', phone: '+1 555 662 4471', tags: [] },
      { name: 'Emma Lindqvist', email: 'emma.l@example.com', phone: '+1 555 990 1187', tags: ['regular'] },
    ].map((c) => db.customer.create({ data: { orgId: org.id, ...c, tags: JSON.stringify(c.tags) } }))
  )

  // upcoming bookings via the REAL booking engine — scheduled on the next three
  // business days in the org's wall clock so they always fit working hours
  const day1 = nthBusinessDay(1)
  const day2 = nthBusinessDay(2)
  const day3 = nthBusinessDay(3)
  const upcoming = [
    { customer: customers[0], service: cut, staff: maya, day: day1, hour: 10 },
    { customer: customers[1], service: beard, staff: leo, day: day1, hour: 15 },
    { customer: customers[2], service: color, staff: maya, day: day2, hour: day2.getUTCDay() === 6 ? 10 : 9 }, // Saturday opens at 10:00
    { customer: customers[4], service: facial, staff: ana, day: day3, hour: 11 },
  ]
  for (const u of upcoming) {
    await createBooking(org.id, { timezone: org.timezone, holidays: org.holidays }, {
      customerId: u.customer.id,
      serviceId: u.service.id,
      staffId: u.staff.id,
      startAt: wallClockAt(u.day, u.hour).toISOString(),
      source: 'manual',
      notes: 'Seeded demo booking',
    }, { type: 'system', id: 'demo-seed' })
  }

  // knowledge docs
  const docs = [
    {
      title: 'Cancellation policy',
      content: 'Appointments can be cancelled or rescheduled free of charge up to 24 hours before the start time. Cancellations within 24 hours are charged 50% of the service price. No-shows are charged the full price. Please call us or message here to cancel.',
      tags: ['policy'],
    },
    {
      title: 'Parking & access',
      content: 'Validated parking is available in the Marina Boulevard garage (entrance on 3rd Ave). We validate for up to 2 hours. The salon entrance and treatment rooms are wheelchair accessible. Service animals are welcome.',
      tags: ['faq'],
    },
    {
      title: 'Payment methods',
      content: 'We accept all major credit cards, debit cards, cash, and mobile wallets. Payments are due at the time of service unless an account invoice was issued. Invoices sent by email are due within 14 days. Deposits for color services are credited toward the final bill.',
      tags: ['faq'],
    },
    {
      title: 'Products & brands',
      content: 'We use and sell only cruelty-free, sulfate-free product lines. Retail products can be returned unopened within 30 days with a receipt.',
      tags: ['faq'],
    },
  ]
  for (const d of docs) {
    const doc = await db.knowledgeDoc.create({ data: { orgId: org.id, title: d.title, content: d.content, approved: true, tags: JSON.stringify(d.tags), source: 'manual' } })
    await indexDocument(org.id, doc.id, d.content)
  }

  // invoices: one paid, one partial, one overdue — with verified ledger entries
  const invPaid = await createInvoice(org.id, {
    customerId: customers[0].id,
    items: [{ description: 'Full Color Treatment', qty: 1, unitPriceCents: 18000 }, { description: 'Retail — shine serum', qty: 1, unitPriceCents: 2400 }],
    taxCents: 1632,
    dueInDays: 14,
    issueDate: daysFromNow(-20).toISOString(),
    notes: 'Seeded demo invoice',
  }, { type: 'system', id: 'demo-seed' })
  await recordVerifiedPayment(org.id, { invoiceId: invPaid.id, amountCents: invPaid.totalCents, method: 'card', reference: 'demo-card-001', source: 'manual', verifiedBy: 'demo-seed' }, { type: 'system', id: 'demo-seed' })

  const invPartial = await createInvoice(org.id, {
    customerId: customers[2].id,
    items: [{ description: 'Deep-Cleansing Facial (package of 3)', qty: 1, unitPriceCents: 25500 }],
    taxCents: 2040,
    dueInDays: 10,
    issueDate: daysFromNow(-12).toISOString(),
    notes: 'Seeded demo invoice',
  }, { type: 'system', id: 'demo-seed' })
  await recordVerifiedPayment(org.id, { invoiceId: invPartial.id, amountCents: 10000, method: 'bank', reference: 'demo-bank-002', source: 'manual', verifiedBy: 'demo-seed' }, { type: 'system', id: 'demo-seed' })

  const invOverdue = await createInvoice(org.id, {
    customerId: customers[3].id,
    items: [{ description: 'Beard Trim & Shape — monthly account', qty: 4, unitPriceCents: 3000 }],
    taxCents: 960,
    dueInDays: -3,
    issueDate: daysFromNow(-33).toISOString(),
    notes: 'Seeded demo invoice (overdue)',
  }, { type: 'system', id: 'demo-seed' })
  // customer claimed payment — pending verification, must NOT settle the invoice
  await recordPaymentClaim(org.id, { invoiceId: invOverdue.id, amountCents: invOverdue.totalCents, method: 'cash', reference: 'claimed-in-chat', note: 'Customer says they paid in person' }, { type: 'system', id: 'demo-seed' })

  // collections automation (test mode off → writes honest outbox states)
  await db.automation.create({
    data: {
      orgId: org.id,
      name: 'Overdue invoice reminders',
      description: 'When an invoice becomes overdue, wait 1 day, verify the balance and consent, then send a reminder. Stops automatically once settled.',
      enabled: true,
      testMode: false,
      triggerType: 'invoice_overdue',
      triggerCfg: JSON.stringify({ minDaysOverdue: 1 }),
      conditions: JSON.stringify([{ field: 'outstandingCents', op: 'gt', value: 0 }]),
      delayMinutes: 0,
      actions: JSON.stringify([{ type: 'send_invoice_reminder', cfg: { channel: 'email', template: 'Hi {{customer_name}}, a friendly reminder that invoice {{invoice_number}} ({{amount_due}}) was due on {{due_date}}. You can settle it any time — just reply here. — {{business_name}}' } }]),
      maxRunsPerDay: 20,
      quietHours: JSON.stringify({ start: '21:00', end: '08:00' }),
    },
  })
  await db.automation.create({
    data: {
      orgId: org.id,
      name: 'Escalation notifications',
      description: 'When the AI receptionist escalates a conversation, notify staff in-app.',
      enabled: true,
      testMode: false,
      triggerType: 'conversation_escalated',
      triggerCfg: '{}',
      conditions: '[]',
      delayMinutes: 0,
      actions: JSON.stringify([{ type: 'notify_inapp', cfg: { body: 'A conversation was escalated by the AI receptionist — check the inbox.' } }]),
      maxRunsPerDay: 50,
      quietHours: '{}',
    },
  })

  // no demo LLM credentials are shipped: the model row is left disabled so the
  // operator configures their own. Local neural embeddings work out of the box.
  await db.providerConfig.create({
    data: { orgId: org.id, capability: 'llm', provider: 'none', label: 'Configure in AI Providers', enabled: false },
  })
  await db.providerConfig.create({
    data: { orgId: org.id, capability: 'embedding', provider: 'local_neural', label: 'Built-in neural embeddings (local)', enabled: true },
  })

  // a demo inbox conversation
  const convo = await db.conversation.create({
    data: { orgId: org.id, customerId: customers[1].id, channel: 'web', status: 'open', contactName: customers[1].name },
  })
  await db.message.createMany({
    data: [
      { conversationId: convo.id, orgId: org.id, role: 'customer', content: 'Hi! Do you have anything open for a beard trim this week?' },
      { conversationId: convo.id, orgId: org.id, role: 'assistant', content: 'Welcome back, James! Let me check the real schedule for you — one moment.', meta: JSON.stringify({ toolCalls: [] }) },
    ],
  })

  await db.auditEvent.create({
    data: { orgId: org.id, actorType: 'system', actorId: 'demo-seed', action: 'demo.seeded', entity: 'organization', entityId: org.id, meta: JSON.stringify({ note: 'Demo organization created with seeded data' }) },
  })

  return { orgId: org.id, email: DEMO_OWNER_EMAIL, password: DEMO_OWNER_PASSWORD }
}
