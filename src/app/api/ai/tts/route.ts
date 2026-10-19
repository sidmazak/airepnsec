import { z } from 'zod'
import { withAuth, json, parseBody } from '@/lib/api'
import { synthesizeSpeech } from '@/lib/ai/speech'

const bodySchema = z.object({
  text: z.string().trim().min(1, 'text is required').max(4000),
  voice: z.string().trim().max(40).optional(),
  speed: z.coerce.number().min(0.5).max(2).optional(),
})

/** POST /api/ai/tts {text, voice?, speed?} — real speech synthesis for the voice console. */
export const POST = withAuth(async (req, ctx) => {
  const body = await parseBody(req, bodySchema)
  const result = await synthesizeSpeech(ctx.org.id, body.text, { voice: body.voice, speed: body.speed })
  return json({
    audio: result.chunks,
    provider: result.provider,
    model: result.model,
    latencyMs: result.latencyMs,
  })
}, { roles: ['owner', 'admin', 'agent'] })
