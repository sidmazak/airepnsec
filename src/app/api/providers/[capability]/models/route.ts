import { z } from 'zod'
import { withAuth, json, fail, parseBody } from '@/lib/api'
import { getApiKey, getProviderRow, CAPABILITIES, type Capability } from '@/lib/ai/providers'

const schema = z.object({
  provider: z.string().max(40).optional(),
  baseUrl: z.string().max(2000).optional(),
  model: z.string().max(200).optional(),
  apiKey: z.string().max(4096).optional(),
})

type ModelsResult = { models: string[]; source: string; error?: string }

async function listModels(provider: string, baseUrl: string, model: string, key: string, capability: string): Promise<ModelsResult> {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (provider === 'local_speech') {
    const { listLocalSpeechModels } = await import('@/lib/ai/localSpeech')
    const models = await listLocalSpeechModels()
    return {
      models: models.filter((m) => m.capability === capability).map((m) => m.id),
      source: 'catalog',
    }
  }
  if (provider === 'browser' || provider === 'local_neural' || provider === 'local_lexical' || provider === 'none') {
    return { models: [], source: 'builtin' }
  }
  if (!base) return { models: [], source: 'preset', error: 'Set a base URL first.' }

  try {
    if (provider === 'ollama') {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) return { models: [], source: 'provider', error: `Ollama returned HTTP ${res.status}` }
      const data = (await res.json()) as { models?: Array<{ name?: string }> }
      return { models: (data.models ?? []).map((m) => m.name ?? '').filter(Boolean).sort(), source: 'provider' }
    }
    if (provider === 'anthropic') {
      const { anthropicHeaders, normalizeAnthropicBase } = await import('@/lib/ai/anthropic')
      const res = await fetch(`${normalizeAnthropicBase(base)}/models?limit=100`, {
        headers: anthropicHeaders(key),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) return { models: [], source: 'provider', error: `Anthropic returned HTTP ${res.status}` }
      const data = (await res.json()) as { data?: Array<{ id?: string }> }
      return { models: (data.data ?? []).map((m) => m.id ?? '').filter(Boolean).sort(), source: 'provider' }
    }
    if (provider === 'google') {
      const { googleHeaders, normalizeGoogleBase } = await import('@/lib/ai/google')
      const res = await fetch(`${normalizeGoogleBase(base)}/models?pageSize=200`, {
        headers: googleHeaders(key),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) return { models: [], source: 'provider', error: `Gemini returned HTTP ${res.status}` }
      const data = (await res.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> }
      const wanted = capability === 'embedding' ? 'embedContent' : 'generateContent'
      const models = (data.models ?? [])
        .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes(wanted))
        .map((m) => (m.name ?? '').replace(/^models\//, ''))
        .filter(Boolean)
        .sort()
      return { models, source: 'provider' }
    }
    if (provider === 'azure_openai') {
      return { models: [], source: 'deployment', error: 'Azure OpenAI lists deployments in the Azure portal — type your deployment name.' }
    }
    const res = await fetch(`${base}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { models: [], source: 'provider', error: `Endpoint returned HTTP ${res.status}` }
    const data = (await res.json()) as { data?: Array<{ id?: string }> }
    return { models: (data.data ?? []).map((m) => m.id ?? '').filter(Boolean).sort(), source: 'provider' }
  } catch (err) {
    return { models: [], source: 'provider', error: err instanceof Error ? err.message : 'Could not reach the provider' }
  }
}

/**
 * POST /api/providers/[capability]/models — list models from the configured (or
 * draft) endpoint so the UI can offer a dropdown instead of free text.
 */
export const POST = withAuth(
  async (req, ctx, params) => {
    const raw = params.capability
    if (!(CAPABILITIES as readonly string[]).includes(raw)) {
      return fail(404, `Unknown capability "${raw}"`, { code: 'not_found' })
    }
    const capability = raw as Capability
    const body = await parseBody(req, schema)
    const row = await getProviderRow(ctx.org.id, capability)

    const provider = body.provider ?? row.provider
    const baseUrl = body.baseUrl ?? row.baseUrl
    const model = body.model ?? row.model
    const key = body.apiKey && body.apiKey.trim() ? body.apiKey.trim() : getApiKey(row)

    const result = await listModels(provider, baseUrl, model, key, capability)
    return json(result)
  },
  { roles: ['owner', 'admin', 'agent', 'viewer'] }
)
