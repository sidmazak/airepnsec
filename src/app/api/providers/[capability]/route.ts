import { z } from 'zod'
import { withAuth, json, fail, parseBody } from '@/lib/api'
import { audit } from '@/lib/audit'
import {
  saveProvider,
  toPublicConfig,
  CAPABILITIES,
  type Capability,
} from '@/lib/ai/providers'

const PROVIDER_KINDS = ['managed', 'ollama', 'openai_compatible', 'browser', 'local_lexical', 'none'] as const

const putSchema = z.object({
  provider: z.enum(PROVIDER_KINDS),
  label: z.string().max(200).optional(),
  baseUrl: z.string().max(2000).optional(),
  model: z.string().max(200).optional(),
  // '' clears the stored key; undefined keeps the existing one. Never echoed back.
  apiKey: z.string().max(4096).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
})

/**
 * PUT /api/providers/[capability] — save provider config (owner/admin).
 * The response never contains apiKeyEnc; the audit meta contains no secrets.
 */
export const PUT = withAuth(
  async (req, ctx, params) => {
    const raw = params.capability
    if (!(CAPABILITIES as readonly string[]).includes(raw)) {
      return fail(404, `Unknown capability "${raw}"`, { code: 'not_found' })
    }
    const capability = raw as Capability

    const body = await parseBody(req, putSchema)
    const row = await saveProvider(ctx.org.id, capability, body)

    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'settings.provider_updated',
      entity: 'provider_config',
      entityId: row.id,
      meta: { capability, provider: row.provider, enabled: row.enabled },
    })

    return json({ config: toPublicConfig(row) })
  },
  { roles: ['owner', 'admin'] }
)
