import { z } from 'zod'
import { withAuth, json, fail, parseBody } from '@/lib/api'
import { audit } from '@/lib/audit'
import {
  deleteLocalSpeechModel,
  downloadLocalSpeechModel,
  findLocalSpeechModel,
  listLocalSpeechModels,
} from '@/lib/ai/localSpeech'

/**
 * GET /api/ai/speech/models — the local speech model catalog with the real
 * on-disk state of every model (installed / not installed) and the cache path.
 */
export const GET = withAuth(async (_req, ctx) => {
  const models = await listLocalSpeechModels()
  const installed = models.filter((m) => m.installed).length
  return json({
    models,
    cacheDir: models[0]?.cachePath ? models[0].cachePath.replace(/[\\/][^\\/]+[\\/][^\\/]+$/, '') : '.models',
    installed,
    total: models.length,
    orgId: ctx.org.id,
  })
}, { roles: ['owner', 'admin', 'agent'] })

const bodySchema = z.object({
  id: z.string().trim().min(1).max(80),
})

/**
 * POST /api/ai/speech/models {id} — download a local speech model into
 * `.models/`. The download is real: failures are reported as-is.
 */
export const POST = withAuth(
  async (req, ctx) => {
    const body = await parseBody(req, bodySchema)
    const model = findLocalSpeechModel(body.id)
    if (!model) return fail(404, `Unknown local speech model "${body.id}"`, { code: 'not_found' })

    const result = await downloadLocalSpeechModel(body.id)
    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'settings.local_speech_model_download',
      entity: 'local_speech_model',
      entityId: body.id,
      meta: { ok: result.ok, bytesOnDisk: result.bytesOnDisk },
    })
    if (!result.ok) return fail(502, result.detail, { code: 'download_failed' })
    const models = await listLocalSpeechModels()
    return json({ ok: true, detail: result.detail, model: models.find((m) => m.id === body.id) })
  },
  { roles: ['owner', 'admin'] }
)

/**
 * DELETE /api/ai/speech/models {id} — remove a downloaded model from the cache.
 */
export const DELETE = withAuth(
  async (req, ctx) => {
    const body = await parseBody(req, bodySchema)
    const model = findLocalSpeechModel(body.id)
    if (!model) return fail(404, `Unknown local speech model "${body.id}"`, { code: 'not_found' })

    const result = await deleteLocalSpeechModel(body.id)
    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'settings.local_speech_model_delete',
      entity: 'local_speech_model',
      entityId: body.id,
      meta: { ok: result.ok },
    })
    if (!result.ok) return fail(500, result.detail, { code: 'delete_failed' })
    const models = await listLocalSpeechModels()
    return json({ ok: true, detail: result.detail, models })
  },
  { roles: ['owner', 'admin'] }
)
