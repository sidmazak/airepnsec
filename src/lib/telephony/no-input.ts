/**
 * Consecutive no-input counter per Twilio CallSid. Shared by the gather and status
 * routes so a finished call can always clear its counter (no unbounded growth).
 * Worst case after a process restart: one extra reprompt.
 */
const misses = new Map<string, number>()

export function bumpNoInput(callSid: string): number {
  const next = (misses.get(callSid) ?? 0) + 1
  misses.set(callSid, next)
  return next
}

export function resetNoInput(callSid: string): void {
  misses.delete(callSid)
}

export function noInputCount(callSid: string): number {
  return misses.get(callSid) ?? 0
}
