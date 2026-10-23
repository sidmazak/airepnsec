import { db } from '@/lib/db'
import { ApiError } from '@/lib/api'
import { getActiveProvider, getApiKey, assertAiPolicy } from '@/lib/ai/providers'

export type {
  LlmMessage,
  LlmToolCall,
  LlmToolCallPayload,
  LlmToolSpec,
} from '@/lib/ai/llm-protocol'

import {
  mergeToolCallFrames,
  type ToolCallFrame,
  parseToolArgs,
  toOllamaMessages,
  toOpenAiMessages,
  type LlmMessage,
  type LlmToolCall,
  type LlmToolSpec,
} from '@/lib/ai/llm-protocol'


export type LlmResult = {
  content: string
  /** Provider-native tool calls (empty when the provider has no tool support). */
  toolCalls: LlmToolCall[]
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


type ProviderRow = {
  provider: string
  baseUrl: string
  model: string
  apiKeyEnc: string
  configJson?: string
}

async function resolveProvider(orgId: string): Promise<ProviderRow> {
  const row = await getActiveProvider(orgId, 'llm')
  if (!row) {
    throw new AiUnavailableError(
      'The AI assistant is not configured yet. Enable a conversation model in Settings → AI Providers: ' +
      'either a local Ollama server (http://localhost:11434) or an OpenAI-compatible endpoint with your own API key.'
    )
  }
  await assertAiPolicy(orgId, row.provider, row.baseUrl) // hard-blocks cloud calls in local-only mode; self-hosted endpoints stay allowed
  return row
}

/**
 * Provider capability flags. `nativeTools` is opt-out via the provider config
 * (`nativeTools: false`) because some OpenAI-compatible servers reject the
 * `tools` parameter; `streaming` can be disabled the same way.
 */
export function providerFlags(row: { configJson?: string; provider?: string }): { nativeTools: boolean; streaming: boolean } {
  let config: Record<string, unknown> = {}
  try {
    config = JSON.parse(row.configJson || '{}')
  } catch {
    config = {}
  }
  // Anthropic and Gemini use a different native tool protocol; the receptionist
  // uses its strict JSON tool loop for them (fully supported, just not native).
  const jsonToolOnly = row.provider === 'anthropic' || row.provider === 'google'
  return {
    nativeTools: config.nativeTools !== false && !jsonToolOnly,
    streaming: config.streaming !== false,
  }
}


type CallOpts = {
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  tools?: LlmToolSpec[]
}

/**
 * One-shot completion with timeout + a single retry on transient failures.
 * When `opts.tools` is set the provider is asked for native tool calls; the
 * normalized calls come back in `result.toolCalls`.
 */
export async function chatComplete(
  orgId: string,
  messages: LlmMessage[],
  opts: { temperature?: number; maxTokens?: number; conversationId?: string; timeoutMs?: number; tools?: LlmToolSpec[] } = {}
): Promise<LlmResult> {
  const row = await resolveProvider(orgId)

  const started = Date.now()
  const attempts = 2
  let lastErr: unknown = null

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      let result: LlmResult
      if (row.provider === 'ollama') result = await callOllama(row, messages, opts)
      else if (row.provider === 'openai_compatible') result = await callOpenAiCompatible(row, messages, opts)
      else if (row.provider === 'anthropic') result = await callAnthropic(row, messages, opts)
      else if (row.provider === 'google') result = await callGoogle(row, messages, opts)
      else if (row.provider === 'azure_openai') result = await callAzureOpenAi(row, messages, opts)
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

async function callOllama(row: ProviderRow, messages: LlmMessage[], opts: CallOpts): Promise<LlmResult> {
  if (!row.baseUrl) throw new AiUnavailableError('Ollama base URL is not configured')
  const body: Record<string, unknown> = {
    model: row.model || 'llama3.2',
    messages: toOllamaMessages(messages),
    stream: false,
    options: { temperature: opts.temperature ?? 0.4, ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}) },
  }
  // Ollama only accepts the JSON schema mode when no native tools are used.
  if (opts.tools?.length) body.tools = opts.tools
  else body.format = 'json'

  const res = await fetchWithTimeout(`${row.baseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: opts.timeoutMs ?? 60_000, // local models can be slower
  })
  if (!res.ok) throw new AiUnavailableError(`Ollama returned HTTP ${res.status}. Is the server running at ${row.baseUrl}?`)
  const data = (await res.json()) as {
    message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> }
    prompt_eval_count?: number
    eval_count?: number
  }
  const content = data.message?.content ?? ''
  const toolCalls: LlmToolCall[] = (data.message?.tool_calls ?? [])
    .filter((tc) => tc?.function?.name)
    .map((tc, i) => ({
      id: `call_${i}`,
      name: String(tc.function?.name),
      args: parseToolArgs(tc.function?.arguments),
    }))
  if (!content && toolCalls.length === 0) throw new AiUnavailableError('Ollama returned an empty response')
  return { content, toolCalls, provider: 'ollama', model: row.model, latencyMs: 0, tokensIn: data.prompt_eval_count ?? 0, tokensOut: data.eval_count ?? 0 }
}

async function callOpenAiCompatible(row: ProviderRow, messages: LlmMessage[], opts: CallOpts): Promise<LlmResult> {
  if (!row.baseUrl) throw new AiUnavailableError('Endpoint base URL is not configured')
  const key = getApiKey(row)
  const body: Record<string, unknown> = {
    model: row.model,
    messages: toOpenAiMessages(messages),
    temperature: opts.temperature ?? 0.4,
  }
  if (opts.maxTokens) body.max_tokens = opts.maxTokens
  if (opts.tools?.length) {
    body.tools = opts.tools
    body.tool_choice = 'auto'
  }

  const res = await fetchWithTimeout(`${row.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
    timeoutMs: opts.timeoutMs,
  })
  if (!res.ok) throw new AiUnavailableError(`Endpoint returned HTTP ${res.status}`)
  const data = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>
      }
    }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const message = data.choices?.[0]?.message
  const content = message?.content ?? ''
  const toolCalls: LlmToolCall[] = (message?.tool_calls ?? [])
    .filter((tc) => tc?.function?.name)
    .map((tc, i) => ({
      id: tc.id || `call_${i}`,
      name: String(tc.function?.name),
      args: parseToolArgs(tc.function?.arguments),
    }))
  if (!content && toolCalls.length === 0) throw new AiUnavailableError('The endpoint returned an empty response')
  return {
    content,
    toolCalls,
    provider: 'openai_compatible',
    model: row.model,
    latencyMs: 0,
    tokensIn: data.usage?.prompt_tokens ?? 0,
    tokensOut: data.usage?.completion_tokens ?? 0,
  }
}

async function callAnthropic(row: ProviderRow, messages: LlmMessage[], opts: CallOpts): Promise<LlmResult> {
  if (!row.baseUrl) throw new AiUnavailableError('Anthropic base URL is not configured')
  const key = getApiKey(row)
  if (!key) throw new AiUnavailableError('Anthropic API key is not configured')
  const { anthropicHeaders, anthropicRequestBody, normalizeAnthropicBase, parseAnthropicResponse } = await import('@/lib/ai/anthropic')
  const res = await fetchWithTimeout(`${normalizeAnthropicBase(row.baseUrl)}/messages`, {
    method: 'POST',
    headers: anthropicHeaders(key),
    body: JSON.stringify(anthropicRequestBody(row.model, messages, {
      temperature: opts.temperature,
      maxTokens: opts.maxTokens ?? 1024,
    })),
    timeoutMs: opts.timeoutMs ?? 90_000,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new AiUnavailableError(`Anthropic returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`)
  }
  const parsed = parseAnthropicResponse(await res.json())
  if (!parsed.content && parsed.toolCalls.length === 0) throw new AiUnavailableError('Anthropic returned an empty response')
  return { ...parsed, provider: 'anthropic', model: row.model, latencyMs: 0 }
}

async function callGoogle(row: ProviderRow, messages: LlmMessage[], opts: CallOpts): Promise<LlmResult> {
  if (!row.baseUrl) throw new AiUnavailableError('Gemini base URL is not configured')
  const key = getApiKey(row)
  if (!key) throw new AiUnavailableError('Gemini API key is not configured')
  const { googleHeaders, googleRequestBody, normalizeGoogleBase, parseGoogleResponse } = await import('@/lib/ai/google')
  const res = await fetchWithTimeout(`${normalizeGoogleBase(row.baseUrl)}/models/${encodeURIComponent(row.model)}:generateContent`, {
    method: 'POST',
    headers: googleHeaders(key),
    body: JSON.stringify(googleRequestBody(messages, { temperature: opts.temperature, maxTokens: opts.maxTokens })),
    timeoutMs: opts.timeoutMs ?? 90_000,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new AiUnavailableError(`Gemini returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`)
  }
  const parsed = parseGoogleResponse(await res.json())
  if (!parsed.content) throw new AiUnavailableError('Gemini returned an empty response')
  return { ...parsed, toolCalls: [], provider: 'google', model: row.model, latencyMs: 0 }
}

async function callAzureOpenAi(row: ProviderRow, messages: LlmMessage[], opts: CallOpts): Promise<LlmResult> {
  if (!row.baseUrl) throw new AiUnavailableError('Azure OpenAI deployment endpoint is not configured')
  const key = getApiKey(row)
  if (!key) throw new AiUnavailableError('Azure OpenAI API key is not configured')
  let apiVersion = '2024-10-21'
  try {
    const config = JSON.parse(row.configJson || '{}') as { apiVersion?: unknown }
    if (typeof config.apiVersion === 'string' && config.apiVersion) apiVersion = config.apiVersion
  } catch { /* keep default */ }
  const { azureHeaders, azureUrl } = await import('@/lib/ai/azure')
  const body: Record<string, unknown> = {
    model: row.model,
    messages: toOpenAiMessages(messages),
    temperature: opts.temperature ?? 0.4,
  }
  if (opts.maxTokens) body.max_tokens = opts.maxTokens
  if (opts.tools?.length) {
    body.tools = opts.tools
    body.tool_choice = 'auto'
  }
  const res = await fetchWithTimeout(azureUrl(row.baseUrl, row.model, 'chat/completions', apiVersion), {
    method: 'POST',
    headers: azureHeaders(key),
    body: JSON.stringify(body),
    timeoutMs: opts.timeoutMs ?? 90_000,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new AiUnavailableError(`Azure OpenAI returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`)
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const message = data.choices?.[0]?.message
  const content = message?.content ?? ''
  const toolCalls: LlmToolCall[] = (message?.tool_calls ?? [])
    .filter((tc) => tc?.function?.name)
    .map((tc, i) => ({ id: tc.id || `call_${i}`, name: String(tc.function?.name), args: parseToolArgs(tc.function?.arguments) }))
  if (!content && toolCalls.length === 0) throw new AiUnavailableError('Azure OpenAI returned an empty response')
  return {
    content,
    toolCalls,
    provider: 'azure_openai',
    model: row.model,
    latencyMs: 0,
    tokensIn: data.usage?.prompt_tokens ?? 0,
    tokensOut: data.usage?.completion_tokens ?? 0,
  }
}

/* ---------------- streaming ---------------- */

export type StreamHandlers = {
  /** Called for every text fragment the model produced. */
  onDelta: (delta: string) => void
  /** Called once when the provider finished. */
  onDone?: (info: { tokensIn?: number; tokensOut?: number; toolCalls?: LlmToolCall[] }) => void
}

async function readSse(res: Response, onEvent: (data: string) => void): Promise<void> {
  const reader = res.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      if (line.startsWith('data:')) onEvent(line.slice(5).trim())
    }
  }
  const tail = buffer.trim()
  if (tail.startsWith('data:')) onEvent(tail.slice(5).trim())
}

/**
 * Stream a completion.
 *
 * OpenAI-compatible endpoints speak SSE (`data: {"choices":[{"delta":{"content":"…"}}]}`),
 * Ollama speaks newline-delimited JSON. When the provider refuses to stream
 * (or streaming is disabled in the provider config) the call degrades to the
 * regular one-shot completion and the whole text arrives as a single delta —
 * the caller never has to special-case it.
 */
export async function streamChat(
  orgId: string,
  messages: LlmMessage[],
  opts: { temperature?: number; maxTokens?: number; conversationId?: string; timeoutMs?: number; tools?: LlmToolSpec[] } & StreamHandlers
): Promise<LlmResult> {
  const row = await resolveProvider(orgId)
  const flags = providerFlags(row)
  const { onDelta, onDone, ...rest } = opts

  if (!flags.streaming) {
    const result = await chatComplete(orgId, messages, { ...rest })
    if (result.content) onDelta(result.content)
    onDone?.({ tokensIn: result.tokensIn, tokensOut: result.tokensOut, toolCalls: result.toolCalls })
    return result
  }

  const started = Date.now()
  let emitted = 0
  const emit = (delta: string) => {
    if (!delta) return
    emitted += delta.length
    onDelta(delta)
  }
  try {
    if (row.provider === 'ollama') {
      const body: Record<string, unknown> = {
        model: row.model || 'llama3.2',
        messages: toOllamaMessages(messages),
        stream: true,
        options: { temperature: rest.temperature ?? 0.4, ...(rest.maxTokens ? { num_predict: rest.maxTokens } : {}) },
      }
      if (rest.tools?.length) body.tools = rest.tools
      else body.format = 'json'

      const res = await fetchWithTimeout(`${row.baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: rest.timeoutMs ?? 120_000,
      })
      if (!res.ok) throw new AiUnavailableError(`Ollama returned HTTP ${res.status}. Is the server running at ${row.baseUrl}?`)

      let content = ''
      let tokensIn: number | undefined
      let tokensOut: number | undefined
      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = (await reader?.read()) ?? { done: true, value: undefined }
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (!line) continue
          try {
            const chunk = JSON.parse(line) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number; done?: boolean }
            const delta = chunk.message?.content ?? ''
            if (delta) {
              content += delta
              emit(delta)
            }
            if (typeof chunk.prompt_eval_count === 'number') tokensIn = chunk.prompt_eval_count
            if (typeof chunk.eval_count === 'number') tokensOut = chunk.eval_count
          } catch {
            /* ignore partial/invalid lines */
          }
        }
      }

      const latencyMs = Date.now() - started
      await logAi(orgId, { capability: 'llm', provider: row.provider, model: row.model, latencyMs, tokensIn: tokensIn ?? 0, tokensOut: tokensOut ?? 0, ok: true, conversationId: rest.conversationId })
      onDone?.({ tokensIn, tokensOut })
      return { content, toolCalls: [], provider: row.provider, model: row.model, latencyMs, tokensIn: tokensIn ?? 0, tokensOut: tokensOut ?? 0 }
    }

    if (row.provider === 'openai_compatible') {
      const key = getApiKey(row)
      const body: Record<string, unknown> = {
        model: row.model,
        messages: toOpenAiMessages(messages),
        temperature: rest.temperature ?? 0.4,
        stream: true,
      }
      if (rest.maxTokens) body.max_tokens = rest.maxTokens
      if (rest.tools?.length) {
        body.tools = rest.tools
        body.tool_choice = 'auto'
      }

      const res = await fetchWithTimeout(`${row.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
        timeoutMs: rest.timeoutMs ?? 120_000,
      })
      if (!res.ok) throw new AiUnavailableError(`Endpoint returned HTTP ${res.status}`)

      let content = ''
      let tokensIn: number | undefined
      let tokensOut: number | undefined
      // Tool calls arrive in fragments: the name in the first frame, the JSON
      // arguments split across the following ones.
      const frames: ToolCallFrame[] = []
      await readSse(res, (raw) => {
        if (!raw || raw === '[DONE]') return
        try {
          const chunk = JSON.parse(raw) as {
            choices?: Array<{
              delta?: {
                content?: string | null
                tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
              }
              message?: { content?: string | null }
            }>
            usage?: { prompt_tokens?: number; completion_tokens?: number }
          }
          const delta = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? ''
          if (delta) {
            content += delta
            emit(delta)
          }
          for (const tc of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
            frames.push({ index: tc.index, id: tc.id, name: tc.function?.name, argsText: tc.function?.arguments })
          }
          if (typeof chunk.usage?.prompt_tokens === 'number') tokensIn = chunk.usage.prompt_tokens
          if (typeof chunk.usage?.completion_tokens === 'number') tokensOut = chunk.usage.completion_tokens
        } catch {
          /* ignore partial frames */
        }
      })

      const toolCalls: LlmToolCall[] = mergeToolCallFrames(frames)

      const latencyMs = Date.now() - started
      await logAi(orgId, { capability: 'llm', provider: row.provider, model: row.model, latencyMs, tokensIn: tokensIn ?? 0, tokensOut: tokensOut ?? 0, ok: true, conversationId: rest.conversationId })
      onDone?.({ tokensIn, tokensOut, toolCalls })
      return { content, toolCalls, provider: row.provider, model: row.model, latencyMs, tokensIn: tokensIn ?? 0, tokensOut: tokensOut ?? 0 }
    }

    if (row.provider === 'anthropic') {
      const key = getApiKey(row)
      if (!key) throw new AiUnavailableError('Anthropic API key is not configured')
      const { anthropicHeaders, anthropicRequestBody, normalizeAnthropicBase, parseAnthropicStreamEvent } = await import('@/lib/ai/anthropic')
      const res = await fetchWithTimeout(`${normalizeAnthropicBase(row.baseUrl)}/messages`, {
        method: 'POST',
        headers: anthropicHeaders(key),
        body: JSON.stringify(anthropicRequestBody(row.model, messages, {
          temperature: rest.temperature ?? 0.4,
          maxTokens: rest.maxTokens ?? 1024,
          stream: true,
        })),
        timeoutMs: rest.timeoutMs ?? 120_000,
      })
      if (!res.ok) throw new AiUnavailableError(`Anthropic returned HTTP ${res.status}`)

      let content = ''
      let tokensIn: number | undefined
      let tokensOut: number | undefined
      await readSse(res, (raw) => {
        const event = parseAnthropicStreamEvent(raw)
        if (event.delta) {
          content += event.delta
          emit(event.delta)
        }
        if (typeof event.tokensIn === 'number') tokensIn = event.tokensIn
        if (typeof event.tokensOut === 'number') tokensOut = event.tokensOut
      })
      const latencyMs = Date.now() - started
      await logAi(orgId, { capability: 'llm', provider: row.provider, model: row.model, latencyMs, tokensIn: tokensIn ?? 0, tokensOut: tokensOut ?? 0, ok: true, conversationId: rest.conversationId })
      onDone?.({ tokensIn, tokensOut, toolCalls: [] })
      return { content, toolCalls: [], provider: 'anthropic', model: row.model, latencyMs, tokensIn: tokensIn ?? 0, tokensOut: tokensOut ?? 0 }
    }

    if (row.provider === 'google') {
      const key = getApiKey(row)
      if (!key) throw new AiUnavailableError('Gemini API key is not configured')
      const { googleHeaders, googleRequestBody, normalizeGoogleBase, parseGoogleStreamEvent } = await import('@/lib/ai/google')
      const res = await fetchWithTimeout(`${normalizeGoogleBase(row.baseUrl)}/models/${encodeURIComponent(row.model)}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: googleHeaders(key),
        body: JSON.stringify(googleRequestBody(messages, { temperature: rest.temperature, maxTokens: rest.maxTokens })),
        timeoutMs: rest.timeoutMs ?? 120_000,
      })
      if (!res.ok) throw new AiUnavailableError(`Gemini returned HTTP ${res.status}`)

      let content = ''
      let tokensIn: number | undefined
      let tokensOut: number | undefined
      await readSse(res, (raw) => {
        const event = parseGoogleStreamEvent(raw)
        if (event.delta) {
          content += event.delta
          emit(event.delta)
        }
        if (typeof event.tokensIn === 'number') tokensIn = event.tokensIn
        if (typeof event.tokensOut === 'number') tokensOut = event.tokensOut
      })
      const latencyMs = Date.now() - started
      await logAi(orgId, { capability: 'llm', provider: row.provider, model: row.model, latencyMs, tokensIn: tokensIn ?? 0, tokensOut: tokensOut ?? 0, ok: true, conversationId: rest.conversationId })
      onDone?.({ tokensIn, tokensOut, toolCalls: [] })
      return { content, toolCalls: [], provider: 'google', model: row.model, latencyMs, tokensIn: tokensIn ?? 0, tokensOut: tokensOut ?? 0 }
    }

    if (row.provider === 'azure_openai') {
      const key = getApiKey(row)
      if (!key) throw new AiUnavailableError('Azure OpenAI API key is not configured')
      let apiVersion = '2024-10-21'
      try {
        const config = JSON.parse(row.configJson || '{}') as { apiVersion?: unknown }
        if (typeof config.apiVersion === 'string' && config.apiVersion) apiVersion = config.apiVersion
      } catch { /* keep default */ }
      const { azureHeaders, azureUrl } = await import('@/lib/ai/azure')
      const body: Record<string, unknown> = {
        model: row.model,
        messages: toOpenAiMessages(messages),
        temperature: rest.temperature ?? 0.4,
        stream: true,
      }
      if (rest.maxTokens) body.max_tokens = rest.maxTokens
      if (rest.tools?.length) {
        body.tools = rest.tools
        body.tool_choice = 'auto'
      }
      const res = await fetchWithTimeout(azureUrl(row.baseUrl, row.model, 'chat/completions', apiVersion), {
        method: 'POST',
        headers: azureHeaders(key),
        body: JSON.stringify(body),
        timeoutMs: rest.timeoutMs ?? 120_000,
      })
      if (!res.ok) throw new AiUnavailableError(`Azure OpenAI returned HTTP ${res.status}`)

      let content = ''
      let tokensIn: number | undefined
      let tokensOut: number | undefined
      const frames: ToolCallFrame[] = []
      await readSse(res, (raw) => {
        if (!raw || raw === '[DONE]') return
        try {
          const chunk = JSON.parse(raw) as {
            choices?: Array<{
              delta?: {
                content?: string | null
                tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
              }
            }>
            usage?: { prompt_tokens?: number; completion_tokens?: number }
          }
          const delta = chunk.choices?.[0]?.delta?.content ?? ''
          if (delta) {
            content += delta
            emit(delta)
          }
          for (const tc of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
            frames.push({ index: tc.index, id: tc.id, name: tc.function?.name, argsText: tc.function?.arguments })
          }
          if (typeof chunk.usage?.prompt_tokens === 'number') tokensIn = chunk.usage.prompt_tokens
          if (typeof chunk.usage?.completion_tokens === 'number') tokensOut = chunk.usage.completion_tokens
        } catch { /* ignore partial frames */ }
      })
      const toolCalls = mergeToolCallFrames(frames)
      const latencyMs = Date.now() - started
      await logAi(orgId, { capability: 'llm', provider: row.provider, model: row.model, latencyMs, tokensIn: tokensIn ?? 0, tokensOut: tokensOut ?? 0, ok: true, conversationId: rest.conversationId })
      onDone?.({ tokensIn, tokensOut, toolCalls })
      return { content, toolCalls, provider: 'azure_openai', model: row.model, latencyMs, tokensIn: tokensIn ?? 0, tokensOut: tokensOut ?? 0 }
    }

    throw new AiUnavailableError(`Provider kind "${row.provider}" cannot serve conversations`)
  } catch (err) {
    // A provider that refuses to stream must not break the answer: fall back to
    // the one-shot path and deliver the whole text as a single delta.
    if (err instanceof AiUnavailableError && err.status === 503 && !rest.tools?.length && emitted === 0) {
      const result = await chatComplete(orgId, messages, { ...rest })
      if (result.content) onDelta(result.content)
      onDone?.({ tokensIn: result.tokensIn, tokensOut: result.tokensOut, toolCalls: result.toolCalls })
      return result
    }
    throw err
  }
}
