import { NextRequest, NextResponse } from 'next/server'
import { ZodSchema } from 'zod'
import { db } from '@/lib/db'
import { randomToken, sha256 } from '@/lib/crypto'
import type { Organization, User } from '@prisma/client'

export const SESSION_COOKIE = 'ais_session'
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14 // 14 days

export type ApiCtx = {
  user: User
  org: Organization
  role: string
}

type AuthOptions = {
  roles?: string[] // allowed roles; default any authenticated
  csrf?: boolean // default true for mutations
}

/* ---------------- responses ---------------- */

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data as Record<string, unknown>, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
}

export function fail(status: number, message: string, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error: message, ...(extra ?? {}) }, { status, headers: { 'cache-control': 'no-store' } })
}

export class ApiError extends Error {
  status: number
  code: string
  extra?: Record<string, unknown>
  constructor(status: number, message: string, code = 'error', extra?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

/* ---------------- cookies / session ---------------- */

function readCookie(req: NextRequest, name: string): string | null {
  return req.cookies.get(name)?.value ?? null
}

function signSessionToken(id: string, secret: string): string {
  return `${id}.${secret}`
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const id = randomToken(16)
  const secret = randomToken(32)
  const token = signSessionToken(id, secret)
  const tokenHash = sha256(token)
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  await db.session.create({ data: { id, userId, tokenHash, expiresAt } })
  return { token, expiresAt }
}

export function sessionCookie(token: string, expiresAt: Date): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Expires=${expiresAt.toUTCString()}${
    process.env.NODE_ENV === 'production' ? '; Secure' : ''
  }`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
}

async function loadSession(token: string): Promise<ApiCtx | null> {
  // token format: sessionRowId.secretPart — validated by hashing the presented
  // token and matching the unique tokenHash stored at creation time.
  const dot = token.indexOf('.')
  if (dot < 0) return null
  const session = await db.session.findUnique({ where: { tokenHash: sha256(token) } })
  if (!session || session.expiresAt < new Date()) return null
  const user = await db.user.findUnique({ where: { id: session.userId } })
  if (!user) return null
  const org = await db.organization.findUnique({ where: { id: user.orgId } })
  if (!org) return null
  return { user, org, role: user.role }
}

export async function getCtx(req: NextRequest): Promise<ApiCtx | null> {
  const token = readCookie(req, SESSION_COOKIE)
  if (!token) return null
  return loadSession(token)
}

/* ---------------- CSRF ---------------- */

function csrfOk(req: NextRequest): boolean {
  // Custom header cannot be attached cross-origin without a CORS preflight, and we
  // never answer preflights — combined with SameSite=Strict cookies this blocks CSRF.
  return req.headers.get('x-requested-with') === 'ais'
}

/* ---------------- rate limiting (in-memory sliding window) ---------------- */

type Bucket = { hits: number[] }
const buckets = new Map<string, Bucket>()

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const b = buckets.get(key) ?? { hits: [] }
  b.hits = b.hits.filter((t) => now - t < windowMs)
  if (b.hits.length >= limit) {
    buckets.set(key, b)
    return false
  }
  b.hits.push(now)
  buckets.set(key, b)
  if (buckets.size > 5000) {
    // opportunistic cleanup
    for (const [k, v] of buckets) if (v.hits.length === 0) buckets.delete(k)
  }
  return true
}

function clientIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local'
}

/* ---------------- validation ---------------- */

export async function parseBody<T>(req: NextRequest, schema: ZodSchema<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    throw new ApiError(400, 'Request body must be valid JSON', 'bad_json')
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new ApiError(
      422,
      `Invalid ${first.path.join('.') || 'body'}: ${first.message}`,
      'validation',
      { issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }
    )
  }
  return result.data
}

/* ---------------- route wrapper ---------------- */

export type Handler = (req: NextRequest, ctx: ApiCtx, params: Record<string, string>) => Promise<NextResponse>

export function withAuth(handler: Handler, options: AuthOptions = {}) {
  return async (req: NextRequest, route: { params: Promise<Record<string, string>> } | undefined) => {
    try {
      const url = new URL(req.url)
      const rlKey = `${clientIp(req)}:${url.pathname}`
      if (!rateLimit(rlKey, 120, 60_000)) return fail(429, 'Too many requests. Please slow down.')

      const mutating = req.method !== 'GET' && req.method !== 'HEAD'
      if (mutating && (options.csrf ?? true) && !csrfOk(req)) {
        return fail(403, 'Missing CSRF header', { code: 'csrf' })
      }

      const ctx = await getCtx(req)
      if (!ctx) return fail(401, 'Not signed in', { code: 'unauthenticated' })
      if (options.roles && !options.roles.includes(ctx.role)) {
        return fail(403, `Requires role: ${options.roles.join(' or ')}`, { code: 'forbidden' })
      }

      const params = route?.params ? await route.params : {}
      return await handler(req, ctx, params)
    } catch (err) {
      return handleError(err)
    }
  }
}

export function withPublic(handler: (req: NextRequest, params: Record<string, string>) => Promise<Response>) {
  return async (req: NextRequest, route: { params: Promise<Record<string, string>> } | undefined): Promise<Response> => {
    try {
      const url = new URL(req.url)
      if (!rateLimit(`${clientIp(req)}:${url.pathname}`, 60, 60_000)) return fail(429, 'Too many requests.')
      const params = route?.params ? await route.params : {}
      return await handler(req, params)
    } catch (err) {
      return handleError(err)
    }
  }
}

export function handleError(err: unknown): NextResponse {
  if (err instanceof ApiError) return fail(err.status, err.message, { code: err.code, ...(err.extra ?? {}) })
  const message = err instanceof Error ? err.message : 'Unexpected error'
  // Never leak internals to the client; log server-side only.
  console.error('[api]', message)
  return fail(500, 'Something went wrong on the server. Check server logs for details.')
}

/* ---------------- helpers ---------------- */

export async function requireCustomer(orgId: string, customerId: string) {
  const c = await db.customer.findFirst({ where: { id: customerId, orgId } })
  if (!c) throw new ApiError(404, 'Customer not found', 'not_found')
  return c
}
