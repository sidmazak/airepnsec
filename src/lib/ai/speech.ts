import { db } from '@/lib/db'
import { ApiError } from '@/lib/api'
import { getActiveProvider, getApiKey, assertAiPolicy, type Capability } from '@/lib/ai/providers'

/**
 * Real speech pipeline (STT + TTS) routed through the org's provider config —
 * same BYOK/policy layer as chat:
 *  - openai_compatible → POST {base}/audio/transcriptions (multipart) and POST {base}/audio/speech
 * Anything else (browser/none/ollama) is honestly "not usable server-side".
 *
 * Local-only data mode blocks external endpoints via assertAiPolicy, same as chat.
 */

export const TTS_VOICES = ['tongtong', 'chuichui', 'xiaochen', 'jam', 'kazi', 'douji', 'luodo'] as const
export const DEFAULT_TTS_VOICE = 'tongtong'

export type SpeechResult = {
  text: string
  provider: string
  model: string
  latencyMs: number
}

export type SpeechAudio = {
  chunks: Array<{ mime: string; b64: string }>
  provider: string
  model: string
  latencyMs: number
}

async function logSpeech(orgId: string, capability: 'stt' | 'tts', provider: string, model: string, latencyMs: number, ok: boolean, errorSanitized = '') {
  try {
    await db.aiLog.create({ data: { orgId, capability, provider, model, latencyMs, ok, errorSanitized: errorSanitized.slice(0, 300) } })
  } catch (err) {
    console.error('[ai-log] speech log failed', err instanceof Error ? err.message : err)
  }
}

function sanitize(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/(sk[-_][A-Za-z0-9-_]{8,})/g, '[redacted]')
}

/**
 * Legacy cleanup: rows left on the retired 'managed' provider kind (which is no
 * longer supported) are reset to the browser path so the voice console remains
 * honest rather than pointing at a provider that cannot run.
 */
async function ensureVoiceProvider(orgId: string, capability: 'stt' | 'tts') {
  const row = await db.providerConfig.findUnique({ where: { orgId_capability: { orgId, capability } } })
  if (row && row.provider === 'managed') {
    return db.providerConfig.update({
      where: { id: row.id },
      data: { provider: 'browser', enabled: true, lastTestOk: false, lastTestError: '' },
    })
  }
  return row
}

/** Normalize both voice capabilities — used by GET /api/providers so the UI shows real status. */
export async function ensureVoiceProviders(orgId: string) {
  await ensureVoiceProvider(orgId, 'stt')
  await ensureVoiceProvider(orgId, 'tts')
}

async function getSpeechProvider(orgId: string, capability: 'stt' | 'tts') {
  await ensureVoiceProvider(orgId, capability)
  const row = await getActiveProvider(orgId, capability as Capability)
  if (!row) {
    throw new ApiError(
      503,
      `Speech ${capability === 'stt' ? 'recognition' : 'synthesis'} is not configured. Enable it under AI Providers (the built-in gateway works out of the box).`,
      'speech_not_configured'
    )
  }
  if (row.provider !== 'openai_compatible' && row.provider !== 'ollama') {
    throw new ApiError(503, `Provider "${row.provider}" cannot serve ${capability} on the server. Use an OpenAI-compatible endpoint, or the browser mic/speech path in the Voice Console.`, 'speech_provider_unsupported')
  }
  await assertAiPolicy(orgId, row.provider)
  return row
}

/* ---------------- STT ---------------- */

export async function transcribeAudio(orgId: string, audio: Buffer, mime: string): Promise<SpeechResult> {
  const row = await getSpeechProvider(orgId, 'stt')
  const started = Date.now()
  const model = row.model || 'default'
  try {
    // OpenAI-compatible multipart transcription (e.g. whisper-v3 on any compatible host)
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime || 'audio/webm' }), 'audio')
    form.append('model', row.model || 'whisper-1')
    const res = await fetch(`${row.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: getApiKey(row) ? { authorization: `Bearer ${getApiKey(row)}` } : {},
      body: form,
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`Transcription endpoint returned HTTP ${res.status}`)
    const data = (await res.json()) as { text?: string }
    const text = String(data.text ?? '').trim()
    const latencyMs = Date.now() - started
    if (!text) throw new Error('The speech service returned an empty transcript — was the recording silent?')
    await logSpeech(orgId, 'stt', row.provider, model, latencyMs, true)
    return { text, provider: row.provider, model, latencyMs }
  } catch (err) {
    const latencyMs = Date.now() - started
    const msg = sanitize(err)
    await logSpeech(orgId, 'stt', row.provider, model, latencyMs, false, msg)
    throw new ApiError(502, `Speech-to-text failed: ${msg.slice(0, 220)}`, 'stt_failed')
  }
}

/* ---------------- TTS ---------------- */

import { chunkForTts } from '@/lib/ai/tts-chunk'
export { chunkForTts } from '@/lib/ai/tts-chunk'

export async function synthesizeSpeech(orgId: string, text: string, opts: { voice?: string; speed?: number } = {}): Promise<SpeechAudio> {
  const row = await getSpeechProvider(orgId, 'tts')
  const started = Date.now()

  const cfg = (() => { try { return JSON.parse(row.configJson || '{}') as Record<string, unknown> } catch { return {} } })()
  const voice = opts.voice || (typeof cfg.voice === 'string' && cfg.voice) || DEFAULT_TTS_VOICE
  const speed = Math.min(2, Math.max(0.5, typeof opts.speed === 'number' && opts.speed > 0 ? opts.speed : 1))
  const chunks = chunkForTts(text)
  if (chunks.length === 0) throw new ApiError(400, 'Nothing to speak — the text is empty', 'empty_text')
  const model = row.model || 'default'

  try {
    const key = getApiKey(row)
    const out: Array<{ mime: string; b64: string }> = []
    for (const chunk of chunks) {
      const res = await fetch(`${row.baseUrl.replace(/\/$/, '')}/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: row.model || 'tts-1', input: chunk, voice: typeof cfg.openaiVoice === 'string' ? cfg.openaiVoice : 'alloy', speed, response_format: 'mp3' }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) throw new Error(`Speech endpoint returned HTTP ${res.status}`)
      const buf = Buffer.from(new Uint8Array(await res.arrayBuffer()))
      if (buf.length === 0) throw new Error('The speech endpoint returned empty audio')
      out.push({ mime: 'audio/mpeg', b64: buf.toString('base64') })
    }
    const latencyMs = Date.now() - started
    await logSpeech(orgId, 'tts', row.provider, model, latencyMs, true)
    return { chunks: out, provider: row.provider, model, latencyMs }
  } catch (err) {
    const latencyMs = Date.now() - started
    const msg = sanitize(err)
    await logSpeech(orgId, 'tts', row.provider, model, latencyMs, false, msg)
    throw new ApiError(502, `Text-to-speech failed: ${msg.slice(0, 220)}`, 'tts_failed')
  }
}
