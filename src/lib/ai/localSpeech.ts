import path from 'node:path'
import fs from 'node:fs/promises'
import { encodeWavPcm16 } from '@/lib/ai/audio-wav'

/**
 * Local speech models (fully offline STT + TTS).
 *
 * The models run through transformers.js (ONNX Runtime) on this machine — no
 * API key, no audio leaving the server. Model files are cached in `.models/`
 * (the same folder the built-in embedding model uses) and are downloaded on
 * demand from the Hugging Face CDN.
 *
 * Honesty rules for this module:
 *  - a model counts as *installed* only when its ONNX weights are really on disk;
 *  - a download that fails reports the real error, never a fake success;
 *  - synthesis/transcription either produce audio/text or throw with the reason.
 *
 * The browser Web Speech path and OpenAI-compatible endpoints remain available
 * (see `src/lib/ai/speech.ts`) — this module is the fully-local option.
 */

export type LocalSpeechCapability = 'stt' | 'tts'

export type LocalSpeechModel = {
  /** Stable id used by the API and the provider config. */
  id: string
  capability: LocalSpeechCapability
  label: string
  /** Hugging Face repository that holds the ONNX weights. */
  repo: string
  /** transformers.js dtype — 'q8' keeps the download small. */
  dtype: string
  /** Rough download size in bytes (used as a hint, never as a promise). */
  approxBytes: number
  license: string
  notes: string
  /** Side-car files the model needs next to the weights (e.g. speaker embeddings). */
  extraFiles?: Array<{ name: string; url: string; approxBytes: number; kind: 'speaker_embeddings' }>
}

export const LOCAL_SPEECH_MODELS: LocalSpeechModel[] = [
  {
    id: 'mms-tts-eng',
    capability: 'tts',
    label: 'MMS TTS — English (VITS)',
    repo: 'Xenova/mms-tts-eng',
    dtype: 'q8',
    approxBytes: 42_000_000,
    license: 'Apache-2.0',
    notes: 'Small and fast enough for a self-hosted server. One voice, 16 kHz output.',
  },
  {
    id: 'whisper-tiny-en',
    capability: 'stt',
    label: 'Whisper tiny.en — English only',
    repo: 'onnx-community/whisper-tiny.en',
    dtype: 'q8',
    approxBytes: 45_000_000,
    license: 'Apache-2.0',
    notes: 'Fastest local transcription. Accuracy is limited — good for short commands.',
  },
  {
    id: 'whisper-base',
    capability: 'stt',
    label: 'Whisper base — multilingual',
    repo: 'onnx-community/whisper-base',
    dtype: 'q8',
    approxBytes: 80_000_000,
    license: 'Apache-2.0',
    notes: 'Better accuracy than tiny, still light enough for a small server.',
  },
]

export function findLocalSpeechModel(id: string): LocalSpeechModel | undefined {
  return LOCAL_SPEECH_MODELS.find((m) => m.id === id)
}

/** Root folder for locally cached model files (shared with the embedding model). */
export function localModelsDir(): string {
  return path.join(process.cwd(), '.models')
}

/** Absolute cache folder of one model, guarded against path traversal. */
export function modelCacheDir(model: LocalSpeechModel): string {
  const root = localModelsDir()
  const target = path.resolve(root, model.repo)
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
  if (!target.startsWith(rootWithSep)) {
    throw new Error('Refusing to use a model path outside the local model cache')
  }
  return target
}

async function dirSize(dir: string): Promise<{ bytes: number; onnxFiles: number }> {
  let bytes = 0
  let onnxFiles = 0
  const walk = async (current: string): Promise<void> => {
    let entries: Array<{ name: string; isDirectory(): boolean }> = []
    try {
      const found = await fs.readdir(current, { withFileTypes: true })
      entries = found.map((e) => ({ name: e.name, isDirectory: () => e.isDirectory() }))
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      const stat = await fs.stat(full).catch(() => null)
      if (!stat) continue
      bytes += stat.size
      if (entry.name.endsWith('.onnx')) onnxFiles++
    }
  }
  await walk(dir)
  return { bytes, onnxFiles }
}

export type LocalSpeechModelStatus = {
  id: string
  capability: LocalSpeechCapability
  label: string
  repo: string
  dtype: string
  approxBytes: number
  license: string
  notes: string
  installed: boolean
  bytesOnDisk: number
  cachePath: string
}

/** Catalog with the real on-disk state of every model. */
export async function listLocalSpeechModels(): Promise<LocalSpeechModelStatus[]> {
  const out: LocalSpeechModelStatus[] = []
  for (const model of LOCAL_SPEECH_MODELS) {
    const dir = modelCacheDir(model)
    const { bytes, onnxFiles } = await dirSize(dir)
    out.push({
      ...model,
      installed: onnxFiles > 0 && bytes > 1_000_000,
      bytesOnDisk: bytes,
      cachePath: dir,
    })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* engines                                                             */
/* ------------------------------------------------------------------ */

type TransformersModule = typeof import('@huggingface/transformers')

let transformersPromise: Promise<TransformersModule> | null = null

async function getTransformers(): Promise<TransformersModule> {
  if (!transformersPromise) {
    transformersPromise = (async () => {
      const transformers = await import('@huggingface/transformers')
      transformers.env.cacheDir = localModelsDir()
      transformers.env.allowLocalModels = false
      return transformers
    })().catch((err) => {
      transformersPromise = null
      throw err
    })
  }
  return transformersPromise
}

type TtsEngine = { run: (text: string) => Promise<{ audio: Float32Array; sampling_rate: number }> }
type SttEngine = { run: (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string }> }

const ttsEngines = new Map<string, Promise<TtsEngine>>()
const sttEngines = new Map<string, Promise<SttEngine>>()

async function getTtsEngine(model: LocalSpeechModel): Promise<TtsEngine> {
  const key = `${model.id}:${model.dtype}`
  let engine = ttsEngines.get(key)
  if (!engine) {
    engine = (async () => {
      const transformers = await getTransformers()
      const pipe = await transformers.pipeline('text-to-audio', model.repo, {
        dtype: model.dtype as never,
      })
      // transformers.js v4 pipelines are callable objects (Callable -> _call).
      const callable = pipe as unknown as (text: string) => Promise<{ audio: Float32Array; sampling_rate: number }>
      return { run: (text: string) => callable(text) }
    })().catch((err) => {
      ttsEngines.delete(key)
      throw err
    })
    ttsEngines.set(key, engine)
  }
  return engine
}

async function getSttEngine(model: LocalSpeechModel): Promise<SttEngine> {
  const key = `${model.id}:${model.dtype}`
  let engine = sttEngines.get(key)
  if (!engine) {
    engine = (async () => {
      const transformers = await getTransformers()
      const pipe = await transformers.pipeline('automatic-speech-recognition', model.repo, {
        dtype: model.dtype as never,
      })
      const callable = pipe as unknown as (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string }>
      return { run: (audio: Float32Array, opts?: Record<string, unknown>) => callable(audio, opts) }
    })().catch((err) => {
      sttEngines.delete(key)
      throw err
    })
    sttEngines.set(key, engine)
  }
  return engine
}

/**
 * Download (or warm up) a local model. The heavy lifting is done by
 * transformers.js, which stores the weights in `.models/<repo>/`.
 */
export async function downloadLocalSpeechModel(id: string): Promise<{ ok: boolean; detail: string; bytesOnDisk: number }> {
  const model = findLocalSpeechModel(id)
  if (!model) return { ok: false, detail: `Unknown local speech model "${id}"`, bytesOnDisk: 0 }
  try {
    if (model.capability === 'tts') {
      const engine = await getTtsEngine(model)
      await engine.run('Ready.')
    } else {
      const engine = await getSttEngine(model)
      await engine.run(new Float32Array(16000))
    }
    const { bytes } = await dirSize(modelCacheDir(model))
    return { ok: true, detail: `${model.label} is ready (${(bytes / 1_000_000).toFixed(1)} MB on disk).`, bytesOnDisk: bytes }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, detail: `Download failed: ${message}`, bytesOnDisk: 0 }
  }
}

/** Remove a downloaded model from the local cache. */
export async function deleteLocalSpeechModel(id: string): Promise<{ ok: boolean; detail: string }> {
  const model = findLocalSpeechModel(id)
  if (!model) return { ok: false, detail: `Unknown local speech model "${id}"` }
  const dir = modelCacheDir(model)
  try {
    await fs.rm(dir, { recursive: true, force: true })
    return { ok: true, detail: `${model.label} removed from the local model cache.` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, detail: `Could not remove the model: ${message}` }
  }
}

/* ------------------------------------------------------------------ */
/* synthesis / transcription                                           */
/* ------------------------------------------------------------------ */

export type LocalSynthesisResult = {
  audio: Uint8Array
  sampleRate: number
  durationMs: number
  model: string
  latencyMs: number
}

/** Synthesize speech with a local ONNX model. Throws with the real reason on failure. */
export async function synthesizeLocalSpeech(text: string, id: string): Promise<LocalSynthesisResult> {
  const model = findLocalSpeechModel(id)
  if (!model) throw new Error(`Unknown local speech model "${id}"`)
  if (model.capability !== 'tts') throw new Error(`"${model.label}" is a speech-to-text model`)
  const started = Date.now()
  const engine = await getTtsEngine(model)
  const output = await engine.run(text)
  const samples = output.audio
  const sampleRate = output.sampling_rate || 16000
  if (!samples || samples.length === 0) throw new Error('The local TTS model returned empty audio')
  return {
    audio: encodeWavPcm16(samples, sampleRate),
    sampleRate,
    durationMs: Math.round((samples.length / sampleRate) * 1000),
    model: model.id,
    latencyMs: Date.now() - started,
  }
}

export type LocalTranscriptionResult = {
  text: string
  model: string
  latencyMs: number
}

/** Transcribe 16 kHz mono float samples with a local ONNX model. */
export async function transcribeLocalSpeech(samples: Float32Array, id: string): Promise<LocalTranscriptionResult> {
  const model = findLocalSpeechModel(id)
  if (!model) throw new Error(`Unknown local speech model "${id}"`)
  if (model.capability !== 'stt') throw new Error(`"${model.label}" is a text-to-speech model`)
  const started = Date.now()
  const engine = await getSttEngine(model)
  const output = await engine.run(samples, { chunk_length_s: 30, stride_length_s: 5 })
  const text = String(output.text ?? '').trim()
  return { text, model: model.id, latencyMs: Date.now() - started }
}
