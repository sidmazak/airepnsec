import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { chatComplete, LlmMessage } from '@/lib/ai/llm'
import { searchKnowledge } from '@/lib/ai/embeddings'
import { createBooking, cancelBooking } from '@/lib/business/booking'
import { recordPaymentClaim } from '@/lib/business/payments'
import { computeSlots } from '@/lib/business/availability'
import { parseJson } from '@/lib/org'
import type { Organization } from '@prisma/client'

const MAX_TOOL_ROUNDS = 6

/* ---------------- tool definitions ---------------- */

type ToolCtx = {
  org: Organization
  conversationId: string
  customer: { id: string; name: string; phone: string; email: string } | null
  actor: { type: 'ai'; id: string }
}

type ToolDef = {
  name: string
  description: string
  args: Record<string, string> // arg name -> description (validated manually below)
  execute: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
}

function money(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toFixed(2)}`
}

function resolveService(orgId: string, ref: string) {
  // assistant may pass id or a fuzzy name; SQLite has no case-insensitive filter, match in JS
  return db.service.findMany({ where: { orgId, active: true } }).then((services) =>
    services.find((s) => s.id === ref || s.name.toLowerCase() === ref.toLowerCase()) ?? null
  )
}

async function findCustomerByContact(orgId: string, phone: string, email: string) {
  if (phone) {
    const digits = phone.replace(/\D/g, '')
    const byPhone = await db.customer.findFirst({ where: { orgId, phone: { not: '' } } })
    // fetch all and match suffix digits (local dataset is small; documented trade-off)
    const all = await db.customer.findMany({ where: { orgId, phone: { not: '' } }, take: 500 })
    const phoneMatch = all.find((c) => {
      const cd = c.phone.replace(/\D/g, '')
      return digits.length >= 4 && (cd === digits || cd.endsWith(digits) || digits.endsWith(cd))
    })
    if (phoneMatch) return phoneMatch
  }
  if (email) {
    const all = await db.customer.findMany({ where: { orgId, email: { not: '' } }, take: 500 })
    const byEmail = all.find((c) => c.email.toLowerCase() === email.toLowerCase())
    if (byEmail) return byEmail
  }
  return null
}

export const TOOLS: ToolDef[] = [
  {
    name: 'list_services',
    description: 'List all bookable services with durations and exact prices. Use for price questions.',
    args: {},
    execute: async (_args, ctx) => {
      const services = await db.service.findMany({ where: { orgId: ctx.org.id, active: true } })
      return {
        services: services.map((s) => ({
          id: s.id,
          name: s.name,
          duration_minutes: s.durationMin,
          price: money(s.priceCents, ctx.org.currency),
          deposit_required: s.requiresDeposit,
        })),
      }
    },
  },
  {
    name: 'check_availability',
    description: 'Check real open time slots for a service on a date. Never guess availability — always call this.',
    args: { service: 'service id or exact service name', date: 'date as YYYY-MM-DD (required)' },
    execute: async (args, ctx) => {
      const ref = str(args, 'service')
      const date = str(args, 'date')
      if (!ref || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Please provide a service name and a date in YYYY-MM-DD format.' }
      const service = await resolveService(ctx.org.id, ref)
      if (!service) return { error: `No service matching "${ref}".` }
      const dayStart = new Date(`${date}T00:00:00Z`)
      const slots = await computeSlots(
        ctx.org.id,
        { serviceId: service.id, from: dayStart > new Date() ? dayStart : new Date(), to: new Date(dayStart.getTime() + 24 * 60 * 60 * 1000) },
        ctx.org.timezone,
        parseJson<string[]>(ctx.org.holidays ?? '[]', [])
      )
      return {
        service: service.name,
        date,
        open_slots: slots.slice(0, 20).map((s) => new Date(s.startAt).toISOString().slice(11, 16)),
        timezone: ctx.org.timezone,
        note: slots.length === 0 ? 'No open slots that day.' : undefined,
      }
    },
  },
  {
    name: 'quote_price',
    description: 'Get the exact configured price for one service.',
    args: { service: 'service id or exact service name' },
    execute: async (args, ctx) => {
      const ref = str(args, 'service')
      const service = await resolveService(ctx.org.id, ref)
      if (!service) return { error: `No service matching "${ref}".` }
      return { service: service.name, price: money(service.priceCents, ctx.org.currency), duration_minutes: service.durationMin, deposit_required: service.requiresDeposit }
    },
  },
  {
    name: 'create_booking',
    description: 'Create a real appointment. Returns the actual result — if it fails, tell the customer it failed.',
    args: { service: 'service id or exact name', start_at: 'ISO datetime of an open slot you verified with check_availability', customer_name: 'full name', customer_phone: 'phone number', customer_email: 'email (optional if phone given)' },
    execute: async (args, ctx) => {
      const ref = str(args, 'service')
      const startAt = str(args, 'start_at')
      const name = str(args, 'customer_name')
      const phone = str(args, 'customer_phone')
      const email = str(args, 'customer_email')
      if (!ref || !startAt || !name || (!phone && !email)) {
        return { error: 'To book I need: service, start_at (ISO), customer_name, and customer_phone or customer_email.' }
      }
      const start = new Date(startAt)
      if (isNaN(start.getTime())) return { error: `start_at "${startAt}" is not a valid date/time.` }

      let customer = ctx.customer
      if (!customer) {
        const found = await findCustomerByContact(ctx.org.id, phone, email)
        customer = found
          ? { id: found.id, name: found.name, phone: found.phone, email: found.email }
          : {
              id: (await db.customer.create({ data: { orgId: ctx.org.id, name, phone, email, tags: JSON.stringify(['from-ai']) } })).id,
              name, phone, email,
            }
        // bind conversation to customer
        await db.conversation.update({ where: { id: ctx.conversationId }, data: { customerId: customer.id } })
      }

      const service = await resolveService(ctx.org.id, ref)
      if (!service) return { error: `No service matching "${ref}".` }

      const booking = await createBooking(
        ctx.org.id,
        { timezone: ctx.org.timezone, holidays: ctx.org.holidays },
        { customerId: customer.id, serviceId: service.id, startAt: start.toISOString(), source: 'ai_chat', notes: `Booked by AI receptionist for ${customer.name}` },
        ctx.actor
      )
      return {
        success: true,
        booking: {
          id: booking.id,
          service: service.name,
          start: booking.startAt.toISOString(),
          end: booking.endAt.toISOString(),
          status: booking.status,
          price: money(booking.priceCents, ctx.org.currency),
        },
      }
    },
  },
  {
    name: 'my_bookings',
    description: 'Look up upcoming appointments for the current customer (matched by phone/email).',
    args: { customer_phone: 'phone (optional if known)', customer_email: 'email (optional if known)' },
    execute: async (args, ctx) => {
      const phone = str(args, 'customer_phone') || ctx.customer?.phone || ''
      const email = str(args, 'customer_email') || ctx.customer?.email || ''
      const customer = ctx.customer ?? (await findCustomerByContact(ctx.org.id, phone, email))
      if (!customer) return { error: 'I could not find a customer record for that phone/email.' }
      const bookings = await db.booking.findMany({
        where: { orgId: ctx.org.id, customerId: customer.id, startAt: { gte: new Date() }, status: { in: ['pending', 'confirmed'] } },
        orderBy: { startAt: 'asc' },
        include: { service: true },
      })
      return {
        customer: customer.name,
        upcoming: bookings.map((b) => ({ id: b.id, service: b.service.name, start: b.startAt.toISOString(), status: b.status })),
      }
    },
  },
  {
    name: 'cancel_booking',
    description: 'Cancel one appointment by its booking id (from my_bookings). Only with customer identity matched.',
    args: { booking_id: 'booking id from my_bookings', reason: 'why it is cancelled' },
    execute: async (args, ctx) => {
      const bookingId = str(args, 'booking_id')
      const reason = str(args, 'reason') || 'cancelled at customer request'
      const phone = ctx.customer?.phone || ''
      const email = ctx.customer?.email || ''
      const customer = ctx.customer ?? (await findCustomerByContact(ctx.org.id, phone, email))
      if (!customer) return { error: 'For safety I can only cancel when I can match your phone or email on file.' }
      const booking = await db.booking.findFirst({ where: { id: bookingId, orgId: ctx.org.id } })
      if (!booking) return { error: 'No booking found with that id.' }
      if (booking.customerId !== customer.id) return { error: 'That booking does not belong to you, so I cannot cancel it.' }
      await cancelBooking(ctx.org.id, bookingId, reason, ctx.actor)
      return { success: true, booking_id: bookingId, cancelled: true }
    },
  },
  {
    name: 'search_knowledge',
    description: 'Search approved business FAQs and documents. Answer policy questions ONLY from these results.',
    args: { query: 'what to look up' },
    execute: async (args, ctx) => {
      const query = str(args, 'query')
      if (!query) return { error: 'Empty query.' }
      const hits = await searchKnowledge(ctx.org.id, query, 4)
      if (hits.length === 0) return { found: false, note: 'Nothing in approved knowledge covers this.' }
      return { found: true, excerpts: hits.map((h) => ({ source: h.docTitle, text: h.text.slice(0, 500) })) }
    },
  },
  {
    name: 'payment_claim',
    description: 'Record that a customer CLAIMS they paid an invoice. This NEVER marks it paid — staff verify it. Be honest about that.',
    args: { invoice_number: 'e.g. INV-2025-0001', amount_cents: 'claimed amount in cents', method: 'card/bank/cash/other', reference: 'transaction reference if given' },
    execute: async (args, ctx) => {
      const invoiceNumber = str(args, 'invoice_number')
      const amountRaw = args.amount_cents
      const amount = typeof amountRaw === 'number' ? amountRaw : parseInt(str(args, 'amount_cents') || '0', 10)
      const method = str(args, 'method') || 'unspecified'
      const reference = str(args, 'reference')
      if (!invoiceNumber || !Number.isInteger(amount) || amount <= 0) {
        return { error: 'I need the invoice number and the amount.' }
      }
      const invoice = await db.invoice.findFirst({ where: { orgId: ctx.org.id, number: invoiceNumber } })
      if (!invoice) return { error: `No invoice found with number ${invoiceNumber}.` }
      const { payment } = await recordPaymentClaim(
        ctx.org.id,
        { invoiceId: invoice.id, amountCents: amount, method, reference, note: `Claimed in conversation ${ctx.conversationId}` },
        ctx.actor
      )
      return {
        recorded: true,
        payment_status: payment.status,
        invoice_status: invoice.status,
        note: 'The claim was recorded for staff verification. The invoice is NOT settled yet.',
      }
    },
  },
  {
    name: 'take_message',
    description: 'Save a message for the business staff when you cannot help or the request needs a human.',
    args: { text: 'the message content' },
    execute: async (args, ctx) => {
      const text = str(args, 'text')
      if (!text) return { error: 'Empty message.' }
      await db.message.create({
        data: { conversationId: ctx.conversationId, orgId: ctx.org.id, role: 'system', content: `📝 Message for staff: ${text}` },
      })
      await audit({ orgId: ctx.org.id, actorType: 'ai', actorId: 'receptionist', action: 'conversation.message_taken', entity: 'conversation', entityId: ctx.conversationId, meta: { text: text.slice(0, 300) } })
      return { saved: true }
    },
  },
  {
    name: 'escalate',
    description: 'Hand the conversation to a human. Use for anything uncertain, sensitive, or beyond your tools.',
    args: { reason: 'why a human is needed' },
    execute: async (args, ctx) => {
      const reason = str(args, 'reason') || 'assistant requested handoff'
      await db.conversation.update({ where: { id: ctx.conversationId }, data: { status: 'waiting_human' } })
      await audit({ orgId: ctx.org.id, actorType: 'ai', actorId: 'receptionist', action: 'conversation.escalated', entity: 'conversation', entityId: ctx.conversationId, meta: { reason } })
      return { escalated: true }
    },
  },
]

/* ---------------- prompt & protocol ---------------- */

function buildSystemPrompt(org: Organization, ctx: ToolCtx): string {
  const now = new Date()
  const tools = TOOLS.map((t) => `- ${t.name}: ${t.description}${Object.keys(t.args).length ? ` (args: ${Object.entries(t.args).map(([k, v]) => `${k} — ${v}`).join('; ')})` : ''}`).join('\n')
  return [
    `You are the AI receptionist for "${org.name}" — a ${org.businessType.replace('_', ' ')} business. Current date/time: ${now.toISOString()} (${org.timezone}).`,
    `Tone: ${parseJson<import('@/lib/org').AiIdentity>(org.aiIdentity, {}).businessTone ?? 'professional and warm'}. Respond in the customer's language (default ${org.locale}).`,
    ``,
    `ABSOLUTE RULES:`,
    `- NEVER invent prices, availability, policies, or payment status. Use your tools for real data.`,
    `- NEVER claim a booking, payment, or cancellation succeeded unless the tool result explicitly says so.`,
    `- If a tool returns an error, tell the customer honestly what failed and offer alternatives.`,
    `- A customer saying "I already paid" is only a CLAIM: record it with payment_claim and clearly say staff will verify it.`,
    `- For questions about policies (hours, cancellation, parking...), call search_knowledge first.`,
    `- If you cannot help, take a message or escalate to a human.`,
    ``,
    `OUTPUT PROTOCOL — respond with STRICT JSON only, no markdown, no extra text:`,
    `{"action":"tool","tool":"<tool_name>","args":{...}}  — to call a tool`,
    `{"action":"reply","message":"<your reply to the customer>"}  — to answer the customer`,
    `You may call at most one tool per turn. After tool results arrive, continue.`,
    ``,
    `AVAILABLE TOOLS:`,
    tools,
  ].join('\n')
}

function extractJson(raw: string): { action: string; tool?: string; args?: Record<string, unknown>; message?: string } | null {
  const cleaned = raw.replace(/```json|```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1))
    if (parsed && typeof parsed === 'object' && typeof (parsed as { action?: unknown }).action === 'string') {
      return parsed as { action: string; tool?: string; args?: Record<string, unknown>; message?: string }
    }
  } catch {
    /* fall through */
  }
  return null
}

export type TurnResult = {
  reply: string
  toolCalls: Array<{ tool: string; ok: boolean; summary: string }>
  aiUsed: boolean
  error?: string
}

/**
 * Run one assistant turn: retrieve context → LLM tool loop → validated tool execution →
 * persist customer + final assistant messages. The LLM only chooses tools; every state
 * change goes through validated business services.
 */
export async function handleReceptionistTurn(
  org: Organization,
  conversationId: string,
  userMessage: string,
  opts: { skipInboundPersist?: boolean } = {}
): Promise<TurnResult> {
  const conversation = await db.conversation.findFirst({ where: { id: conversationId, orgId: org.id } })
  if (!conversation) throw new Error('Conversation not found')

  const customer = conversation.customerId
    ? await db.customer.findFirst({ where: { id: conversation.customerId, orgId: org.id } })
    : null
  const ctx: ToolCtx = {
    org,
    conversationId,
    customer: customer ? { id: customer.id, name: customer.name, phone: customer.phone, email: customer.email } : null,
    actor: { type: 'ai', id: 'receptionist' },
  }

  if (!opts.skipInboundPersist) {
    await db.message.create({ data: { conversationId, orgId: org.id, role: 'customer', content: userMessage } })
  }

  const history = await db.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' }, take: 24 })
  const llmMessages: LlmMessage[] = [
    { role: 'system', content: buildSystemPrompt(org, ctx) },
    ...history
      .filter((m) => m.role === 'customer' || m.role === 'assistant')
      .map((m) => ({ role: m.role === 'customer' ? ('user' as const) : ('assistant' as const), content: m.content })),
  ]

  const toolCalls: TurnResult['toolCalls'] = []
  let finalReply = ''
  let aiError: string | undefined

  try {
    let lastRaw = ''
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const result = await chatComplete(org.id, llmMessages, { temperature: 0.3, conversationId })
      lastRaw = result.content
      const parsed = extractJson(result.content)

      if (!parsed) {
        finalReply = result.content.trim().slice(0, 2000)
        break
      }

      // Protocol-tolerant dispatch. Models occasionally violate the documented shape —
      // e.g. {"action":"search_knowledge","args":{...}} (tool name in `action`) — and a
      // strict parser turns that into an opaque non-answer. Accept the known variants.
      if (parsed.action === 'reply') {
        finalReply = (parsed.message ?? '').slice(0, 2000)
        break
      }

      const toolName =
        typeof parsed.tool === 'string' && parsed.tool.trim()
          ? parsed.tool.trim()
          : TOOLS.some((t) => t.name === parsed.action)
            ? parsed.action
            : ''

      if (parsed.action === 'tool' || toolName) {
        const tool = TOOLS.find((t) => t.name === toolName)
        if (!tool) {
          llmMessages.push({ role: 'assistant', content: result.content })
          llmMessages.push({ role: 'user', content: `TOOL_ERROR: unknown tool "${parsed.tool}". Available: ${TOOLS.map((t) => t.name).join(', ')}` })
          continue
        }
        let toolResult: unknown
        let ok = true
        try {
          toolResult = await tool.execute(parsed.args ?? {}, ctx)
        } catch (err) {
          ok = false
          toolResult = { error: err instanceof Error ? err.message : 'Tool execution failed' }
        }
        const summary = JSON.stringify(toolResult).slice(0, 300)
        toolCalls.push({ tool: tool.name, ok, summary })
        llmMessages.push({ role: 'assistant', content: result.content })
        llmMessages.push({ role: 'user', content: `TOOL_RESULT(${tool.name}): ${JSON.stringify(toolResult).slice(0, 3000)}` })
        continue
      }

      finalReply = (parsed.message ?? '').slice(0, 2000)
      break
    }

    if (!finalReply && toolCalls.length >= MAX_TOOL_ROUNDS) {
      finalReply = 'I had trouble completing that request. A staff member will follow up shortly.'
      await db.conversation.update({ where: { id: conversationId }, data: { status: 'waiting_human' } })
    }
    if (!finalReply) {
      // Observability: never swallow the raw model output silently — log it (sanitized) so
      // protocol violations are diagnosable instead of producing an opaque fallback reply.
      console.warn(`[receptionist] empty finalReply (conversation ${conversationId}); raw model output: ${JSON.stringify(lastRaw).slice(0, 500)}`)
    }
  } catch (err) {
    aiError = err instanceof Error ? err.message : 'AI unavailable'
    finalReply =
      `I'm sorry — the AI assistant is currently unavailable (${aiError.slice(0, 160)}). ` +
      `Your message has been received and a staff member can pick it up in the inbox. You can also book directly from the Bookings page.`
    await db.conversation.update({ where: { id: conversationId }, data: { status: 'waiting_human' } })
  }

  if (!finalReply) finalReply = 'Could you tell me a bit more about what you need?'

  await db.message.create({
    data: {
      conversationId,
      orgId: org.id,
      role: 'assistant',
      content: finalReply,
      meta: JSON.stringify({ toolCalls: toolCalls.map((t) => ({ tool: t.tool, ok: t.ok })), aiError }),
    },
  })
  await db.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } })

  return { reply: finalReply, toolCalls, aiUsed: !aiError, error: aiError }
}

export const REALTIME_TOOLS = TOOLS.map((t) => ({
  type: 'function',
  name: t.name,
  description: t.description,
  parameters: {
    type: 'object',
    properties: Object.fromEntries(Object.keys(t.args).map((k) => [k, { type: 'string', description: t.args[k] }])),
    required: Object.keys(t.args),
  },
}))

export async function runReceptionistTool(
  org: Organization,
  conversationId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const conversation = await db.conversation.findFirst({ where: { id: conversationId, orgId: org.id } })
  if (!conversation) throw new Error('Conversation not found')
  const customer = conversation.customerId
    ? await db.customer.findFirst({ where: { id: conversation.customerId, orgId: org.id } })
    : null
  const ctx: ToolCtx = {
    org,
    conversationId,
    customer: customer ? { id: customer.id, name: customer.name, phone: customer.phone, email: customer.email } : null,
    actor: { type: 'ai', id: 'receptionist' },
  }
  const tool = TOOLS.find((t) => t.name === toolName)
  if (!tool) return { error: `Unknown tool ${toolName}` }
  return await tool.execute(args || {}, ctx)
}
