'use client'

import { formatCents } from '@/lib/money'

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
  delete: <T>(path: string, body?: unknown) => apiSend<T>(path, 'DELETE', body),
}

/* ---------------- streaming (SSE over POST) ---------------- */

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; tool: string; ok: boolean; summary: string }
  | { type: 'done'; conversationId: string; reply: string; toolCalls: Array<{ tool: string; ok: boolean; summary: string }>; aiUsed: boolean; nativeTools: boolean; error: string | null; skipped: string | null }
  | { type: 'error'; message: string }

export type StreamHandlers = {
  onDelta?: (text: string) => void
  onTool?: (info: { tool: string; ok: boolean; summary: string }) => void
  onDone?: (event: Extract<StreamEvent, { type: 'done' }>) => void
  onError?: (message: string) => void
}

/**
 * Consume a Server-Sent Events response from a POST endpoint.
 *
 * `EventSource` cannot POST, so the SSE frames are parsed off the fetch body
 * here. The server sends `data: {json}` frames; anything that is not valid JSON
 * is ignored rather than crashing the UI.
 */
export async function streamPost(path: string, body: unknown, handlers: StreamHandlers = {}): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-requested-with': 'ais' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      const data = (await res.json()) as { error?: string }
      if (data?.error) message = data.error
    } catch {
      /* not JSON */
    }
    handlers.onError?.(message)
    throw new ApiClientError(res.status, message)
  }
  if (!res.body) {
    handlers.onError?.('The server did not return a stream')
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue
        const raw = line.slice(5).trim()
        if (!raw) continue
        let event: StreamEvent
        try {
          event = JSON.parse(raw) as StreamEvent
        } catch {
          continue
        }
        if (event.type === 'delta') handlers.onDelta?.(event.text)
        else if (event.type === 'tool') handlers.onTool?.({ tool: event.tool, ok: event.ok, summary: event.summary })
        else if (event.type === 'done') handlers.onDone?.(event)
        else if (event.type === 'error') handlers.onError?.(event.message)
      }
    }
  }
}

/* ---------------- shared API types (mirror docs/API.md) ---------------- */

export type SessionInfo = {
  needsSetup?: boolean
  authenticated: boolean
  user?: { id: string; name: string; email: string; role: string }
  org?: {
    id: string; name: string; slug: string; demo: boolean; setupComplete: boolean
    dataMode: string; timezone: string; currency: string; businessType: string
    /** Runtime switch of the AI receptionist: running | paused | stopped. */
    receptionistStatus?: string
  }
  demoAvailable?: boolean
}

export type CustomerCommPrefs = {
  email: boolean; sms: boolean; whatsapp: boolean
  service: boolean; booking: boolean; invoice: boolean; reminder: boolean; marketing: boolean
}

export type Customer = {
  id: string; name: string; email: string; phone: string; notes: string
  tags: string[]; optOut: boolean; consentContact: boolean; commPrefs?: CustomerCommPrefs; createdAt: string
}

/** A catalog entry from the hardware/model probe. */
export type ModelRecommendation = {
  capability: 'llm' | 'embedding' | 'stt' | 'tts' | 'vision'
  model: string
  sizeGb: number
  minRamGb: number
  note: string
  fits: boolean
  reason: string
}

export type TeamMember = {
  id: string; email: string; name: string; role: 'owner' | 'admin' | 'agent' | 'viewer'
  active: boolean; twoFactorEnabled: boolean; lastLoginAt: string | null; createdAt: string
}

export type TeamInvite = {
  id: string; email: string; role: 'owner' | 'admin' | 'agent' | 'viewer'
  createdAt: string; expiresAt: string; acceptedAt: string | null; revokedAt: string | null
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
  /** Google Calendar: the OAuth consent flow completed (refresh token stored). */
  connected?: boolean
  lastTestAt: string | null; lastTestOk: boolean; lastTestError: string
  createdAt: string
}

export type OutboxDispatchStats = {
  processed: number; sent: number; failed: number; waiting: number; skipped: number
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
  return formatCents(cents, currency)
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
