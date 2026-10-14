import { z } from 'zod'
import { withAuth, json, parseBody, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { encryptSecret, decryptSecret } from '@/lib/crypto'
import { configSchemaFor, publicIntegration, secretsAreSufficient, secretsSchemaFor } from '@/lib/integrations/kinds'

async function loadIntegration(orgId: string, id: string) {
  const integration = await db.integration.findFirst({ where: { id, orgId } })
  if (!integration) throw new ApiError(404, 'Integration not found', 'not_found')
  return integration
}

const patchSchema = z.object({
  label: z.string().max(120).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.unknown()).nullable().optional(),
  enabled: z.boolean().optional(),
})

/**
 * PATCH /api/integrations/[id] (owner/admin) {label?, config?, secrets?, enabled?}
 * secrets as an object = FULL replacement (encrypted); secrets: null clears the
 * stored credentials. Enabling requires configured credentials — we refuse an
 * integration that could never work. Audit meta lists changed fields only,
 * never secret values.
 */
export const PATCH = withAuth(
  async (req, ctx, params) => {
    const integration = await loadIntegration(ctx.org.id, params.id)
    const body = await parseBody(req, patchSchema)

    const data: { label?: string; configJson?: string; secretsEnc?: string; enabled?: boolean } = {}
    const changed: string[] = []

    if (body.label !== undefined) {
      data.label = body.label
      changed.push('label')
    }

    if (body.config !== undefined) {
      const schema = configSchemaFor[integration.kind]
      const parsed = schema.safeParse(body.config)
      if (!parsed.success) {
        const first = parsed.error.issues[0]
        throw new ApiError(422, `Invalid config.${first.path.join('.') || ''}: ${first.message}`, 'validation')
      }
      data.configJson = JSON.stringify(parsed.data)
      changed.push('config')
    }

    if (body.secrets !== undefined) {
      if (body.secrets === null) {
        data.secretsEnc = ''
        changed.push('secrets')
        if (body.enabled === true) {
          throw new ApiError(400, 'Add credentials before enabling', 'not_configured')
        }
        // Clearing credentials forces the integration off — an enabled row with
        // no secrets can neither send nor be tested honestly.
        data.enabled = false
      } else {
        const parsed = secretsSchemaFor[integration.kind].safeParse(body.secrets)
        if (!parsed.success) {
          const first = parsed.error.issues[0]
          throw new ApiError(422, `Invalid secrets.${first.path.join('.') || ''}: ${first.message}`, 'validation')
        }
        if (!secretsAreSufficient(integration.kind, parsed.data as Record<string, unknown>)) {
          throw new ApiError(400, 'Add credentials before enabling', 'insufficient_secrets')
        }
        data.secretsEnc = encryptSecret(JSON.stringify(parsed.data))
        changed.push('secrets')
      }
    }

    if (body.enabled !== undefined) {
      if (body.enabled) {
        // Kinds where anonymous/empty credentials are legitimate (smtp relays,
        // optional-signing webhooks) may be enabled without secrets; everything
        // else requires credentials that can actually work.
        const secretsNow = data.secretsEnc !== undefined ? data.secretsEnc : integration.secretsEnc
        const secretsObj = secretsNow ? (JSON.parse(decryptSecret(secretsNow) || '{}') as Record<string, unknown>) : {}
        const sufficient = secretsAreSufficient(integration.kind, secretsObj)
        const anonymousOk = integration.kind === 'smtp' || integration.kind === 'webhook_out'
        if (!sufficient && !(anonymousOk && !secretsNow)) {
          throw new ApiError(400, 'Add credentials before enabling', 'not_configured')
        }
      }
      data.enabled = body.enabled
      changed.push('enabled')
    } else if (data.secretsEnc === '' && integration.enabled) {
      data.enabled = false
    }

    const updated = await db.integration.update({ where: { id: integration.id }, data })

    // Enabling (or reconfiguring) a channel releases messages that were waiting
    // for this integration — they dispatch on the next tick.
    if (updated.enabled) {
      const { nudgeChannel } = await import('@/lib/integrations/dispatcher')
      await nudgeChannel(ctx.org.id, updated.kind)
    }

    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'integration.updated',
      entity: 'integration',
      entityId: integration.id,
      meta: { kind: integration.kind, changed, enabled: updated.enabled },
    })

    return json({ integration: publicIntegration(updated) })
  },
  { roles: ['owner', 'admin'] }
)

/** DELETE /api/integrations/[id] (owner/admin) — removes the row and its encrypted credentials. */
export const DELETE = withAuth(
  async (req, ctx, params) => {
    const integration = await loadIntegration(ctx.org.id, params.id)

    await db.integration.delete({ where: { id: integration.id } })

    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'integration.deleted',
      entity: 'integration',
      entityId: integration.id,
      meta: { kind: integration.kind, label: integration.label },
    })

    return json({ deleted: true })
  },
  { roles: ['owner', 'admin'] }
)
