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
