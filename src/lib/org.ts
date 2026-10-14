import { db } from '@/lib/db'

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    const parsed = JSON.parse(value)
    return (parsed ?? fallback) as T
  } catch {
    return fallback
  }
}

export type OpeningHours = Record<string, Array<[string, string]>> // dow ("0".."6") -> windows

export type OrgPolicies = {
  cancellation?: { minHoursBefore?: number; feePercent?: number }
  deposit?: { requiredForBooking?: boolean }
  quietHours?: { start?: string; end?: string }
  autoConfirmBookings?: boolean
}

export type AiIdentity = {
  businessTone?: 'professional' | 'friendly' | 'concise'
  greeting?: string
  closing?: string
  escalationNote?: string
  languages?: string[]
}

export type CollectionsCfg = {
  reminderDays?: number[] // e.g. [1, 3, 7] days after due
  maxTouchesPerInvoice?: number
  quietStart?: string
  quietEnd?: string
  templates?: { first?: string; second?: string; final?: string }
}

export async function getOrgField<T>(orgId: string, field: 'openingHours' | 'policies' | 'aiIdentity' | 'collectionsCfg' | 'holidays', fallback: T): Promise<T> {
  const org = await db.organization.findUnique({ where: { id: orgId } })
  if (!org) return fallback
  return parseJson<T>((org as unknown as Record<string, string | null>)[field], fallback)
}

export async function updateOrgField(orgId: string, field: 'openingHours' | 'policies' | 'aiIdentity' | 'collectionsCfg', value: unknown): Promise<void> {
  await db.organization.update({ where: { id: orgId }, data: { [field]: JSON.stringify(value) } })
}

export async function getSetting<T>(orgId: string, key: string, fallback: T): Promise<T> {
  const s = await db.appSetting.findUnique({ where: { orgId_key: { orgId, key } } })
  return s ? parseJson<T>(s.value, fallback) : fallback
}

export async function setSetting(orgId: string, key: string, value: unknown): Promise<void> {
  await db.appSetting.upsert({
    where: { orgId_key: { orgId, key } },
    create: { orgId, key, value: JSON.stringify(value) },
    update: { value: JSON.stringify(value) },
  })
}
