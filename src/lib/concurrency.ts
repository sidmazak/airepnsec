import os from 'node:os'
import { db } from '@/lib/db'
import { randomToken } from '@/lib/crypto'

/**
 * Two coordination primitives used by the runtime:
 *
 * 1. `withConversationTurnLock` serializes receptionist turns for ONE
 *    conversation. Two SMS arriving together (or a web-chat double send) must not
 *    interleave tool calls and produce out-of-order replies. The lock lives in
 *    the database so it also holds across multiple app instances.
 *
 * 2. `runWithWorkerLease` makes background work single-flight across instances.
 *    Automation ticks, outbox delivery and data-source sync must run exactly once
 *    per interval — a lease row with a TTL recovers automatically after a crash.
 *
 * Both are best-effort but never silently fake success: when a lock cannot be
 * acquired the caller gets an explicit busy result.
 */

const TURN_LOCK_TTL_MS = 5 * 60_000
const TURN_LOCK_WAIT_MS = 20_000
const TURN_LOCK_RETRY_MS = 250

export class ConversationBusyError extends Error {
  code = 'conversation_busy'
  constructor() {
    super('Another reply is already being generated for this conversation. Please wait a moment.')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run `fn` while holding the per-conversation turn lock.
 * Stale locks (a crashed process) are taken over after TURN_LOCK_TTL_MS.
 */
export async function withConversationTurnLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const token = `turn:${os.hostname()}:${process.pid}:${randomToken(9)}`
  const deadline = Date.now() + TURN_LOCK_WAIT_MS
  let acquired = false

  while (Date.now() < deadline) {
    const staleBefore = new Date(Date.now() - TURN_LOCK_TTL_MS)
    const res = await db.conversation.updateMany({
      where: {
        id: conversationId,
        OR: [{ turnLockedAt: null }, { turnLockedAt: { lt: staleBefore } }],
      },
      data: { turnLockToken: token, turnLockedAt: new Date() },
    })
    if (res.count === 1) {
      acquired = true
      break
    }
    await sleep(TURN_LOCK_RETRY_MS)
  }

  if (!acquired) throw new ConversationBusyError()

  try {
    return await fn()
  } finally {
    // Only release our own lock (a stale takeover may now belong to someone else).
    await db.conversation
      .updateMany({ where: { id: conversationId, turnLockToken: token }, data: { turnLockToken: '', turnLockedAt: null } })
      .catch(() => undefined)
  }
}

/* ------------------------------------------------------------------ */
/* background workers                                                  */
/* ------------------------------------------------------------------ */

export const WORKER_NAMES = ['automation', 'outbox', 'datasources'] as const
export type WorkerName = (typeof WORKER_NAMES)[number]

const WORKER_DEFAULT_TTL_MS: Record<WorkerName, number> = {
  automation: 5 * 60_000,
  outbox: 2 * 60_000,
  datasources: 15 * 60_000,
}

function envFlag(name: string): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase()
  if (!raw) return true
  return !['0', 'false', 'off', 'no', 'disabled'].includes(raw)
}

/**
 * Worker switches for split deployments. Example: run the web tier with
 * `AIS_DISABLE_WORKERS=1` and a dedicated worker tier with all three enabled.
 * Per-worker overrides: AIS_WORKER_AUTOMATION / _OUTBOX / _DATASOURCES.
 */
export function isWorkerEnabled(name: WorkerName): boolean {
  if (!envFlag('AIS_DISABLE_WORKERS')) return false
  const key = `AIS_WORKER_${name.toUpperCase()}`
  return envFlag(key)
}

export type WorkerLeaseResult<T> = { ran: true; result: T } | { ran: false; reason: 'busy' }

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === 'P2002')
}

/**
 * Single-flight execution across instances. The lease row is created atomically;
 * competing instances get `{ran:false}`. A crashed holder is recovered after the
 * TTL, so a worker is delayed at most one TTL — never permanently stuck.
 */
export async function runWithWorkerLease<T>(
  name: WorkerName | `datasource:${string}`,
  fn: () => Promise<T>,
  ttlMs?: number
): Promise<WorkerLeaseResult<T>> {
  const holder = `worker:${os.hostname()}:${process.pid}:${randomToken(6)}`
  const ttl = ttlMs ?? (name in WORKER_DEFAULT_TTL_MS ? WORKER_DEFAULT_TTL_MS[name as WorkerName] : 15 * 60_000)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttl)

  const reclaimed = await db.workerLease.updateMany({
    where: { name, expiresAt: { lt: now } },
    data: { holder, expiresAt },
  })

  if (reclaimed.count === 0) {
    try {
      await db.workerLease.create({ data: { name, holder, expiresAt } })
    } catch (err) {
      if (isUniqueViolation(err)) return { ran: false, reason: 'busy' }
      throw err
    }
  }

  try {
    const result = await fn()
    await db.workerLease
      .updateMany({
        where: { name, holder },
        data: { lastRunAt: new Date(), lastError: '', expiresAt: new Date(0) },
      })
      .catch(() => undefined)
    return { ran: true, result }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db.workerLease
      .updateMany({
        where: { name, holder },
        data: { lastRunAt: new Date(), lastError: message.slice(0, 500), expiresAt: new Date(0) },
      })
      .catch(() => undefined)
    throw err
  }
}

export type WorkerStatus = {
  name: WorkerName
  enabled: boolean
  running: boolean
  holder: string
  lastRunAt: string | null
  lastError: string
  leaseExpiresAt: string | null
}

/** Diagnostics view for the three built-in background workers. */
export async function getWorkerStatuses(): Promise<WorkerStatus[]> {
  const rows = await db.workerLease.findMany({ where: { name: { in: [...WORKER_NAMES] } } })
  const byName = new Map(rows.map((r) => [r.name, r]))
  const now = Date.now()
  return WORKER_NAMES.map((name) => {
    const row = byName.get(name)
    return {
      name,
      enabled: isWorkerEnabled(name),
      running: Boolean(row && row.expiresAt.getTime() > now),
      holder: row?.holder ?? '',
      lastRunAt: row?.lastRunAt ? row.lastRunAt.toISOString() : null,
      lastError: row?.lastError ?? '',
      leaseExpiresAt: row?.expiresAt && row.expiresAt.getTime() > now ? row.expiresAt.toISOString() : null,
    }
  })
}
