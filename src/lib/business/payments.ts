import { db } from '@/lib/db'
import { ApiError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { postEntry } from '@/lib/business/ledger'
import { recalcInvoiceStatus, invoiceOutstanding } from '@/lib/business/invoice'
import { hmacVerify } from '@/lib/crypto'
import { randomUUID } from 'node:crypto'

export type VerifiedPaymentInput = {
  invoiceId: string
  amountCents: number
  method?: string
  reference?: string
  source: 'manual' | 'webhook' | 'customer_claim'
  idempotencyKey?: string | null
  externalEventId?: string | null
  verifiedBy: string
}

/**
 * Record a VERIFIED payment idempotently. Duplicate idempotencyKey or externalEventId
 * returns the original payment without side effects (duplicate webhooks never double-count).
 */
export async function recordVerifiedPayment(orgId: string, input: VerifiedPaymentInput, actor: { type: 'user' | 'system' | 'webhook'; id: string }) {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ApiError(422, 'Payment amount must be a positive integer (cents)', 'amount')
  }

  if (input.idempotencyKey) {
    const existing = await db.payment.findFirst({ where: { idempotencyKey: input.idempotencyKey, orgId } })
    if (existing) return { payment: existing, duplicate: true }
    // The key is globally unique. If it belongs to another organisation the
    // caller is reusing someone else's key - refuse instead of handing back a
    // payment row that belongs to a different tenant.
    const foreign = await db.payment.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { orgId: true } })
    if (foreign) throw new ApiError(409, 'This idempotency key was already used for another record', 'idempotency_conflict')
  }
  if (input.externalEventId) {
    const existing = await db.payment.findFirst({ where: { externalEventId: input.externalEventId, orgId } })
    if (existing) return { payment: existing, duplicate: true }
    const foreign = await db.payment.findUnique({ where: { externalEventId: input.externalEventId }, select: { orgId: true } })
    if (foreign) throw new ApiError(409, 'This event id was already used for another record', 'idempotency_conflict')
  }

  const invoice = await db.invoice.findFirst({ where: { id: input.invoiceId, orgId } })
  if (!invoice) throw new ApiError(404, 'Invoice not found', 'not_found')
  if (invoice.status === 'void') throw new ApiError(409, 'Cannot pay a voided invoice', 'invoice_void')
  if (invoice.status === 'draft') throw new ApiError(409, 'Issue the invoice before recording payments', 'invoice_draft')

  const outstanding = invoiceOutstanding(invoice.totalCents, invoice.paidCents)
  if (input.amountCents > outstanding) {
    throw new ApiError(409, `Payment of ${input.amountCents} cents exceeds the outstanding balance of ${outstanding} cents`, 'overpay', {
      outstandingCents: outstanding,
    })
  }

  const payment = await db.$transaction(async (tx) => {
    const p = await tx.payment.create({
      data: {
        orgId,
        invoiceId: input.invoiceId,
        amountCents: input.amountCents,
        method: input.method ?? 'manual',
        reference: input.reference ?? '',
        status: 'verified',
        source: input.source,
        idempotencyKey: input.idempotencyKey ?? null,
        externalEventId: input.externalEventId ?? null,
        verifiedAt: new Date(),
        verifiedBy: input.verifiedBy,
      },
    })
    await tx.ledgerEntry.create({
      data: {
        orgId,
        type: 'payment',
        debitAccount: 'cash',
        creditAccount: 'accounts_receivable',
        amountCents: input.amountCents,
        invoiceId: input.invoiceId,
        paymentId: p.id,
        memo: `Payment for ${invoice.number} via ${input.method ?? 'manual'}${input.reference ? ` (ref ${input.reference})` : ''}`,
        createdBy: input.verifiedBy,
      },
    })
    return p
  })

  const { paidCents, status } = await recalcInvoiceStatus(orgId, input.invoiceId)
  await audit({
    orgId, actorType: actor.type, actorId: actor.id, action: 'invoice.payment_verified', entity: 'payment', entityId: payment.id,
    meta: { invoiceId: input.invoiceId, amountCents: input.amountCents, method: input.method, paidCents, invoiceStatus: status, source: input.source },
  })
  return { payment, duplicate: false, invoiceStatus: status, paidCents }
}

/**
 * A customer CLAIMS they paid. This never settles the invoice — it records a
 * pending_verification payment that an authorized human or a trusted webhook must verify.
 */
export async function recordPaymentClaim(
  orgId: string,
  input: { invoiceId: string; amountCents: number; method?: string; reference?: string; note?: string },
  actor: { type: 'user' | 'ai' | 'system'; id: string }
) {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ApiError(422, 'Claim amount must be a positive whole number of cents', 'amount')
  }
  const invoice = await db.invoice.findFirst({ where: { id: input.invoiceId, orgId } })
  if (!invoice) throw new ApiError(404, 'Invoice not found', 'not_found')
  if (invoice.status === 'void') throw new ApiError(409, 'Invoice is void', 'invoice_void')
  if (invoice.status === 'draft') throw new ApiError(409, 'Issue the invoice before recording claims', 'invoice_draft')

  const outstanding = invoiceOutstanding(invoice.totalCents, invoice.paidCents)
  if (outstanding <= 0) throw new ApiError(409, 'Invoice is already fully paid', 'already_paid')
  if (input.amountCents > outstanding) {
    throw new ApiError(409, `Claim of ${input.amountCents} cents exceeds the outstanding balance of ${outstanding} cents`, 'overpay', {
      outstandingCents: outstanding,
    })
  }

  const idempotencyKey = `claim:${input.invoiceId}:${input.amountCents}:${input.reference || Date.now()}`
  const existing = await db.payment.findFirst({ where: { idempotencyKey, orgId } })
  if (existing) return { payment: existing, duplicate: true }

  const payment = await db.payment.create({
    data: {
      orgId,
      invoiceId: input.invoiceId,
      amountCents: input.amountCents,
      method: input.method ?? 'unspecified',
      reference: input.reference ?? '',
      status: 'pending_verification',
      source: 'customer_claim',
      idempotencyKey,
      note: input.note ?? '',
    },
  })
  await audit({
    orgId, actorType: actor.type, actorId: actor.id, action: 'invoice.payment_claimed', entity: 'payment', entityId: payment.id,
    meta: { invoiceId: input.invoiceId, amountCents: input.amountCents, reference: input.reference ?? '' },
  })
  return { payment, duplicate: false }
}

export async function verifyPayment(orgId: string, paymentId: string, userId: string) {
  const payment = await db.payment.findFirst({ where: { id: paymentId, orgId } })
  if (!payment) throw new ApiError(404, 'Payment not found', 'not_found')
  if (payment.status === 'verified') return { payment, alreadyVerified: true }
  if (payment.status !== 'pending_verification') throw new ApiError(409, `Cannot verify a ${payment.status} payment`, 'not_verifiable')

  const invoice = await db.invoice.findFirst({ where: { id: payment.invoiceId, orgId } })
  if (!invoice) throw new ApiError(404, 'Invoice not found', 'not_found')
  if (invoice.status === 'void') throw new ApiError(409, 'Cannot verify payment on a voided invoice', 'invoice_void')
  if (invoice.status === 'draft') throw new ApiError(409, 'Issue the invoice before verifying payments', 'invoice_draft')

  const outstanding = invoiceOutstanding(invoice.totalCents, invoice.paidCents)
  if (payment.amountCents > outstanding) {
    throw new ApiError(
      409,
      `Payment of ${payment.amountCents} cents exceeds the outstanding balance of ${outstanding} cents — reject it or record the correct amount`,
      'overpay',
      { outstandingCents: outstanding }
    )
  }

  await db.payment.update({ where: { id: paymentId }, data: { status: 'verified', verifiedAt: new Date(), verifiedBy: userId } })
  await postEntry(orgId, {
    type: 'payment',
    debitAccount: 'cash',
    creditAccount: 'accounts_receivable',
    amountCents: payment.amountCents,
    invoiceId: invoice.id,
    paymentId: payment.id,
    memo: `Verified payment for ${invoice.number} (${payment.source})`,
    createdBy: userId,
  })
  const state = await recalcInvoiceStatus(orgId, invoice.id)
  await audit({ orgId, actorType: 'user', actorId: userId, action: 'invoice.payment_verified', entity: 'payment', entityId: paymentId, meta: { invoiceId: invoice.id, ...state } })
  return { payment: await db.payment.findUnique({ where: { id: paymentId } }), alreadyVerified: false, ...state }
}

export async function rejectPayment(orgId: string, paymentId: string, userId: string, reason: string) {
  const payment = await db.payment.findFirst({ where: { id: paymentId, orgId } })
  if (!payment) throw new ApiError(404, 'Payment not found', 'not_found')
  if (payment.status === 'verified') throw new ApiError(409, 'Payment already verified — record a refund instead', 'already_verified')
  if (payment.status === 'refunded' || payment.source === 'refund') throw new ApiError(409, 'This is a refund record and cannot be rejected', 'is_refund')
  const updated = await db.payment.update({ where: { id: paymentId }, data: { status: 'failed', note: reason } })
  await audit({ orgId, actorType: 'user', actorId: userId, action: 'invoice.payment_rejected', entity: 'payment', entityId: paymentId, meta: { reason } })
  return updated
}

/**
 * Refund a verified payment. The original payment stays verified; a linked
 * refund row (source='refund', status='refunded') plus a refund ledger entry
 * reduce paidCents. The unique idempotencyKey prevents a retried request from
 * refunding twice.
 */
export async function refundPayment(
  orgId: string,
  paymentId: string,
  input: { amountCents: number; reason?: string; idempotencyKey?: string },
  userId: string
) {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ApiError(422, 'Refund amount must be a positive integer (cents)', 'amount')
  }
  const payment = await db.payment.findFirst({
    where: { id: paymentId, orgId },
    include: { invoice: { select: { number: true } } },
  })
  if (!payment) throw new ApiError(404, 'Payment not found', 'not_found')
  if (payment.source === 'refund' || payment.status === 'refunded') {
    throw new ApiError(409, 'A refund cannot be refunded', 'is_refund')
  }
  if (payment.status !== 'verified') throw new ApiError(409, 'Only verified payments can be refunded', 'not_verified')

  const prefix = `refund:${payment.id}:`
  if (input.idempotencyKey) {
    const existing = await db.payment.findFirst({ where: { orgId, idempotencyKey: prefix + input.idempotencyKey } })
    if (existing) return { refund: existing, duplicate: true }
  }

  const idempotencyKey = prefix + (input.idempotencyKey ?? randomUUID())
  const refund = await db.$transaction(async (tx) => {
    const prior = await tx.payment.aggregate({
      where: { orgId, source: 'refund', status: 'refunded', idempotencyKey: { startsWith: prefix } },
      _sum: { amountCents: true },
    })
    const refundable = payment.amountCents - (prior._sum.amountCents ?? 0)
    if (refundable <= 0) throw new ApiError(409, 'This payment has already been fully refunded', 'already_refunded')
    if (input.amountCents > refundable) {
      throw new ApiError(409, `Refund of ${input.amountCents} cents exceeds the refundable balance of ${refundable} cents`, 'refund_overpay', {
        refundableCents: refundable,
      })
    }
    const row = await tx.payment.create({
      data: {
        orgId,
        invoiceId: payment.invoiceId,
        amountCents: input.amountCents,
        method: 'refund',
        reference: payment.reference,
        status: 'refunded',
        source: 'refund',
        idempotencyKey,
        note: input.reason ?? '',
        verifiedAt: new Date(),
        verifiedBy: userId,
      },
    })
    await tx.ledgerEntry.create({
      data: {
        orgId,
        type: 'refund',
        debitAccount: 'accounts_receivable',
        creditAccount: 'cash',
        amountCents: input.amountCents,
        invoiceId: payment.invoiceId,
        paymentId: payment.id,
        memo: `Refund for payment ${payment.id} on ${payment.invoice.number}${input.reason ? ` (${input.reason})` : ''}`,
        createdBy: userId,
      },
    })
    return row
  })

  const state = await recalcInvoiceStatus(orgId, payment.invoiceId)
  await audit({
    orgId,
    actorType: 'user',
    actorId: userId,
    action: 'invoice.payment_refunded',
    entity: 'payment',
    entityId: refund.id,
    meta: { originalPaymentId: payment.id, invoiceId: payment.invoiceId, amountCents: input.amountCents, reason: input.reason ?? '', ...state },
  })
  return { refund, duplicate: false, ...state }
}

/* ---------------- webhook verification ---------------- */

export async function getWebhookSecret(orgId: string): Promise<string> {
  const s = await db.appSetting.findUnique({ where: { orgId_key: { orgId, key: 'webhook_secret' } } })
  return s?.value ?? ''
}

export function verifyWebhookSignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false
  return hmacVerify(rawBody, signature, secret)
}

export type WebhookPayload = {
  eventId: string
  invoiceNumber: string
  amountCents: number
  method?: string
  reference?: string
}

export function parseWebhookPayload(raw: string): WebhookPayload {
  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw)
  } catch {
    throw new ApiError(400, 'Webhook body must be JSON', 'bad_json')
  }
  const eventId = typeof body.event_id === 'string' ? body.event_id : ''
  const invoiceNumber = typeof body.invoice_number === 'string' ? body.invoice_number : ''
  const amountCents = typeof body.amount_cents === 'number' ? body.amount_cents : -1
  if (!eventId || !invoiceNumber || !Number.isInteger(amountCents) || amountCents <= 0) {
    throw new ApiError(422, 'Webhook payload requires event_id, invoice_number, and a positive integer amount_cents', 'bad_payload')
  }
  return {
    eventId,
    invoiceNumber,
    amountCents,
    method: typeof body.method === 'string' ? body.method : 'online',
    reference: typeof body.reference === 'string' ? body.reference : '',
  }
}

/**
 * Process a verified webhook: dedupes by eventId, then records the payment idempotently.
 *
 * Retry semantics matter here. Only a FINAL outcome ('processed' / 'duplicate') makes
 * an event terminal. A rejected or failed attempt stays retryable, so a provider that
 * re-delivers after a transient failure - or after a bogus unsigned attempt was
 * pre-recorded - still gets its payment booked instead of being answered 'duplicate'.
 * The payment itself is protected by the unique externalEventId, so a retry can never
 * double-count.
 */
export async function processWebhook(orgId: string, provider: string, payload: WebhookPayload, raw: string, signatureValid: boolean) {
  const existing = await db.webhookEvent.findUnique({ where: { eventId: payload.eventId } })
  if (existing && (existing.result === 'processed' || existing.result === 'duplicate')) {
    await db.webhookEvent.update({ where: { id: existing.id }, data: { result: 'duplicate' } })
    return { result: 'duplicate' as const, eventId: payload.eventId }
  }
  if (!signatureValid) {
    if (existing) {
      await db.webhookEvent.update({
        where: { id: existing.id },
        data: { orgId, provider, payload: raw.slice(0, 4000), signatureValid: false, result: 'rejected', processedAt: new Date() },
      })
    } else {
      await db.webhookEvent.create({
        data: { orgId, provider, eventId: payload.eventId, payload: raw.slice(0, 4000), signatureValid: false, result: 'rejected', processedAt: new Date() },
      })
    }
    await audit({ orgId, actorType: 'webhook', action: 'webhook.rejected', entity: 'webhook_event', meta: { provider, reason: 'invalid signature' } })
    return { result: 'rejected' as const, eventId: payload.eventId }
  }

  const invoice = await db.invoice.findFirst({ where: { orgId, number: payload.invoiceNumber } })
  const event = existing
    ? await db.webhookEvent.update({
        where: { id: existing.id },
        data: { orgId, provider, payload: raw.slice(0, 4000), signatureValid: true, result: 'received' },
      })
    : await db.webhookEvent.create({
        data: { orgId, provider, eventId: payload.eventId, payload: raw.slice(0, 4000), signatureValid: true, result: 'received' },
      })
  if (!invoice) {
    await db.webhookEvent.update({ where: { id: event.id }, data: { result: 'failed' } })
    throw new ApiError(404, `Invoice ${payload.invoiceNumber} not found`, 'invoice_not_found')
  }

  try {
    const { payment, duplicate } = await recordVerifiedPayment(
      orgId,
      {
        invoiceId: invoice.id,
        amountCents: payload.amountCents,
        method: payload.method ?? 'online',
        reference: payload.reference ?? '',
        source: 'webhook',
        externalEventId: payload.eventId,
        verifiedBy: 'webhook',
      },
      { type: 'webhook', id: provider }
    )

    await db.webhookEvent.update({
      where: { id: event.id },
      data: { result: duplicate ? 'duplicate' : 'processed', processedAt: new Date() },
    })
    return { result: duplicate ? ('duplicate' as const) : ('processed' as const), eventId: payload.eventId, paymentId: payment.id }
  } catch (err) {
    // The business effect failed. Mark the event as failed (NOT terminal) so the
    // provider's retry can try again instead of being answered 'duplicate'.
    await db.webhookEvent.update({ where: { id: event.id }, data: { result: 'failed' } })
    throw err
  }
}
