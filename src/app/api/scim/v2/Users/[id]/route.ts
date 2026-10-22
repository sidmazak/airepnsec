import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import {
  auditScim,
  authenticateScimRequest,
  parseScimUserPayload,
  scimError,
  scimResponse,
  toScimUser,
} from '@/lib/scim'

export const maxDuration = 30

function baseUrl(req: NextRequest): string {
  return new URL(req.url).origin
}

async function findUser(orgId: string, id: string) {
  const byId = await db.user.findFirst({ where: { id, orgId } })
  if (byId) return byId
  // SCIM allows addressing a resource by its userName in some flows.
  const byEmail = await db.user.findFirst({ where: { email: id.trim().toLowerCase(), orgId } })
  return byEmail
}

/** GET /api/scim/v2/Users/{id} */
export async function GET(req: NextRequest, route: { params: Promise<Record<string, string>> }) {
  try {
    const auth = await authenticateScimRequest(req)
    if (!auth) return scimError(401, 'A valid SCIM bearer token is required.', 'invalidValue')
    const params = await route.params
    const user = await findUser(auth.orgId, params.id ?? '')
    if (!user) return scimError(404, 'The user does not exist.', 'invalidValue')
    return scimResponse(toScimUser(user, baseUrl(req)))
  } catch (err) {
    return scimError(500, (err instanceof Error ? err.message : 'The SCIM request failed.').slice(0, 300))
  }
}

/** PUT /api/scim/v2/Users/{id} — replace the user. */
export async function PUT(req: NextRequest, route: { params: Promise<Record<string, string>> }) {
  try {
    const auth = await authenticateScimRequest(req)
    if (!auth) return scimError(401, 'A valid SCIM bearer token is required.', 'invalidValue')
    const params = await route.params
    const existing = await findUser(auth.orgId, params.id ?? '')
    if (!existing) return scimError(404, 'The user does not exist.', 'invalidValue')

    let payload: unknown
    try {
      payload = await req.json()
    } catch {
      return scimError(400, 'The request body must be valid JSON.', 'invalidSyntax')
    }
    const parsed = parseScimUserPayload(payload)
    if (!parsed.ok) return scimError(400, parsed.detail)
    const input = parsed.value

    if (input.userName !== existing.email) {
      const clash = await db.user.findFirst({ where: { orgId: auth.orgId, email: input.userName } })
      if (clash) return scimError(409, `A user with userName "${input.userName}" already exists.`, 'uniqueness')
    }

    const updated = await db.user.update({
      where: { id: existing.id },
      data: {
        email: input.userName,
        name: input.displayName ?? existing.name,
        role: input.role,
        active: input.active,
        ssoProvider: 'scim',
        ssoSubject: input.externalId ?? existing.ssoSubject ?? input.userName,
      },
      select: { id: true, email: true, name: true, role: true, active: true, createdAt: true, updatedAt: true },
    })
    await auditScim(auth.orgId, 'scim.user_updated', updated.id, { email: updated.email, role: updated.role, active: updated.active })
    return scimResponse(toScimUser(updated, baseUrl(req)))
  } catch (err) {
    return scimError(500, (err instanceof Error ? err.message : 'The SCIM request failed.').slice(0, 300))
  }
}

/**
 * PATCH /api/scim/v2/Users/{id}
 * Partial update. Supports `active` changes and name updates — the operations
 * identity providers send for user lifecycle events.
 */
export async function PATCH(req: NextRequest, route: { params: Promise<Record<string, string>> }) {
  try {
    const auth = await authenticateScimRequest(req)
    if (!auth) return scimError(401, 'A valid SCIM bearer token is required.', 'invalidValue')
    const params = await route.params
    const existing = await findUser(auth.orgId, params.id ?? '')
    if (!existing) return scimError(404, 'The user does not exist.', 'invalidValue')

    let payload: unknown
    try {
      payload = await req.json()
    } catch {
      return scimError(400, 'The request body must be valid JSON.', 'invalidSyntax')
    }
    const body = (payload ?? {}) as Record<string, unknown>
    const operations = Array.isArray(body.Operations) ? body.Operations : []
    if (!operations.length) return scimError(400, 'The PATCH body must contain an Operations array.', 'invalidSyntax')

    const data: Record<string, unknown> = {}
    for (const operation of operations) {
      if (!operation || typeof operation !== 'object') continue
      const op = operation as Record<string, unknown>
      const path = String(op.path ?? '').toLowerCase()
      const value = op.value
      if (path === 'active') {
        data.active = value === true || value === 'true'
      } else if (path === 'displayname' || path === 'name' || path === 'name.givenname' || path === 'name.formatted') {
        const name = typeof value === 'string' ? value.trim() : ''
        if (name) data.name = name
      } else if (path === 'username' || path === 'emails.value') {
        const email = typeof value === 'string' ? value.trim().toLowerCase() : ''
        if (email && email.includes('@')) data.email = email
      } else if (path === 'roles' || path === 'roles.value') {
        const parsed = parseScimUserPayload({ userName: existing.email, roles: Array.isArray(value) ? value : [] })
        if (parsed.ok) data.role = parsed.value.role
      }
    }

    if (data.email) {
      const clash = await db.user.findFirst({ where: { orgId: auth.orgId, email: data.email as string } })
      if (clash && clash.id !== existing.id) {
        return scimError(409, `A user with userName "${data.email}" already exists.`, 'uniqueness')
      }
    }

    const updated = await db.user.update({
      where: { id: existing.id },
      data,
      select: { id: true, email: true, name: true, role: true, active: true, createdAt: true, updatedAt: true },
    })
    await auditScim(auth.orgId, 'scim.user_patched', updated.id, { changes: Object.keys(data) })
    return scimResponse(toScimUser(updated, baseUrl(req)))
  } catch (err) {
    return scimError(500, (err instanceof Error ? err.message : 'The SCIM request failed.').slice(0, 300))
  }
}

/**
 * DELETE /api/scim/v2/Users/{id}
 * SCIM 2.0 deactivation: the account is disabled (history preserved) instead of
 * being removed.
 */
export async function DELETE(req: NextRequest, route: { params: Promise<Record<string, string>> }) {
  try {
    const auth = await authenticateScimRequest(req)
    if (!auth) return scimError(401, 'A valid SCIM bearer token is required.', 'invalidValue')
    const params = await route.params
    const existing = await findUser(auth.orgId, params.id ?? '')
    if (!existing) return scimError(404, 'The user does not exist.', 'invalidValue')

    await db.user.update({ where: { id: existing.id }, data: { active: false } })
    await db.session.updateMany({ where: { userId: existing.id, revokedAt: null }, data: { revokedAt: new Date() } })
    await auditScim(auth.orgId, 'scim.user_deactivated', existing.id, { email: existing.email })
    return new Response(null, { status: 204 })
  } catch (err) {
    return scimError(500, (err instanceof Error ? err.message : 'The SCIM request failed.').slice(0, 300))
  }
}
