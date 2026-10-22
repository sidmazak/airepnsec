/**
 * Money helpers. Money is ALWAYS an integer number of cents (see AGENTS.md) —
 * these helpers format cents for humans without ever introducing a float.
 */

/**
 * Format integer cents as a decimal amount using integer arithmetic only.
 * `formatCents(12345, 'USD')` -> "USD 123.45". No float division happens, so
 * very large amounts keep full precision.
 */
export function formatCents(cents: number, currency = 'USD'): string {
  const value = Math.trunc(Number.isFinite(cents) ? cents : 0)
  const negative = value < 0
  const abs = Math.abs(value)
  const major = Math.trunc(abs / 100)
  const minor = abs % 100
  return `${negative ? '-' : ''}${currency} ${major}.${String(minor).padStart(2, '0')}`
}

/** Decimal amount string ("123.45") built from integer cents — no float math. */
export function centsToDecimal(cents: number): string {
  const value = Math.trunc(Number.isFinite(cents) ? cents : 0)
  const negative = value < 0
  const abs = Math.abs(value)
  const major = Math.trunc(abs / 100)
  const minor = abs % 100
  return `${negative ? '-' : ''}${major}.${String(minor).padStart(2, '0')}`
}

/** Parse a decimal amount ("123.45", "123") into integer cents. Rejects junk. */
export function decimalToCents(input: string | number): number | null {
  const raw = typeof input === 'number' ? String(input) : String(input ?? '').trim()
  if (!raw || !/^-?\d+(\.\d{1,2})?$/.test(raw)) return null
  const negative = raw.startsWith('-')
  const [major, minor = ''] = raw.replace('-', '').split('.')
  const cents = Number(major) * 100 + Number(minor.padEnd(2, '0') || '0')
  if (!Number.isSafeInteger(cents)) return null
  return negative ? -cents : cents
}
