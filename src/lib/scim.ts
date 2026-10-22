import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sha256 } from '@/lib/crypto'
import { audit } from '@/lib/audit'
import { TEAM_ROLES, type TeamRole } from '@/lib/users'

/**
 * SCIM 2.0 user provisioning.
 *
 * The identity provider pushes user lifecycle events here (create, update,
 * deactivate). Authentication uses a per-organisation bearer token that is
 * stored hashed — the plain token is shown exactly once when it is created.
 *
 * SCIM maps onto the existing team model:
 *   userName        → the user's e-mail (unique, lower-cased)
 *   name.*          → display name
 *   active          → deactivated members cannot sign in
 *   roles[].value   → owner | admin | agent | viewer
 */

export const SCIM_CONTENT_TYPE = 'application/scim+json'

export function scimError(status: number, detail: string, scimType = 'invalidValue'): NextResponse {
  return NextResponse.json(
    {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: String(status),
      detail,
      scimType,
    },
    { status, headers: { 'content-type': SCIM_CONTENT_TYPE, 'cache-control': 'no-store' } }
  )
}

export function scimResponse(body: unknown, status = 200, location?: string): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      'content-type': SCIM_CONTENT_TYPE,
      'cache-control': 'no-store',
      ...(location ? { location } : {}),
    },
  })
}

export type ScimUserRow = {
  id: string
  email: string
  name: string
  role: string
  active: boolean
  createdAt: Date
  updatedAt: Date
}

/** SCIM resource representation of a local user. */
export function toScimUser(user: ScimUserRow, baseUrl: string): Record<string, unknown> {
  const [givenName, ...rest] = (user.name || user.email).split(' ')
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: user.id,
    externalId: user.id,
    userName: user.email,
    name: {
      givenName: givenName ?? user.name,
      familyName: rest.join(' '),
      formatted: user.name,
    },
    displayName: user.name,
    emails: [{ value: user.email, type: 'work', primary: true }],
    active: user.active,
    roles: [{ value: user.role, type: 'direct', primary: true }],
    meta: {
      resourceType: 'User',
      created: user.createdAt.toISOString(),
      lastModified: user.updatedAt.toISOString(),
      location: `${baseUrl}/api/scim/v2/Users/${user.id}`,
    },
  }
}

export function scimList(items: Record<string, unknown>[], total: number, startIndex = 1, count?: number): Record<string, unknown> {
  return {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults: total,
    startIndex,
    itemsPerPage: count ?? items.length,
    Resources: items,
  }
}

/**
 * Authenticate a SCIM request with the organisation's bearer token.
 * Returns the organisation id when the token is valid, otherwise null.
 */
export async function authenticateScimRequest(req: NextRequest): Promise<{ orgId: string } | null> {
  const header = req.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) return null
  const token = match[1].trim()
  if (!token) return null
  const tokenHash = sha256(token)
  const row = await db.scimConfig.findFirst({ where: { tokenHash, enabled: true } })
  if (!row) return null
  return { orgId: row.orgId }
}

export type ScimUserInput = {
  userName: string
  givenName?: string
  familyName?: string
  displayName?: string
  active: boolean
  role: string
  externalId?: string
}

/** Read the SCIM attributes we support out of a request payload. */
export function parseScimUserPayload(payload: unknown): { ok: true; value: ScimUserInput } | { ok: false; detail: string } {
  if (!payload || typeof payload !== 'object') return { ok: false, detail: 'The request body must be a SCIM User object.' }
  const body = payload as Record<string, unknown>
  const schemas = Array.isArray(body.schemas) ? body.schemas.map(String) : []
  if (schemas.length && !schemas.includes('urn:ietf:params:scim:schemas:core:2.0:User')) {
    return { ok: false, detail: `Unsupported schema "${schemas[0]}".` }
  }
  const userName = String(body.userName ?? '').trim().toLowerCase()
  if (!userName || !userName.includes('@')) return { ok: false, detail: 'userName must be an e-mail address.' }

  const name = (body.name ?? {}) as Record<string, unknown>
  const givenName = typeof name.givenName === 'string' ? name.givenName.trim() : ''
  const familyName = typeof name.familyName === 'string' ? name.familyName.trim() : ''
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : ''
  const fullName = displayName || [givenName, familyName].filter(Boolean).join(' ')

  const roles = Array.isArray(body.roles) ? body.roles : []
  let role = 'agent'
  for (const entry of roles) {
    if (!entry || typeof entry !== 'object') continue
    const value = String((entry as Record<string, unknown>).value ?? '').trim().toLowerCase()
    if ((TEAM_ROLES as readonly string[]).includes(value)) {
      role = value
      break
    }
  }

  const activeRaw = body.active
  const active = activeRaw === undefined ? true : activeRaw === true || activeRaw === 'true'

  return {
    ok: true,
    value: {
      userName,
      givenName: givenName || undefined,
      familyName: familyName || undefined,
      displayName: fullName || undefined,
      active,
      role,
      externalId: typeof body.externalId === 'string' && body.externalId.trim() ? body.externalId.trim() : undefined,
    },
  }
}

/** SCIM "active" filter support: `userName eq "a@b.c"`. */
export function parseUserNameFilter(filter: string | null): { userName?: string; unsupported: boolean } {
  if (!filter) return { unsupported: false }
  const match = /^userName\s+eq\s+"([^"]+)"$/i.exec(filter.trim())
  if (match) return { userName: match[1].trim().toLowerCase(), unsupported: false }
  return { unsupported: true }
}

/** Map a SCIM role value onto the local role model. */
export function normalizeRole(value: string): TeamRole {
  const lowered = value.trim().toLowerCase()
  return (TEAM_ROLES as readonly string[]).includes(lowered) ? (lowered as TeamRole) : 'agent'
}

export async function auditScim(orgId: string, action: string, entityId: string, meta: Record<string, unknown>): Promise<void> {
  await audit({
    orgId,
    actorType: 'scim',
    actorId: 'scim',
    action,
    entity: 'user',
    entityId,
    meta,
  })
}
