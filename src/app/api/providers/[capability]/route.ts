import { z } from 'zod'
import { withAuth, json, fail, parseBody } from '@/lib/api'
import { audit } from '@/lib/audit'
import {
  saveProvider,
  toPublicConfig,
  CAPABILITIES,
  CAPABILITY_INFO,
  type Capability,
} from '@/lib/ai/providers'

const PROVIDER_KINDS = ['ollama', 'openai_compatible', 'anthropic', 'google', 'azure_openai', 'browser', 'local_neural', 'local_lexical', 'local_speech', 'none'] as const

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

    if (!CAPABILITY_INFO[capability].kinds.includes(body.provider)) {
      return fail(422, `Provider "${body.provider}" cannot serve the ${capability} capability. Allowed: ${CAPABILITY_INFO[capability].kinds.join(', ')}`, { code: 'bad_provider' })
    }

    // A local speech provider must name a model from the local catalog, and the
    // model must match the capability — no silent fallbacks to a remote service.
    if (body.provider === 'local_speech') {
      const { findLocalSpeechModel, LOCAL_SPEECH_MODELS } = await import('@/lib/ai/localSpeech')
      const wanted = body.model?.trim()
      const model = wanted ? findLocalSpeechModel(wanted) : undefined
      if (!model) {
        return fail(422, `Unknown local speech model "${wanted ?? ''}". Available: ${LOCAL_SPEECH_MODELS.map((m) => m.id).join(', ')}`, { code: 'bad_model' })
      }
      if (model.capability !== capability) {
        return fail(422, `"${model.label}" is a ${model.capability === 'tts' ? 'text-to-speech' : 'speech-to-text'} model and cannot serve the ${capability} capability.`, { code: 'bad_model' })
      }
    }

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
