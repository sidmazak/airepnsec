import { z } from 'zod'
import { withAuth, json, fail, parseBody, ApiError } from '@/lib/api'
import { analyzeImage, isVisionMimeType, MAX_VISION_BASE64 } from '@/lib/ai/vision'

const schema = z.object({
  imageBase64: z.string().min(16, 'The image data is empty').max(MAX_VISION_BASE64, 'The image is too large (max ~4 MB)'),
  mimeType: z.string().min(1),
  prompt: z.string().trim().min(1, 'Tell the model what to look for').max(2000).default('Describe this image in detail.'),
})

/**
 * POST /api/ai/vision {imageBase64, mimeType, prompt} — read an image with the
 * configured vision model. The image is sent to the provider the org
 * configured; nothing is stored. Errors are honest: a missing or broken
 * vision model is reported, never faked.
 */
export const POST = withAuth(async (req, ctx) => {
  let body: z.infer<typeof schema>
  try {
    body = await parseBody(req, schema)
  } catch (err) {
    if (err instanceof ApiError) return fail(err.status, err.message, { code: err.code })
    return fail(400, 'Invalid request body', { code: 'bad_request' })
  }

  if (!isVisionMimeType(body.mimeType)) {
    return fail(422, `Unsupported image type "${body.mimeType}". Use PNG, JPEG, WebP or GIF.`, { code: 'bad_mime' })
  }

  try {
    const result = await analyzeImage(ctx.org.id, {
      imageBase64: body.imageBase64,
      mimeType: body.mimeType,
      prompt: body.prompt,
    })
    return json({ text: result.text, provider: result.provider, model: result.model, latencyMs: result.latencyMs })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The vision model could not be reached'
    return fail(503, message, { code: 'vision_unavailable' })
  }
}, { roles: ['owner', 'admin', 'agent'] })
