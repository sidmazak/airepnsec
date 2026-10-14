import { z } from 'zod'
import { withAuth, json, parseBody } from '@/lib/api'
import { transcribeAudio } from '@/lib/ai/speech'

const MAX_AUDIO_BYTES = 12 * 1024 * 1024 // ~12MB raw audio (≈ a 9-minute webm/opus recording)

const bodySchema = z.object({
  b64: z.string().min(64, 'audio payload is required'),
  mime: z.string().trim().max(100).optional(),
})

/**
 * POST /api/ai/asr {b64, mime?} — real speech-to-text for the voice console.
 * Audio is transcribed server-side; nothing is persisted after the text comes back.
 */
export const POST = withAuth(async (req, ctx) => {
  const body = await parseBody(req, bodySchema)
  const audio = Buffer.from(body.b64, 'base64')
  if (audio.length === 0) return json({ error: 'Audio payload decoded to zero bytes' }, 400)
  if (audio.length > MAX_AUDIO_BYTES) return json({ error: 'Recording too large — keep clips under ~90 seconds' }, 413)
  const result = await transcribeAudio(ctx.org.id, audio, body.mime ?? 'audio/webm')
  return json({ text: result.text, provider: result.provider, model: result.model, latencyMs: result.latencyMs })
})
