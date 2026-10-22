/**
 * Pure protocol helpers for the LLM layer (no runtime imports — unit-testable
 * with `node:test`).
 *
 * They translate between our normalized message/tool shapes and the wire
 * shapes of the two supported provider families:
 *  - OpenAI-compatible chat completions (`tools`, `tool_calls`, `role:"tool"`)
 *  - Ollama `/api/chat` (same `tools` shape, tool results as `role:"tool"`)
 */

/** A provider-native function/tool definition (OpenAI `tools` shape). */
export type LlmToolSpec = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** A tool call the model asked for, normalized across providers. */
export type LlmToolCallPayload = { id: string; name: string; args: Record<string, unknown> }

export type LlmToolCall = LlmToolCallPayload

/**
 * A chat message. The assistant variant may carry provider-native tool calls
 * (the provider echoes them back) and the `tool` variant carries a tool result.
 */
export type LlmMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCallPayload[] }
  | { role: 'tool'; content: string; toolCallId?: string; name?: string }

/** Parse a JSON argument payload that may arrive as an object or a JSON string. */
export function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return {}
}

/** Map our messages onto the OpenAI chat-completions wire shape. */
export function toOpenAiMessages(messages: LlmMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '', ...(m.name ? { name: m.name } : {}) }
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } })),
      }
    }
    return { role: m.role, content: m.content }
  })
}

/** Map our messages onto the Ollama chat shape. */
export function toOllamaMessages(messages: LlmMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => ({ role: m.role, content: m.content }))
}

/**
 * One streamed tool-call fragment as providers send them: the name arrives in
 * the first frame, the JSON arguments are split across the following frames.
 */
export type ToolCallFrame = { index?: number; id?: string; name?: string; argsText?: string }

/**
 * Merge streamed tool-call fragments into complete tool calls.
 * Fragments without a name are ignored (an incomplete call is never executed).
 */
export function mergeToolCallFrames(frames: ToolCallFrame[]): LlmToolCall[] {
  const pending = new Map<number, { id: string; name: string; argsText: string }>()
  for (const frame of frames) {
    const idx = frame.index ?? 0
    const current = pending.get(idx) ?? { id: frame.id ?? `call_${idx}`, name: '', argsText: '' }
    if (frame.id) current.id = frame.id
    if (frame.name) current.name = frame.name
    if (frame.argsText) current.argsText += frame.argsText
    pending.set(idx, current)
  }
  return [...pending.values()]
    .filter((tc) => tc.name)
    .map((tc, i) => ({ id: tc.id || `call_${i}`, name: tc.name, args: parseToolArgs(tc.argsText) }))
}

/**
 * Split a raw SSE buffer into complete `data:` payloads.
 * Returns the frames and the remainder that is still incomplete.
 */
export function splitSseFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = []
  let rest = buffer
  for (;;) {
    const idx = rest.indexOf('\n\n')
    if (idx < 0) break
    const frame = rest.slice(0, idx)
    rest = rest.slice(idx + 2)
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('')
    if (data) frames.push(data)
  }
  return { frames, rest }
}
