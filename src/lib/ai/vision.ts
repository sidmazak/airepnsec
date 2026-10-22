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
  if (row.provider !== 'openai_compatible') {
    throw new Error(`Provider kind "${row.provider}" cannot read images.`)
  }
  await assertAiPolicy(orgId, row.provider, row.baseUrl)

  const key = getApiKey(row)
  const started = Date.now()
  const dataUri = `data:${input.mimeType};base64,${input.imageBase64}`

  const res = await fetch(`${row.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
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
    signal: AbortSignal.timeout(60_000),
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
