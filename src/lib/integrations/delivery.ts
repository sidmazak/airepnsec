import { db } from '@/lib/db'

/**
 * Provider delivery receipts (DLR).
 *
 * A 2xx from a carrier only means "accepted for delivery". Real handset
 * outcomes arrive later on a provider callback and are applied to the outbox
 * row by provider message id. We never invent a delivered state.
 */

export type DeliveryState = 'accepted' | 'delivered' | 'read' | 'failed'

const RANK: Record<DeliveryState, number> = { accepted: 1, delivered: 2, read: 3, failed: 4 }

/** Map Twilio/Meta/carrier vocabulary onto one honest internal state. */
export function normalizeDeliveryStatus(raw: string): DeliveryState | null {
  const value = (raw || '').trim().toLowerCase()
  if (!value) return null
  if (/undeliver|fail|reject|expire|error|abort|cancel|blocked/.test(value)) return 'failed'
  if (/\bread\b|seen/.test(value)) return 'read'
  if (/deliver/.test(value)) return 'delivered'
  if (/sent|accept|queue|submit|pending|dispatch|scheduled/.test(value)) return 'accepted'
  return null
}

/** Keep the furthest receipt we have seen; a late "sent" must not erase "delivered". */
export function isNewerDeliveryState(current: string, next: DeliveryState): boolean {
  if (!current) return true
  const currentRank = RANK[current as DeliveryState]
  if (!currentRank) return true
  return RANK[next] >= currentRank
}

export async function applyDeliveryReceipt(input: {
  orgId: string
  providerKind?: string
  providerMessageId: string
  rawStatus: string
  detail?: string
}): Promise<{ updated: number; state: DeliveryState | null }> {
  const state = normalizeDeliveryStatus(input.rawStatus)
  const providerMessageId = input.providerMessageId.trim()
  if (!state || !providerMessageId) return { updated: 0, state }

  const rows = await db.outboxMessage.findMany({
    where: {
      orgId: input.orgId,
      providerMessageId,
      ...(input.providerKind ? { providerKind: input.providerKind } : {}),
    },
    select: { id: true, deliveryStatus: true },
    take: 20,
  })

  let updated = 0
  for (const row of rows) {
    if (!isNewerDeliveryState(row.deliveryStatus, state)) continue
    const detail = (input.detail ?? '').trim().slice(0, 300)
    await db.outboxMessage.update({
      where: { id: row.id },
      data: {
        deliveryStatus: state,
        deliveryDetail: detail,
        deliveryUpdatedAt: new Date(),
        ...(state === 'failed'
          ? { status: 'failed', statusReason: detail || 'The provider reported that this message was not delivered.' }
          : {}),
      },
    })
    updated++
  }
  return { updated, state }
}

/**
 * Persist a direct (non-outbox) send so later DLR callbacks can still resolve
 * it. The row is created already "sent" because the provider accepted it; it is
 * delivery history, not a queued message.
 */
export async function recordDirectDelivery(input: {
  orgId: string
  channel: 'sms' | 'whatsapp'
  recipient: string
  body: string
  providerKind: string
  providerMessageId: string
  relatedType?: string
  relatedId?: string
}): Promise<void> {
  if (!input.providerMessageId.trim()) return
  try {
    await db.outboxMessage.create({
      data: {
        orgId: input.orgId,
        channel: input.channel,
        recipient: input.recipient,
        body: input.body.slice(0, 4000),
        status: 'sent',
        sentAt: new Date(),
        providerKind: input.providerKind,
        providerMessageId: input.providerMessageId,
        deliveryStatus: 'accepted',
        deliveryUpdatedAt: new Date(),
        relatedType: input.relatedType ?? '',
        relatedId: input.relatedId ?? '',
        dedupeKey: `direct:${input.orgId}:${input.providerKind}:${input.providerMessageId}`,
      },
    })
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') {
      console.error('[delivery] could not record direct send:', err instanceof Error ? err.message : err)
    }
  }
}
