/**
 * Pure PABX routing helpers. Kept free of Prisma/HTTP so the selection logic is
 * unit-testable: given configured agent lines, their database state (enabled /
 * accepting calls) and the active call load, pick the right agent line.
 */

export type AgentLine = { number: string; label: string; enabled: boolean }

export type LineStateRow = {
  id?: string
  phoneNumber: string
  enabled: boolean
  acceptingCalls: boolean
  priority: number
}

export type ActiveCallRow = { lineId: string }

export type LineCandidate = {
  number: string
  label: string
  load: number
  priority: number
  index: number
}

export function normalizeAgentLines(raw: unknown): AgentLine[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const row = item as Record<string, unknown>
      const number = typeof row.number === 'string' ? row.number.trim() : ''
      if (!number) return null
      const label = typeof row.label === 'string' && row.label.trim() ? row.label.trim() : number
      return { number, label, enabled: row.enabled !== false }
    })
    .filter((v): v is AgentLine => v !== null)
}

/**
 * Combine configured agent lines with their TelephonyLine rows. Lines without a
 * row are treated as enabled + accepting (the route creates the row on first use).
 * A line explicitly paused (`acceptingCalls=false`) or disabled is excluded.
 */
export function buildLineCandidates(
  lines: AgentLine[],
  lineStates: LineStateRow[],
  activeCalls: ActiveCallRow[]
): LineCandidate[] {
  const stateByNumber = new Map(lineStates.map((r) => [r.phoneNumber, r]))
  const numberByLineId = new Map(lineStates.filter((r) => r.id).map((r) => [r.id as string, r.phoneNumber]))
  const loadByNumber = new Map<string, number>()
  for (const call of activeCalls) {
    const number = numberByLineId.get(call.lineId)
    if (!number) continue
    loadByNumber.set(number, (loadByNumber.get(number) ?? 0) + 1)
  }

  const out: LineCandidate[] = []
  lines.forEach((line, index) => {
    if (!line.enabled) return
    const state = stateByNumber.get(line.number)
    if (state && (!state.enabled || !state.acceptingCalls)) return
    out.push({
      number: line.number,
      label: line.label,
      load: loadByNumber.get(line.number) ?? 0,
      priority: state?.priority ?? 100,
      index,
    })
  })
  return out
}

/** Least active calls first; ties go to lower priority (higher priority number), then config order. */
export function pickLeastBusy(candidates: LineCandidate[]): LineCandidate | null {
  if (candidates.length === 0) return null
  return [...candidates].sort((a, b) => a.load - b.load || a.priority - b.priority || a.index - b.index)[0]
}

/** Round-robin across currently eligible candidates. */
export function pickRoundRobin(candidates: LineCandidate[], lastIndex: number): LineCandidate | null {
  if (candidates.length === 0) return null
  const start = Number.isFinite(lastIndex) ? Math.floor(lastIndex) : -1
  return candidates[(start + 1 + candidates.length * 1000) % candidates.length]
}

/** `redirect` keeps a deterministic target (first eligible by priority, then config order). */
export function pickRedirect(candidates: LineCandidate[]): LineCandidate | null {
  if (candidates.length === 0) return null
  return [...candidates].sort((a, b) => a.priority - b.priority || a.index - b.index)[0]
}

/** Map Twilio call states onto our enum-like string (SQLite has no enums). */
export function normalizeCallStatus(raw: string): string {
  switch (raw) {
    case 'ringing':
    case 'queued':
      return 'started'
    case 'in-progress':
      return 'answered'
    case 'no-answer':
    case 'busy':
    case 'canceled':
      return 'missed'
    case 'failed':
      return 'failed'
    case 'completed':
      return 'completed'
    default:
      return raw || 'unknown'
  }
}
