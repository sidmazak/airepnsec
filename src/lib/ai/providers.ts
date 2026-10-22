import { db } from '@/lib/db'
import { ApiError } from '@/lib/api'
import { encryptSecret, decryptSecret } from '@/lib/crypto'

export type Capability = 'llm' | 'embedding' | 'stt' | 'tts' | 'realtime' | 'rerank' | 'vision'
export const CAPABILITIES: Capability[] = ['llm', 'embedding', 'stt', 'tts', 'realtime', 'rerank', 'vision']

export type ProviderKind = 'ollama' | 'openai_compatible' | 'browser' | 'local_neural' | 'local_lexical' | 'none'

export const CAPABILITY_INFO: Record<Capability, { label: string; description: string; kinds: ProviderKind[] }> = {
  llm: { label: 'Conversation model (LLM)', description: 'Powers the AI receptionist chat and voice replies. Bring your own local Ollama model or an OpenAI-compatible endpoint.', kinds: ['ollama', 'openai_compatible', 'none'] },
  embedding: { label: 'Knowledge retrieval (RAG embeddings)', description: 'Embeds and retrieves your approved documents. The built-in neural model runs entirely on this machine.', kinds: ['local_neural', 'ollama', 'openai_compatible', 'local_lexical'] },
  stt: { label: 'Speech-to-text', description: 'Converts spoken words to text for voice conversations. The browser mic path works out of the box.', kinds: ['browser', 'openai_compatible'] },
  tts: { label: 'Text-to-speech', description: 'Speaks assistant replies aloud in voice mode. The browser synth path works out of the box.', kinds: ['browser', 'openai_compatible'] },
  realtime: { label: 'Realtime voice (optional)', description: 'Low-latency WebRTC voice with an OpenAI-compatible realtime endpoint. Falls back to the conversation model when not set.', kinds: ['none', 'openai_compatible'] },
  rerank: { label: 'Reranking (optional)', description: 'Improves ordering of retrieved knowledge. Optional.', kinds: ['none', 'openai_compatible'] },
  vision: { label: 'Vision (optional)', description: 'Understands images. Optional.', kinds: ['none', 'openai_compatible'] },
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
    // Capability-aware defaults. Only capabilities with a real, credential-free,
    // working-out-of-the-box path are enabled: embedding (built-in local neural
    // model) and stt/tts (browser Web Speech). The conversation model is left
    // DISABLED until the operator deliberately configures one — we never imply a
    // working LLM that does not exist. Optional capabilities default to 'none'.
    const defaultProvider =
      capability === 'embedding' ? 'local_neural'
      : capability === 'stt' || capability === 'tts' ? 'browser'
      : 'none'
    row = await db.providerConfig.create({
      data: {
        orgId,
        capability,
        provider: defaultProvider,
        enabled: capability === 'embedding' || capability === 'stt' || capability === 'tts',
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
    // Reranking and vision are NOT yet implemented in the assistant's LLM layer.
    // Report that honestly instead of implying a working capability.
    if ((capability === 'rerank' || capability === 'vision') && row.provider !== 'none') {
      return {
        ok: false,
        message: `${CAPABILITY_INFO[capability].label.replace(/ \(optional\)$/, '')} is not implemented yet — no request was made. Set it to "None" to disable it, or leave it off.`,
        latencyMs: 0,
      }
    }
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

/**
 * True when an OpenAI-compatible base URL points at this machine or a private
 * network — i.e. a self-hosted speech/LLM server (Kokoro-FastAPI, faster-whisper,
 * speaches, llama.cpp, vLLM...). Such endpoints stay inside the network and are
 * allowed even in local-only mode.
 */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (host === 'localhost' || host === 'host.docker.internal' || host.endsWith('.local') || host.endsWith('.internal')) return true
    if (host === '::1') return true
    if (/^(fc|fd|fe80)/.test(host)) return true // IPv6 unique-local / link-local
    const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    if (v4) {
      const [a, b] = [Number(v4[1]), Number(v4[2])]
      if (a === 127 || a === 10 || a === 0) return true
      if (a === 192 && b === 168) return true
      if (a === 169 && b === 254) return true
      if (a === 172 && b >= 16 && b <= 31) return true
    }
    return false
  } catch {
    return false
  }
}

/** Enforce data-mode policy before any AI call. Throws on violation. */
export async function assertAiPolicy(orgId: string, providerKind: string, baseUrl = '') {
  const org = await db.organization.findUnique({ where: { id: orgId }, select: { dataMode: true } })
  if (!org) throw new ApiError(404, 'Organization not found', 'not_found')
  const cloudProviders = ['openai_compatible']
  if (org.dataMode === 'local_only' && cloudProviders.includes(providerKind)) {
    // A self-hosted OpenAI-compatible server on this machine/private network is
    // not a cloud provider — allow it so local_only orgs can still run speech.
    if (baseUrl && isLocalEndpoint(baseUrl)) return
    throw new ApiError(
      403,
      'Local-only mode is enabled: this request would send data to an external AI provider and was blocked. Configure a local Ollama model, a self-hosted endpoint on this network, or switch the data mode in AI settings.',
      'local_only_blocked'
    )
  }
}
