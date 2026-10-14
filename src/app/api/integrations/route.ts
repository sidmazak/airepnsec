import { z } from 'zod'
import { withAuth, json, parseBody, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { encryptSecret } from '@/lib/crypto'
import { isIntegrationKind, SINGLETON_KINDS } from '@/lib/integrations/connectors'
import { configSchemaFor, publicIntegration, secretsAreSufficient, secretsSchemaFor } from '@/lib/integrations/kinds'

/** GET /api/integrations — configured integrations for the org (no secrets ever). */
export const GET = withAuth(async (req, ctx) => {
  const rows = await db.integration.findMany({
    where: { orgId: ctx.org.id },
    orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
  })
  return json({ integrations: rows.map(publicIntegration) })
})

const createSchema = z.object({
  kind: z.string().min(1),
  label: z.string().max(120).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.unknown()).optional(),
})

/**
 * POST /api/integrations (owner/admin) {kind, label?, config?, secrets?}
 * Singleton kinds (smtp, twilio_sms, twilio_whatsapp, stripe) reject a second row;
 * webhook_out allows one per destination URL. Secrets are encrypted as a JSON
 * blob into secretsEnc and are never returned or logged.
 */
export const POST = withAuth(
  async (req, ctx) => {
    const body = await parseBody(req, createSchema)
    if (!isIntegrationKind(body.kind)) {
      throw new ApiError(422, `kind must be one of: smtp, twilio_sms, twilio_whatsapp, stripe, webhook_out`, 'bad_kind')
    }

    if (SINGLETON_KINDS.includes(body.kind)) {
      const existing = await db.integration.findFirst({ where: { orgId: ctx.org.id, kind: body.kind } })
      if (existing) {
        throw new ApiError(409, `${body.kind} is already configured — edit it instead`, 'already_configured')
      }
    } else {
      // webhook_out: one row per destination URL
      const url = typeof body.config?.url === 'string' ? body.config.url.trim() : ''
      if (url) {
        const dupes = await db.integration.findMany({ where: { orgId: ctx.org.id, kind: 'webhook_out' } })
        const exists = dupes.some((row) => {
          try {
            return JSON.parse(row.configJson || '{}')?.url === url
          } catch {
            return false
          }
        })
        if (exists) throw new ApiError(409, `A webhook_out integration for this URL already exists`, 'already_configured')
      }
    }

    const configParsed = configSchemaFor[body.kind].safeParse(body.config ?? {})
    if (!configParsed.success) {
      const first = configParsed.error.issues[0]
      throw new ApiError(422, `Invalid config.${first.path.join('.') || ''}: ${first.message}`, 'validation')
    }

    let secretsEnc = ''
    if (body.secrets) {
      const secretsParsed = secretsSchemaFor[body.kind].safeParse(body.secrets)
      if (!secretsParsed.success) {
        const first = secretsParsed.error.issues[0]
        throw new ApiError(422, `Invalid secrets.${first.path.join('.') || ''}: ${first.message}`, 'validation')
      }
      if (!secretsAreSufficient(body.kind, secretsParsed.data as Record<string, unknown>)) {
        throw new ApiError(422, 'Missing required credentials for this integration kind', 'insufficient_secrets')
      }
      secretsEnc = encryptSecret(JSON.stringify(secretsParsed.data))
    }

    const integration = await db.integration.create({
      data: {
        orgId: ctx.org.id,
        kind: body.kind,
        label: body.label ?? '',
        configJson: JSON.stringify(configParsed.data),
        secretsEnc,
        enabled: false, // enabling is a separate, deliberate step (requires configured credentials)
      },
    })

    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'integration.created',
      entity: 'integration',
      entityId: integration.id,
      meta: { kind: integration.kind, label: integration.label, configured: Boolean(secretsEnc) },
    })

    return json({ integration: publicIntegration(integration) }, 201)
  },
  { roles: ['owner', 'admin'] }
)
