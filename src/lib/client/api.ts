'use client'

/**
 * Shared frontend API client.
 * - always same-origin relative URLs
 * - attaches the CSRF header required for mutations
 * - typed JSON + consistent error shape
 */

export class ApiClientError extends Error {
  status: number
  code?: string
  extra?: Record<string, unknown>
  constructor(status: number, message: string, code?: string, extra?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

async function handle<T>(res: Response): Promise<T> {
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; code?: string }
    throw new ApiClientError(res.status, b.error ?? `Request failed (${res.status})`, b.code, body as Record<string, unknown>)
  }
  return body as T
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } })
  return handle<T>(res)
}

export async function apiSend<T>(path: string, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'ais' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return handle<T>(res)
}

export const api = {
  get: apiGet,
  post: <T>(path: string, body?: unknown) => apiSend<T>(path, 'POST', body),
  put: <T>(path: string, body?: unknown) => apiSend<T>(path, 'PUT', body),
  patch: <T>(path: string, body?: unknown) => apiSend<T>(path, 'PATCH', body),
  delete: <T>(path: string) => apiSend<T>(path, 'DELETE'),
}

/* ---------------- shared API types (mirror docs/API.md) ---------------- */

export type SessionInfo = {
  needsSetup?: boolean
  authenticated: boolean
  user?: { id: string; name: string; email: string; role: string }
  org?: {
    id: string; name: string; slug: string; demo: boolean; setupComplete: boolean
    dataMode: string; timezone: string; currency: string; businessType: string
  }
  demoAvailable?: boolean
}

export type Customer = {
  id: string; name: string; email: string; phone: string; notes: string
  tags: string[]; optOut: boolean; consentContact: boolean; createdAt: string
}

export type Service = {
  id: string; name: string; description: string; category: string
  durationMin: number; priceCents: number; bufferBeforeMin: number; bufferAfterMin: number
  maxPerSlot: number; requiresDeposit: boolean; depositCents: number; active: boolean
}

export type Staff = {
  id: string; name: string; role: string; email: string; phone: string; active: boolean
  serviceIds?: string[]
  workingHours?: Array<{ dow: number; startMin: number; endMin: number }>
}

export type Booking = {
  id: string; customerId: string; serviceId: string; staffId: string | null
  startAt: string; endAt: string; status: string; source: string; notes: string
  priceCents: number; customer?: { name: string }; service?: { name: string }; staff?: { name: string | null }
}

export type Invoice = {
  id: string; number: string; customerId: string; status: string; currency: string
  subtotalCents: number; taxCents: number; totalCents: number; paidCents: number
  issueDate: string; dueDate: string; notes: string
  customer?: { name: string }
  items?: Array<{ id: string; description: string; qty: number; unitPriceCents: number; totalCents: number }>
  payments?: Payment[]
  outstandingCents?: number
}

export type Payment = {
  id: string; invoiceId: string; amountCents: number; method: string; reference: string
  status: string; source: string; note: string; createdAt: string; verifiedAt: string | null
  invoice?: { number: string; totalCents: number; paidCents: number }
  customerName?: string
}

export type LedgerEntryRow = {
  id: string; ts: string; type: string; debitAccount: string; creditAccount: string
  amountCents: number; invoiceId: string | null; paymentId: string | null; memo: string; reversalOfId: string | null
}

export type KnowledgeDocRow = {
  id: string; title: string; content: string; approved: boolean; tags: string[]
  source: string; chunkCount?: number; updatedAt: string
}

export type ConversationRow = {
  id: string; channel: string; status: string; aiEnabled: boolean; contactName: string
  customerId: string | null; updatedAt: string
  lastMessage?: { content: string; role: string; createdAt: string }
  customer?: { name: string } | null
}

export type MessageRow = {
  id: string; role: 'customer' | 'assistant' | 'agent' | 'system'; content: string
  meta: string; createdAt: string
}

export type ProviderConfigPublic = {
  id: string; capability: string; provider: string; label: string; baseUrl: string; model: string
  enabled: boolean; apiKeyPresent: boolean; config: Record<string, unknown>
  lastTestAt: string | null; lastTestOk: boolean; lastTestError: string; processesDataWhere: string
}

export type Automation = {
  id: string; name: string; description: string; enabled: boolean; testMode: boolean
  triggerType: string; triggerCfg: string; conditions: string; delayMinutes: number
  actions: string; maxRunsPerDay: number; quietHours: string
  runs?: AutomationRun[]
}

export type AutomationRun = {
  id: string; status: string; attempt: number; dedupeKey: string; input: string; output: string
  error: string; scheduledFor: string; startedAt: string; finishedAt: string | null
}

export type OutboxRow = {
  id: string; channel: string; recipient: string; subject: string; body: string
  status: string; statusReason: string; relatedType: string; createdAt: string; sentAt: string | null
  html?: string; attempts?: number; relatedId?: string
}

/**
 * Public integration row (secrets never returned by the API).
 * `configured` means credentials exist server-side; `enabled` means the
 * dispatcher may actively use it. See docs/API.md.
 */
export type IntegrationInfo = {
  id: string; kind: string; label: string
  config: Record<string, unknown>
  configured: boolean; enabled: boolean
  lastTestAt: string | null; lastTestOk: boolean; lastTestError: string
  createdAt: string
}

export type OutboxDispatchStats = {
  processed: number; sent: number; failed: number; waiting: number
}

export type IntegrationTestResult = { ok: boolean; detail: string }

export type DataSourceKindInfo = {
  kind: string
  label: string
  connectionSummary: string
  secretFields: Array<{ key: string; label: string; placeholder: string; required: boolean }>
  configHints: { queryLabel: string; queryHint: string; idColumnHint: string }
  requiresDriver?: string
  notes: string
}

export type DataSourceRow = {
  id: string
  name: string
  kind: string
  config: Record<string, unknown>
  configured: boolean
  enabled: boolean
  autoSync: boolean
  syncIntervalMin: number
  lastTestAt: string | null
  lastTestOk: boolean
  lastTestError: string
  lastSyncAt: string | null
  lastSyncOk: boolean
  lastSyncError: string
  lastSyncStats: Record<string, number>
  documentCount: number
  chunkCount: number
  createdAt: string
}

export type DataSourceTestResult = {
  ok: boolean
  message: string
  latencyMs: number
  rowCount?: number
  columns?: string[]
  preview?: Array<Record<string, unknown>>
}

export type DataSourceSyncResult = {
  ok: boolean
  result: { ok: boolean; stats: Record<string, number>; documentCount: number; chunkCount: number }
  message: string
}

export type AuditRow = {
  id: string; ts: string; actorType: string; actorId: string; action: string
  entity: string; entityId: string; meta: string
}

export type ReadinessItem = { key: string; label: string; ok: boolean; detail?: string }

export function formatMoney(cents: number, currency = 'USD'): string {
  return `${currency} ${(cents / 100).toFixed(2)}`
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
