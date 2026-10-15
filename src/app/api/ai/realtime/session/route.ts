import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { withAuth, json, ApiError } from '@/lib/api'
import { assertAiPolicy, getApiKey, getActiveProvider } from '@/lib/ai/providers'
import { REALTIME_TOOLS } from '@/lib/ai/receptionist'

// POST /api/ai/realtime/session — mint a short-lived client secret for the OpenAI
// Realtime API (WebRTC) using the org's OpenAI-compatible provider. The browser uses
// the returned `clientSecret` to open a WebRTC peer connection to the realtime
// endpoint. Tool calling still goes through our validated receptionist tools.
export const POST = withAuth(async (req, ctx) => {
  const body = await req.json().catch(() => ({}))
  const model = typeof body?.model === 'string' && body.model ? body.model : 'gpt-4o-realtime-preview'
  const instructions = typeof body?.instructions === 'string' ? body.instructions : 'You are an AI receptionist. Be concise and helpful. Use provided tools for business data.'
  const tools = Array.isArray(body?.tools) ? body.tools : REALTIME_TOOLS

  // Prefer a dedicated realtime provider row; fall back to the org's LLM row.
  let row = await db.providerConfig.findUnique({ where: { orgId_capability: { orgId: ctx.org.id, capability: 'realtime' } } })
  if (!row || !row.enabled) row = await getActiveProvider(ctx.org.id, 'llm')
  if (!row) throw new ApiError(503, 'No AI provider configured for realtime voice', 'ai_unavailable')
  if (row.provider !== 'openai_compatible') {
    throw new ApiError(503, 'OpenAI Realtime requires an OpenAI-compatible provider (set base URL + API key under AI Providers)', 'realtime_unsupported')
  }
  await assertAiPolicy(ctx.org.id, row.provider)
  const key = getApiKey(row)
  if (!key) throw new ApiError(503, 'API key missing for the realtime provider', 'realtime_no_key')

  const base = (row.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')
  const started = Date.now()
  let res: Response
  try {
    res = await fetch(`${base}/realtime/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, voice: (row.configJson ? (JSON.parse(row.configJson || '{}') as Record<string, unknown>).voice : undefined) || 'alloy', instructions, input_audio_transcription: { model: 'whisper-1' }, ...(tools.length ? { tools } : {}) }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    throw new ApiError(502, `Realtime session mint failed: ${err instanceof Error ? err.message : err}`, 'realtime_error')
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ApiError(502, `Realtime session mint failed (HTTP ${res.status}): ${text.slice(0, 200)}`, 'realtime_error')
  }
  const data = (await res.json()) as { client_secret?: { value?: string; expires_at?: number }; id?: string }
  const secret = data.client_secret?.value
  if (!secret) throw new ApiError(502, 'Realtime endpoint did not return a client secret', 'realtime_error')
  return json({
    provider: row.provider,
    model,
    clientSecret: secret,
    expiresAt: data.client_secret?.expires_at ?? null,
    realtimeUrl: 'wss://api.openai.com/v1/realtime',
    serverLatencyMs: Date.now() - started,
  })
}, { roles: ['owner', 'admin'] })
