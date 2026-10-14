import { withAuth, json } from '@/lib/api'
import {
  getProviderRow,
  toPublicConfig,
  CAPABILITIES,
  CAPABILITY_INFO,
} from '@/lib/ai/providers'
import { ensureVoiceProviders } from '@/lib/ai/speech'

/**
 * GET /api/providers — full capability map, never secrets.
 * Missing rows are created on first read with honest defaults (mostly disabled).
 * Legacy stt/tts rows ('browser', never configured) are migrated to the managed
 * gateway so the voice console works out of the box.
 */
export const GET = withAuth(async (req, ctx) => {
  await ensureVoiceProviders(ctx.org.id)
  const capabilities: Record<string, ReturnType<typeof toPublicConfig>> = {}
  for (const capability of CAPABILITIES) {
    const row = await getProviderRow(ctx.org.id, capability)
    capabilities[capability] = toPublicConfig(row)
  }

  return json({
    capabilities,
    dataMode: ctx.org.dataMode,
    capabilityInfo: CAPABILITY_INFO,
  })
})
