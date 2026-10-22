import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, json, parseBody, fail } from '@/lib/api'
import { db } from '@/lib/db'
import { randomToken, sha256 } from '@/lib/crypto'
import { audit } from '@/lib/audit'

const putSchema = z.object({
  enabled: z.boolean(),
  /** Absolute base URL of this instance — the identity provider needs it. */
  baseUrl: z.string().url('baseUrl must be an absolute URL').max(300),
  /** Create a new token (the previous one stops working immediately). */
  rotate: z.boolean().default(false),
})

/**
 * GET /api/admin/scim
 * SCIM provisioning status. The bearer token itself is only ever returned once,
 * right after it is created.
 */
export const GET = withAuth(
  async (_req: NextRequest, ctx) => {
    const row = await db.scimConfig.findUnique({ where: { orgId: ctx.org.id } })
    return json({
      scim: row
        ? {
            enabled: row.enabled,
            url: row.url,
            tokenPresent: Boolean(row.tokenHash),
            createdAt: row.createdAt,
          }
        : { enabled: false, url: '', tokenPresent: false, createdAt: null },
    })
  },
  { roles: ['owner', 'admin'] }
)

/**
 * PUT /api/admin/scim
 * Enable SCIM provisioning and (re)issue the bearer token.
 */
export const PUT = withAuth(
  async (req: NextRequest, ctx) => {
    const body = await parseBody(req, putSchema)
    const endpoint = `${body.baseUrl.replace(/\/+$/, '')}/api/scim/v2`
    const existing = await db.scimConfig.findUnique({ where: { orgId: ctx.org.id } })
    const needsToken = body.rotate || !existing

    let plainToken = ''
    if (needsToken) {
      plainToken = `scim_${randomToken(24)}`
    }

    const tokenHash = plainToken ? sha256(plainToken) : existing?.tokenHash ?? ''
    if (existing) {
      await db.scimConfig.update({
        where: { id: existing.id },
        data: { enabled: body.enabled, url: endpoint, tokenHash },
      })
    } else {
      await db.scimConfig.create({
        data: { orgId: ctx.org.id, enabled: body.enabled, url: endpoint, tokenHash },
      })
    }

    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'scim.config_updated',
      entity: 'scim_config',
      entityId: ctx.org.id,
      meta: { enabled: body.enabled, rotated: body.rotate },
    })

    if (!plainToken) {
      return json({ ok: true, scim: { enabled: body.enabled, url: endpoint, tokenPresent: true } })
    }
    return json({
      ok: true,
      scim: { enabled: body.enabled, url: endpoint, tokenPresent: true },
      // Shown exactly once — store it in the identity provider now.
      token: plainToken,
    })
  },
  { roles: ['owner', 'admin'] }
)
