import { parseToolArgs, type LlmMessage, type LlmToolCall } from './llm-protocol.ts'

/**
 * Anthropic Messages API adapter helpers (pure — unit-testable).
 * Native Messages API: POST {base}/v1/messages with x-api-key + anthropic-version.
 */

export const ANTHROPIC_VERSION = '2023-06-01'

export function normalizeAnthropicBase(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (!base) return ''
  return /\/v1$/i.test(base) ? base : `${base}/v1`
}

export function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  }
}

/** Split the system prompt out and merge consecutive same-role turns. */
export function toAnthropicMessages(messages: LlmMessage[]): { system: string; messages: Array<Record<string, unknown>> } {
  const systemParts: string[] = []
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content)
      continue
    }
    if (message.role === 'assistant') {
      turns.push({ role: 'assistant', content: message.content })
      continue
    }
    if (message.role === 'tool') {
      turns.push({ role: 'user', content: `Tool result${message.name ? ` (${message.name})` : ''}: ${message.content}` })
      continue
    }
    turns.push({ role: 'user', content: message.content })
  }
  const merged: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const turn of turns) {
    const last = merged[merged.length - 1]
    if (last && last.role === turn.role) last.content = `${last.content}\n\n${turn.content}`
    else merged.push({ ...turn })
  }
  if (merged.length === 0) merged.push({ role: 'user', content: '' })
  return { system: systemParts.join('\n\n'), messages: merged }
}

export type AnthropicBodyOptions = { temperature?: number; maxTokens?: number; stream?: boolean }

export function anthropicRequestBody(
  model: string,
  messages: LlmMessage[],
  options: AnthropicBodyOptions = {}
): Record<string, unknown> {
  const { system, messages: turns } = toAnthropicMessages(messages)
  const body: Record<string, unknown> = {
    model,
    max_tokens: options.maxTokens ?? 1024,
    messages: turns,
  }
  if (system) body.system = system
  if (typeof options.temperature === 'number') {
    body.temperature = Math.max(0, Math.min(1, options.temperature))
  }
  if (options.stream) body.stream = true
  return body
}

export function parseAnthropicResponse(data: unknown): {
  content: string
  toolCalls: LlmToolCall[]
  tokensIn: number
  tokensOut: number
} {
  const payload = data as {
    content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  const texts: string[] = []
  const toolCalls: LlmToolCall[] = []
  for (const block of payload.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    if (block.type === 'tool_use' && block.name) {
      toolCalls.push({
        id: block.id || `call_${toolCalls.length}`,
        name: block.name,
        args: block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : parseToolArgs(block.input),
      })
    }
  }
  return {
    content: texts.join(''),
    toolCalls,
    tokensIn: payload.usage?.input_tokens ?? 0,
    tokensOut: payload.usage?.output_tokens ?? 0,
  }
}

export function parseAnthropicStreamEvent(raw: string): {
  delta?: string
  tokensIn?: number
  tokensOut?: number
  done?: boolean
} {
  try {
    const event = JSON.parse(raw) as {
      type?: string
      delta?: { type?: string; text?: string }
      usage?: { input_tokens?: number; output_tokens?: number }
      message?: { usage?: { input_tokens?: number } }
    }
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      return { delta: event.delta.text ?? '' }
    }
    if (event.type === 'message_start') return { tokensIn: event.message?.usage?.input_tokens }
    if (event.type === 'message_delta') {
      return { tokensIn: event.usage?.input_tokens, tokensOut: event.usage?.output_tokens }
    }
    if (event.type === 'message_stop') return { done: true }
    return {}
  } catch {
    return {}
  }
}
