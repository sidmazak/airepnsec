import { getActiveProvider, getApiKey, assertAiPolicy } from '@/lib/ai/providers'

/**
 * Vision.
 *
 * An optional capability that lets a multimodal model read an image (a photo of
 * a receipt, a price list, a damage photo). The provider is an
 * OpenAI-compatible chat endpoint that accepts image content parts:
 *
 *   { model, messages: [{ role: 'user', content: [
 *       { type: 'text', text: '...' },
 *       { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }
 *   ] }] }
 *
 * Nothing is faked: when no vision model is configured the caller gets an
 * honest error instead of a made-up description.
 */

export const VISION_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type VisionMimeType = (typeof VISION_MIME_TYPES)[number]

/** Maximum accepted image payload (base64 characters) — ~4 MB of image data. */
export const MAX_VISION_BASE64 = 6_000_000

/** A 1x1 transparent PNG — used for the connection test. */
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

export function isVisionMimeType(value: string): value is VisionMimeType {
  return (VISION_MIME_TYPES as readonly string[]).includes(value)
}

export type VisionResult = {
  text: string
  provider: string
  model: string
  latencyMs: number
}

/**
 * Ask the configured vision model about an image.
 * Throws a descriptive error when no usable provider is configured.
 */
export async function analyzeImage(
  orgId: string,
  input: { imageBase64: string; mimeType: string; prompt: string }
): Promise<VisionResult> {
  const row = await getActiveProvider(orgId, 'vision')
  if (!row) {
    throw new Error('No vision model is configured. Enable one in Settings → AI Providers (Vision) and try again.')
  }
  if (!row.baseUrl) throw new Error('The vision provider has no base URL configured.')
  await assertAiPolicy(orgId, row.provider, row.baseUrl)
  const key = getApiKey(row)
  const started = Date.now()
  const dataUri = `data:${input.mimeType};base64,${input.imageBase64}`

  if (row.provider === 'anthropic') {
    if (!key) throw new Error('The Anthropic vision provider has no API key configured.')
    const { anthropicHeaders, normalizeAnthropicBase, parseAnthropicResponse } = await import('@/lib/ai/anthropic')
    const res = await fetch(`${normalizeAnthropicBase(row.baseUrl)}/messages`, {
      method: 'POST',
      headers: anthropicHeaders(key),
      body: JSON.stringify({
        model: row.model,
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: input.mimeType, data: input.imageBase64 } },
            { type: 'text', text: input.prompt },
          ],
        }],
      }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) throw new Error(`Anthropic returned HTTP ${res.status}`)
    const text = parseAnthropicResponse(await res.json()).content.trim()
    if (!text) throw new Error('The vision model returned an empty answer.')
    return { text, provider: 'anthropic', model: row.model, latencyMs: Date.now() - started }
  }

  if (row.provider === 'google') {
    if (!key) throw new Error('The Gemini vision provider has no API key configured.')
    const { googleHeaders, normalizeGoogleBase, parseGoogleResponse } = await import('@/lib/ai/google')
    const res = await fetch(`${normalizeGoogleBase(row.baseUrl)}/models/${encodeURIComponent(row.model)}:generateContent`, {
      method: 'POST',
      headers: googleHeaders(key),
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: input.prompt },
            { inline_data: { mime_type: input.mimeType, data: input.imageBase64 } },
          ],
        }],
      }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) throw new Error(`Gemini returned HTTP ${res.status}`)
    const text = parseGoogleResponse(await res.json()).content.trim()
    if (!text) throw new Error('The vision model returned an empty answer.')
    return { text, provider: 'google', model: row.model, latencyMs: Date.now() - started }
  }

  if (row.provider !== 'openai_compatible' && row.provider !== 'azure_openai') {
    throw new Error(`Provider kind "${row.provider}" cannot read images.`)
  }

  const isAzure = row.provider === 'azure_openai'
  let endpoint = `${row.baseUrl.replace(/\/$/, '')}/chat/completions`
  let headers: Record<string, string> = { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }
  if (isAzure) {
    const { azureHeaders, azureUrl } = await import('@/lib/ai/azure')
    let apiVersion = '2024-10-21'
    try {
      const config = JSON.parse(row.configJson || '{}') as { apiVersion?: unknown }
      if (typeof config.apiVersion === 'string' && config.apiVersion) apiVersion = config.apiVersion
    } catch { /* keep default */ }
    endpoint = azureUrl(row.baseUrl, row.model, 'chat/completions', apiVersion)
    headers = azureHeaders(key)
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: row.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: input.prompt },
            { type: 'image_url', image_url: { url: dataUri } },
          ],
        },
      ],
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(90_000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`The vision endpoint returned HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`)
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> }
  const text = data.choices?.[0]?.message?.content ?? ''
  if (!text.trim()) throw new Error('The vision model returned an empty answer.')
  return { text: text.trim(), provider: row.provider, model: row.model, latencyMs: Date.now() - started }
}
