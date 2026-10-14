import { db } from '@/lib/db'
import { ApiError } from '@/lib/api'
import { getActiveProvider, getApiKey, assertAiPolicy, type Capability } from '@/lib/ai/providers'

/**
 * Real speech pipeline (STT + TTS) routed through the org's provider config —
 * same BYOK/policy layer as chat:
 *  - managed           → built-in gateway via z-ai-web-dev-sdk (STT: audio.asr, TTS: audio.tts)
 *  - openai_compatible → POST {base}/audio/transcriptions (multipart) and POST {base}/audio/speech
 * Anything else (browser/none/ollama) is honestly "not usable server-side".
 *
 * Local-only data mode blocks managed/openai_compatible via assertAiPolicy, same as chat.
 */

export const TTS_VOICES = ['tongtong', 'chuichui', 'xiaochen', 'jam', 'kazi', 'douji', 'luodo'] as const
export const DEFAULT_TTS_VOICE = 'tongtong'
const TTS_MAX_INPUT = 1000 // API limit is 1024; leave headroom

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
 * Existing orgs may have stt/tts rows created with the legacy default
 * ('browser', disabled — nothing runnable server-side). Migrate untouched rows
 * to the managed gateway so the voice console works out of the box. Rows that
 * were deliberately configured are never touched.
 */
async function ensureVoiceProvider(orgId: string, capability: 'stt' | 'tts') {
  const row = await db.providerConfig.findUnique({ where: { orgId_capability: { orgId, capability } } })
  if (row && row.provider === 'browser' && !row.apiKeyEnc && !row.lastTestAt && !row.baseUrl) {
    return db.providerConfig.update({ where: { id: row.id }, data: { provider: 'managed', enabled: true } })
  }
  return row
}

/** Migrate both voice capabilities — used by GET /api/providers so the UI shows real status. */
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
  if (row.provider !== 'managed' && row.provider !== 'openai_compatible') {
    throw new ApiError(503, `Provider "${row.provider}" cannot serve ${capability} on the server. Use the built-in gateway or an OpenAI-compatible endpoint.`, 'speech_provider_unsupported')
  }
  await assertAiPolicy(orgId, row.provider)
  return row
}

/* ---------------- STT ---------------- */

export async function transcribeAudio(orgId: string, audio: Buffer, mime: string): Promise<SpeechResult> {
  const row = await getSpeechProvider(orgId, 'stt')
  const started = Date.now()
  const model = row.model || 'managed-default'
  try {
    let text = ''
    if (row.provider === 'managed') {
      const ZAI = (await import('z-ai-web-dev-sdk')).default
      const zai = await ZAI.create()
      const res = await zai.audio.asr.create({ file_base64: audio.toString('base64') })
      text = String((res as { text?: string })?.text ?? '').trim()
    } else {
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
      text = String(data.text ?? '').trim()
    }
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

/** Split into sentence-bounded chunks within the API's per-request limit. */
export function chunkForTts(text: string, max = TTS_MAX_INPUT): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  const sentences = clean.match(/[^.!?…]+[.!?…]+["')\]]?|[^.!?…]+$/g) ?? [clean]
  const chunks: string[] = []
  let cur = ''
  for (const s of sentences) {
    const piece = s.trim()
    if (!piece) continue
    if (piece.length > max) {
      // hard-split pathological run-on text at word boundaries
      if (cur) { chunks.push(cur.trim()); cur = '' }
      let rest = piece
      while (rest.length > max) {
        let cut = rest.lastIndexOf(' ', max)
        if (cut < max * 0.5) cut = max
        chunks.push(rest.slice(0, cut).trim())
        rest = rest.slice(cut)
      }
      if (rest.trim()) cur = rest.trim()
      continue
    }
    if ((cur + ' ' + piece).trim().length <= max) cur = (cur + ' ' + piece).trim()
    else { if (cur) chunks.push(cur); cur = piece }
  }
  if (cur) chunks.push(cur.trim())
  return chunks.filter(Boolean)
}

export async function synthesizeSpeech(orgId: string, text: string, opts: { voice?: string; speed?: number } = {}): Promise<SpeechAudio> {
  const row = await getSpeechProvider(orgId, 'tts')
  const started = Date.now()

  const cfg = (() => { try { return JSON.parse(row.configJson || '{}') as Record<string, unknown> } catch { return {} } })()
  const voice = opts.voice || (typeof cfg.voice === 'string' && cfg.voice) || DEFAULT_TTS_VOICE
  const speed = Math.min(2, Math.max(0.5, typeof opts.speed === 'number' && opts.speed > 0 ? opts.speed : 1))
  const chunks = chunkForTts(text)
  if (chunks.length === 0) throw new ApiError(400, 'Nothing to speak — the text is empty', 'empty_text')
  const model = row.model || 'managed-default'

  try {
    const out: Array<{ mime: string; b64: string }> = []
    if (row.provider === 'managed') {
      const ZAI = (await import('z-ai-web-dev-sdk')).default
      const zai = await ZAI.create()
      for (const chunk of chunks) {
        const res = await zai.audio.tts.create({
          input: chunk,
          voice: voice as (typeof TTS_VOICES)[number],
          speed,
          response_format: 'wav',
          stream: false,
        })
        const buf = Buffer.from(new Uint8Array(await res.arrayBuffer()))
        if (buf.length === 0) throw new Error('The speech service returned empty audio')
        out.push({ mime: 'audio/wav', b64: buf.toString('base64') })
      }
    } else {
      const key = getApiKey(row)
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
