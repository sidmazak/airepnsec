import { withAuth, json } from '@/lib/api'
import { detectHardware, recommendModels, bestChatModel } from '@/lib/system/hardware'
import { db } from '@/lib/db'

/**
 * GET /api/system/hardware — what this machine can run.
 *
 * Reads the host CPU/RAM/GPU/disk and pairs it with the model catalog, so
 * "which model should I run?" is answered by the app instead of the docs.
 * Nothing is sent anywhere — the probe is local.
 */
export const GET = withAuth(async (_req, ctx) => {
  const hardware = await detectHardware()
  const recommendations = recommendModels(hardware)

  // What the org uses today, so the UI can compare "configured" vs "recommended".
  const configured = await db.providerConfig.findMany({
    where: { orgId: ctx.org.id },
    select: { capability: true, provider: true, model: true, enabled: true },
  })

  return json({
    hardware,
    recommendations,
    recommendedChatModel: bestChatModel(recommendations),
    configured: configured.map((c) => ({ capability: c.capability, provider: c.provider, model: c.model, enabled: c.enabled })),
  })
}, { roles: ['owner', 'admin'] })
