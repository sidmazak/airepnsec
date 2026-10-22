import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword, randomToken } from '@/lib/crypto'
import {
  auditScim,
  authenticateScimRequest,
  parseScimUserPayload,
  parseUserNameFilter,
  scimError,
  scimList,
  scimResponse,
  toScimUser,
} from '@/lib/scim'

export const maxDuration = 30

function baseUrl(req: NextRequest): string {
  return new URL(req.url).origin
}

/**
 * GET /api/scim/v2/Users
 * List (or filter) the organisation's users for the identity provider.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await authenticateScimRequest(req)
    if (!auth) return scimError(401, 'A valid SCIM bearer token is required.', 'invalidValue')
    const url = new URL(req.url)
    const filter = parseUserNameFilter(url.searchParams.get('filter'))
    if (filter.unsupported) return scimError(400, 'Only the filter userName eq "..." is supported.', 'invalidFilter')

    const where = filter.userName ? { orgId: auth.orgId, email: filter.userName } : { orgId: auth.orgId }
    const rows = await db.user.findMany({ where, orderBy: { email: 'asc' }, take: 200 })
    const resources = rows.map((row) =>
      toScimUser(
        {
          id: row.id,
          email: row.email,
          name: row.name,
          role: row.role,
          active: row.active,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
        baseUrl(req)
      )
    )
    return scimResponse(scimList(resources, resources.length))
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The SCIM request failed.'
    return scimError(500, message.slice(0, 300))
  }
}

/**
 * POST /api/scim/v2/Users
 * Provision a user. The account gets a random local password — the user signs
 * in through the configured identity provider or resets their password.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await authenticateScimRequest(req)
    if (!auth) return scimError(401, 'A valid SCIM bearer token is required.', 'invalidValue')

    let payload: unknown
    try {
      payload = await req.json()
    } catch {
      return scimError(400, 'The request body must be valid JSON.', 'invalidSyntax')
    }
    const parsed = parseScimUserPayload(payload)
    if (!parsed.ok) return scimError(400, parsed.detail)
    const input = parsed.value

    const existing = await db.user.findFirst({ where: { orgId: auth.orgId, email: input.userName } })
    if (existing) {
      return scimError(409, `A user with userName "${input.userName}" already exists.`, 'uniqueness')
    }

    const created = await db.user.create({
      data: {
        orgId: auth.orgId,
        email: input.userName,
        name: input.displayName ?? input.userName.split('@')[0],
        role: input.role,
        active: input.active,
        passwordHash: hashPassword(randomToken(24)),
        ssoProvider: 'scim',
        ssoSubject: input.externalId ?? input.userName,
      },
      select: { id: true, email: true, name: true, role: true, active: true, createdAt: true, updatedAt: true },
    })

    await auditScim(auth.orgId, 'scim.user_created', created.id, { email: created.email, role: created.role })

    const location = `${baseUrl(req)}/api/scim/v2/Users/${created.id}`
    return scimResponse(toScimUser(created, baseUrl(req)), 201, location)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The SCIM request failed.'
    return scimError(500, message.slice(0, 300))
  }
}
