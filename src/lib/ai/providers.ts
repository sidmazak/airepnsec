import { db } from '@/lib/db'
import { ApiError } from '@/lib/api'
import { encryptSecret, decryptSecret } from '@/lib/crypto'

export type Capability = 'llm' | 'embedding' | 'stt' | 'tts' | 'rerank' | 'vision'
export const CAPABILITIES: Capability[] = ['llm', 'embedding', 'stt', 'tts', 'rerank', 'vision']

export type ProviderKind = 'managed' | 'ollama' | 'openai_compatible' | 'browser' | 'local_neural' | 'local_lexical' | 'none'

export const CAPABILITY_INFO: Record<Capability, { label: string; description: string; kinds: ProviderKind[] }> = {
  llm: { label: 'Conversation model (LLM)', description: 'Powers the AI receptionist chat and voice replies.', kinds: ['managed', 'ollama', 'openai_compatible', 'none'] },
  embedding: { label: 'Knowledge retrieval (RAG embeddings)', description: 'Embeds and retrieves your approved documents. The built-in neural model runs entirely on this machine.', kinds: ['local_neural', 'ollama', 'openai_compatible', 'local_lexical'] },
  stt: { label: 'Speech-to-text', description: 'Converts spoken words to text for voice conversations.', kinds: ['browser', 'openai_compatible'] },
  tts: { label: 'Text-to-speech', description: 'Speaks assistant replies aloud in voice mode.', kinds: ['browser', 'openai_compatible'] },
  rerank: { label: 'Reranking (optional)', description: 'Improves ordering of retrieved knowledge. Optional.', kinds: ['none', 'openai_compatible'] },
  vision: { label: 'Vision (optional)', description: 'Understands images. Optional.', kinds: ['none', 'openai_compatible', 'managed'] },
}

export type PublicProviderConfig = {
  id: string
  capability: Capability
  provider: string
  label: string
  baseUrl: string
  model: string
  enabled: boolean
  apiKeyPresent: boolean
  config: Record<string, unknown>
  lastTestAt: string | null
  lastTestOk: boolean
  lastTestError: string
  processesDataWhere: string
}

function dataFlowLabel(provider: string, baseUrl: string): string {
  switch (provider) {
    case 'managed': return 'Managed AI gateway (external service) — conversation text is processed there'
    case 'ollama': return `Local inference on this machine (${baseUrl || 'Ollama'}) — data stays local`
    case 'openai_compatible': return `External OpenAI-compatible endpoint (${baseUrl || 'custom'}) — data leaves this machine`
    case 'browser': return 'In the browser (this device) — no server round-trip for media'
    case 'local_neural': return 'Runs on this machine (built-in ONNX embedding model) — text never leaves the server'
    case 'local_lexical': return 'Legacy keyword index — runs entirely on this machine, no model'
    default: return 'Disabled — no data is sent anywhere'
  }
}

export function toPublicConfig(row: {
  id: string; capability: string; provider: string; label: string; baseUrl: string; model: string;
  apiKeyEnc: string; configJson: string; enabled: boolean; lastTestAt: Date | null; lastTestOk: boolean; lastTestError: string;
}): PublicProviderConfig {
  return {
    id: row.id,
    capability: row.capability as Capability,
    provider: row.provider,
    label: row.label,
    baseUrl: row.baseUrl,
    model: row.model,
    enabled: row.enabled,
    apiKeyPresent: Boolean(row.apiKeyEnc),
    config: (() => { try { return JSON.parse(row.configJson || '{}') } catch { return {} } })(),
    lastTestAt: row.lastTestAt?.toISOString() ?? null,
    lastTestOk: row.lastTestOk,
    lastTestError: row.lastTestError,
    processesDataWhere: dataFlowLabel(row.provider, row.baseUrl),
  }
}

export async function getProviderRow(orgId: string, capability: Capability) {
  let row = await db.providerConfig.findUnique({ where: { orgId_capability: { orgId, capability } } })
  if (!row) {
    row = await db.providerConfig.create({
      data: {
        orgId,
        capability,
        provider: capability === 'llm'
          ? 'managed'
          : capability === 'embedding'
            ? 'local_neural' // real semantic RAG works out of the box, fully local
            : 'browser',
        enabled: capability === 'llm' || capability === 'embedding',
      },
    })
  }
  return row
}

export async function getActiveProvider(orgId: string, capability: Capability) {
  const row = await getProviderRow(orgId, capability)
  if (!row.enabled || row.provider === 'none') return null
  return row
}

export type SaveProviderInput = {
  provider: ProviderKind
  label?: string
  baseUrl?: string
  model?: string
  apiKey?: string | null // null/undefined = keep existing; '' = clear
  enabled?: boolean
  config?: Record<string, unknown>
}

export async function saveProvider(orgId: string, capability: Capability, input: SaveProviderInput) {
  const row = await getProviderRow(orgId, capability)
  let apiKeyEnc = row.apiKeyEnc
  if (input.apiKey === '') apiKeyEnc = ''
  else if (input.apiKey != null && input.apiKey !== undefined) apiKeyEnc = encryptSecret(input.apiKey)

  const updated = await db.providerConfig.update({
    where: { id: row.id },
    data: {
      provider: input.provider,
      label: input.label ?? row.label,
      baseUrl: input.baseUrl ?? row.baseUrl,
      model: input.model ?? row.model,
      apiKeyEnc,
      enabled: input.enabled ?? row.enabled,
      configJson: JSON.stringify(input.config ?? (() => { try { return JSON.parse(row.configJson || '{}') } catch { return {} } })()),
    },
  })
  return updated
}

export function getApiKey(row: { apiKeyEnc: string }): string {
  return decryptSecret(row.apiKeyEnc)
}

/* ---------------- connection tests ---------------- */

export type TestResult = { ok: boolean; message: string; latencyMs: number; details?: Record<string, unknown> }

async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 8000, ...rest } = init
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...rest, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Real connectivity/model test for a provider configuration. */
export async function testProvider(
  row: { provider: string; baseUrl: string; model: string; apiKeyEnc: string },
  capability: Capability = 'llm'
): Promise<TestResult> {
  const started = Date.now()
  const key = getApiKey(row)
  try {
    // Embedding capability gets provider-specific live tests against the actual embed call.
    if (capability === 'embedding') {
      switch (row.provider) {
        case 'local_neural': {
          const { embedNeural } = await import('@/lib/ai/embeddings')
          const [vec] = await embedNeural(['connection test'])
          if (!vec?.length) return { ok: false, message: 'Local neural model returned an empty embedding.', latencyMs: Date.now() - started }
          return { ok: true, message: `Local neural embedding model ready — ${vec.length}-dimensional vectors, fully on this machine.`, latencyMs: Date.now() - started, details: { dim: vec.length } }
        }
        case 'ollama': {
          if (!row.baseUrl) return { ok: false, message: 'Base URL is required (e.g. http://localhost:11434)', latencyMs: 0 }
          const res = await fetchWithTimeout(`${row.baseUrl.replace(/\/$/, '')}/api/embeddings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: row.model || 'nomic-embed-text', prompt: 'connection test' }),
          })
          if (!res.ok) return { ok: false, message: `Ollama embeddings returned HTTP ${res.status} (is "${row.model || 'nomic-embed-text'}" pulled?)`, latencyMs: Date.now() - started }
          const data = (await res.json()) as { embedding?: number[] }
          return data.embedding?.length
            ? { ok: true, message: `Ollama embedded a test string (${data.embedding.length} dims).`, latencyMs: Date.now() - started, details: { dim: data.embedding.length } }
            : { ok: false, message: 'Ollama returned an empty embedding.', latencyMs: Date.now() - started }
        }
        case 'openai_compatible': {
          if (!row.baseUrl) return { ok: false, message: 'Base URL is required (e.g. https://api.example.com/v1)', latencyMs: 0 }
          const res = await fetchWithTimeout(`${row.baseUrl.replace(/\/$/, '')}/embeddings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
            body: JSON.stringify({ model: row.model || 'text-embedding-3-small', input: ['connection test'] }),
          })
          if (!res.ok) return { ok: false, message: `Embedding endpoint returned HTTP ${res.status}`, latencyMs: Date.now() - started }
          const data = (await res.json()) as { data?: Array<{ embedding: number[] }> }
          return data.data?.[0]?.embedding?.length
            ? { ok: true, message: `Endpoint embedded a test string (${data.data[0].embedding.length} dims).`, latencyMs: Date.now() - started, details: { dim: data.data[0].embedding.length } }
            : { ok: false, message: 'Endpoint returned an empty embedding.', latencyMs: Date.now() - started }
        }
        case 'local_lexical':
          return { ok: true, message: 'Legacy keyword index active — deterministic, no model. Switch to the built-in neural model for semantic search.', latencyMs: 0 }
        case 'none':
          return { ok: false, message: 'This capability is disabled.', latencyMs: 0 }
      }
    }
    switch (row.provider) {
      case 'managed': {
        const ZAI = (await import('z-ai-web-dev-sdk')).default
        const zai = await ZAI.create()
        const res = await zai.chat.completions.create({
          messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
          thinking: { type: 'disabled' },
        })
        const text = res.choices[0]?.message?.content ?? ''
        return { ok: text.trim().length > 0, message: text.trim() ? 'Managed gateway responded.' : 'Managed gateway returned an empty response.', latencyMs: Date.now() - started }
      }
      case 'ollama': {
        if (!row.baseUrl) return { ok: false, message: 'Base URL is required (e.g. http://localhost:11434)', latencyMs: 0 }
        const res = await fetchWithTimeout(`${row.baseUrl.replace(/\/$/, '')}/api/tags`)
        if (!res.ok) return { ok: false, message: `Ollama responded with HTTP ${res.status}`, latencyMs: Date.now() - started }
        const data = (await res.json()) as { models?: Array<{ name: string }> }
        const models = data.models?.map((m) => m.name) ?? []
        if (row.model && !models.some((m) => m === row.model || m.split(':')[0] === row.model.split(':')[0])) {
          return { ok: false, message: `Connected to Ollama, but model "${row.model}" is not installed. Available: ${models.slice(0, 8).join(', ') || 'none'}`, latencyMs: Date.now() - started, details: { models } }
        }
        return { ok: true, message: `Connected to Ollama. ${models.length} model(s) available.`, latencyMs: Date.now() - started, details: { models } }
      }
      case 'openai_compatible': {
        if (!row.baseUrl) return { ok: false, message: 'Base URL is required (e.g. https://api.example.com/v1)', latencyMs: 0 }
        const res = await fetchWithTimeout(`${row.baseUrl.replace(/\/$/, '')}/models`, {
          headers: key ? { authorization: `Bearer ${key}` } : {},
        })
        if (!res.ok) return { ok: false, message: `Endpoint responded with HTTP ${res.status}`, latencyMs: Date.now() - started }
        const data = (await res.json()) as { data?: Array<{ id: string }> }
        const models = data.data?.map((m) => m.id) ?? []
        return { ok: true, message: `Connected. ${models.length} model(s) available.`, latencyMs: Date.now() - started, details: { models: models.slice(0, 20) } }
      }
      case 'browser':
        return { ok: true, message: 'Runs in the user\'s browser — no server test needed.', latencyMs: 0 }
      case 'none':
        return { ok: false, message: 'This capability is disabled.', latencyMs: 0 }
      default:
        return { ok: false, message: `Unknown provider kind: ${row.provider}`, latencyMs: 0 }
    }
  } catch (err) {
    const message = err instanceof Error
      ? (err.name === 'AbortError' ? 'Connection timed out' : err.message)
      : 'Connection failed'
    return { ok: false, message: `Test failed: ${message}`, latencyMs: Date.now() - started }
  }
}

export async function runAndStoreTest(orgId: string, capability: Capability): Promise<TestResult> {
  const row = await getProviderRow(orgId, capability)
  const result = await testProvider(row, capability)
  await db.providerConfig.update({
    where: { id: row.id },
    data: { lastTestAt: new Date(), lastTestOk: result.ok, lastTestError: result.ok ? '' : result.message },
  })
  return result
}

/** Enforce data-mode policy before any AI call. Throws on violation. */
export async function assertAiPolicy(orgId: string, providerKind: string) {
  const org = await db.organization.findUnique({ where: { id: orgId }, select: { dataMode: true } })
  if (!org) throw new ApiError(404, 'Organization not found', 'not_found')
  const cloudProviders = ['managed', 'openai_compatible']
  if (org.dataMode === 'local_only' && cloudProviders.includes(providerKind)) {
    throw new ApiError(
      403,
      'Local-only mode is enabled: this request would send data to a cloud provider and was blocked. Configure a local model (e.g. Ollama) or switch the data mode in AI settings.',
      'local_only_blocked'
    )
  }
}
