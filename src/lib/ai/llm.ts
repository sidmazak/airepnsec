import { db } from '@/lib/db'
import { ApiError } from '@/lib/api'
import { getActiveProvider, getApiKey, assertAiPolicy } from '@/lib/ai/providers'

export type LlmMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export type LlmResult = {
  content: string
  provider: string
  model: string
  latencyMs: number
  tokensIn: number
  tokensOut: number
}

export class AiUnavailableError extends ApiError {
  constructor(message: string) {
    super(503, message, 'ai_unavailable')
  }
}

const DEFAULT_TIMEOUT_MS = 30_000

async function logAi(orgId: string, data: { capability: string; provider: string; model: string; latencyMs: number; tokensIn: number; tokensOut: number; ok: boolean; errorSanitized?: string; conversationId?: string }) {
  try {
    await db.aiLog.create({ data: { orgId, ...data } })
  } catch (err) {
    console.error('[ai-log] failed', err instanceof Error ? err.message : err)
  }
}

function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  // strip anything that looks like a key
  return msg.replace(/(sk[-_][A-Za-z0-9-_]{8,})/g, '[redacted]').slice(0, 300)
}

async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...rest, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** One-shot completion with timeout + a single retry on transient failures. */
export async function chatComplete(
  orgId: string,
  messages: LlmMessage[],
  opts: { temperature?: number; maxTokens?: number; conversationId?: string; timeoutMs?: number } = {}
): Promise<LlmResult> {
  const row = await getActiveProvider(orgId, 'llm')
  if (!row) {
    throw new AiUnavailableError(
      'No conversation model is configured. Set one up in Settings → AI providers (local Ollama, an OpenAI-compatible endpoint, or the managed gateway).'
    )
  }
  await assertAiPolicy(orgId, row.provider) // hard-blocks cloud calls in local-only mode

  const started = Date.now()
  const attempts = 2
  let lastErr: unknown = null

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      let result: LlmResult
      if (row.provider === 'managed') result = await callManaged(row.model, messages, opts)
      else if (row.provider === 'ollama') result = await callOllama(row, messages, opts)
      else if (row.provider === 'openai_compatible') result = await callOpenAiCompatible(row, messages, opts)
      else throw new AiUnavailableError(`Provider kind "${row.provider}" cannot serve conversations`)

      const latencyMs = Date.now() - started
      await logAi(orgId, { capability: 'llm', provider: row.provider, model: result.model, latencyMs, tokensIn: result.tokensIn, tokensOut: result.tokensOut, ok: true, conversationId: opts.conversationId })
      return { ...result, latencyMs, provider: row.provider }
    } catch (err) {
      lastErr = err
      const status = err instanceof ApiError ? err.status : 0
      const transient = status === 429 || status >= 500 || !(err instanceof ApiError)
      if (attempt === attempts || !transient) break
      await new Promise((r) => setTimeout(r, 800 * attempt))
    }
  }

  const sanitized = sanitizeError(lastErr)
  await logAi(orgId, { capability: 'llm', provider: row.provider, model: row.model, latencyMs: Date.now() - started, tokensIn: 0, tokensOut: 0, ok: false, errorSanitized: sanitized, conversationId: opts.conversationId })
  if (lastErr instanceof ApiError) throw lastErr
  throw new AiUnavailableError(`The AI model could not be reached: ${sanitized}`)
}

async function callManaged(model: string, messages: LlmMessage[], opts: { temperature?: number; maxTokens?: number; timeoutMs?: number }): Promise<LlmResult> {
  const ZAI = (await import('z-ai-web-dev-sdk')).default
  const zai = await ZAI.create()
  const completion = (await Promise.race([
    zai.chat.completions.create({
      messages: messages.map((m) => ({ role: m.role === 'system' ? 'assistant' : m.role, content: m.content })),
      thinking: { type: 'disabled' },
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Model request timed out')), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
  ])) as { choices?: Array<{ message?: { content?: string } }> }

  const content = completion.choices?.[0]?.message?.content ?? ''
  if (!content) throw new AiUnavailableError('The model returned an empty response')
  return { content, provider: 'managed', model: model || 'managed-default', latencyMs: 0, tokensIn: 0, tokensOut: 0 }
}

async function callOllama(row: { baseUrl: string; model: string }, messages: LlmMessage[], opts: { temperature?: number; maxTokens?: number; timeoutMs?: number }): Promise<LlmResult> {
  if (!row.baseUrl) throw new AiUnavailableError('Ollama base URL is not configured')
  const res = await fetchWithTimeout(`${row.baseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: row.model || 'llama3.2',
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
      format: 'json',
      options: { temperature: opts.temperature ?? 0.4, ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}) },
    }),
    timeoutMs: opts.timeoutMs ?? 60_000, // local models can be slower
  })
  if (!res.ok) throw new AiUnavailableError(`Ollama returned HTTP ${res.status}. Is the server running at ${row.baseUrl}?`)
  const data = (await res.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number }
  const content = data.message?.content ?? ''
  if (!content) throw new AiUnavailableError('Ollama returned an empty response')
  return { content, provider: 'ollama', model: row.model, latencyMs: 0, tokensIn: data.prompt_eval_count ?? 0, tokensOut: data.eval_count ?? 0 }
}

async function callOpenAiCompatible(row: { baseUrl: string; model: string; apiKeyEnc: string }, messages: LlmMessage[], opts: { temperature?: number; maxTokens?: number; timeoutMs?: number }): Promise<LlmResult> {
  if (!row.baseUrl) throw new AiUnavailableError('Endpoint base URL is not configured')
  const key = getApiKey(row)
  const res = await fetchWithTimeout(`${row.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      model: row.model,
      messages,
      temperature: opts.temperature ?? 0.4,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    }),
  })
  if (!res.ok) throw new AiUnavailableError(`Endpoint returned HTTP ${res.status}`)
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const content = data.choices?.[0]?.message?.content ?? ''
  if (!content) throw new AiUnavailableError('The endpoint returned an empty response')
  return {
    content,
    provider: 'openai_compatible',
    model: row.model,
    latencyMs: 0,
    tokensIn: data.usage?.prompt_tokens ?? 0,
    tokensOut: data.usage?.completion_tokens ?? 0,
  }
}
