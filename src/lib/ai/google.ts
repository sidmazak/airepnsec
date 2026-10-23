import type { LlmMessage } from './llm-protocol.ts'

/**
 * Google Gemini adapter helpers (pure — unit-testable).
 * Native Generative Language API: POST {base}/models/{model}:generateContent.
 */

export function normalizeGoogleBase(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (!base) return ''
  return /\/(v1beta|v1)$/i.test(base) ? base : `${base}/v1beta`
}

export function googleHeaders(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(apiKey ? { 'x-goog-api-key': apiKey } : {}),
  }
}

/** Map our turns onto Gemini `contents` and move system prompts to systemInstruction. */
export function toGoogleContents(messages: LlmMessage[]): {
  system: string
  contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>
} {
  const systemParts: string[] = []
  const turns: Array<{ role: 'user' | 'model'; text: string }> = []
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content)
      continue
    }
    if (message.role === 'assistant') turns.push({ role: 'model', text: message.content })
    else if (message.role === 'tool') turns.push({ role: 'user', text: `Tool result${message.name ? ` (${message.name})` : ''}: ${message.content}` })
    else turns.push({ role: 'user', text: message.content })
  }
  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = []
  for (const turn of turns) {
    const last = contents[contents.length - 1]
    if (last && last.role === turn.role) last.parts[0].text = `${last.parts[0].text}\n\n${turn.text}`
    else contents.push({ role: turn.role, parts: [{ text: turn.text }] })
  }
  if (contents.length === 0) contents.push({ role: 'user', parts: [{ text: '' }] })
  return { system: systemParts.join('\n\n'), contents }
}

export type GoogleBodyOptions = { temperature?: number; maxTokens?: number }

export function googleRequestBody(messages: LlmMessage[], options: GoogleBodyOptions = {}): Record<string, unknown> {
  const { system, contents } = toGoogleContents(messages)
  const body: Record<string, unknown> = { contents }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  const generationConfig: Record<string, unknown> = {}
  if (typeof options.temperature === 'number') generationConfig.temperature = options.temperature
  if (options.maxTokens) generationConfig.maxOutputTokens = options.maxTokens
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig
  return body
}

export function parseGoogleResponse(data: unknown): {
  content: string
  tokensIn: number
  tokensOut: number
} {
  const payload = data as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  }
  const parts = payload.candidates?.[0]?.content?.parts ?? []
  return {
    content: parts.map((p) => p.text ?? '').join(''),
    tokensIn: payload.usageMetadata?.promptTokenCount ?? 0,
    tokensOut: payload.usageMetadata?.candidatesTokenCount ?? 0,
  }
}

export function parseGoogleStreamEvent(raw: string): { delta?: string; tokensIn?: number; tokensOut?: number } {
  try {
    const event = JSON.parse(raw) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
    }
    const delta = (event.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('')
    return {
      ...(delta ? { delta } : {}),
      ...(typeof event.usageMetadata?.promptTokenCount === 'number' ? { tokensIn: event.usageMetadata.promptTokenCount } : {}),
      ...(typeof event.usageMetadata?.candidatesTokenCount === 'number' ? { tokensOut: event.usageMetadata.candidatesTokenCount } : {}),
    }
  } catch {
    return {}
  }
}
