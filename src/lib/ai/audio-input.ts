import { spawn, spawnSync } from 'node:child_process'
import { decodeWavToMono16k, isWavBuffer } from '@/lib/ai/audio-wav'

/**
 * Prepare uploaded audio for a local speech-to-text model.
 *
 * Whisper-style ONNX models expect 16 kHz mono float samples. The Voice
 * Console records compressed audio (webm/opus) in the browser, so the server
 * converts it with ffmpeg when ffmpeg is installed. When it is not, the caller
 * gets an honest error instead of silence.
 */

let ffmpegChecked = false
let ffmpegPath: string | null = null

/** Detect ffmpeg on PATH (cached). Returns null when it is not installed. */
export function findFfmpeg(): string | null {
  if (ffmpegChecked) return ffmpegPath
  ffmpegChecked = true
  try {
    const res = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 5000 })
    ffmpegPath = res.status === 0 ? 'ffmpeg' : null
  } catch {
    ffmpegPath = null
  }
  return ffmpegPath
}

/** Convert any audio container to 16 kHz mono PCM WAV bytes using ffmpeg. */
export async function convertToPcm16kWav(audio: Buffer, mime: string): Promise<Uint8Array> {
  const bin = findFfmpeg()
  if (!bin) {
    throw new Error(
      'Converting compressed recordings needs ffmpeg on the server. Install ffmpeg, upload 16 kHz mono PCM WAV, or use an OpenAI-compatible speech-to-text endpoint.',
    )
  }
  return await new Promise<Uint8Array>((resolve, reject) => {
    const child = spawn(bin, [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', mime?.includes('wav') ? 'wav' : 'webm',
      '-i', 'pipe:0',
      '-ac', '1',
      '-ar', '16000',
      '-f', 'wav',
      'pipe:1',
    ])
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => err.push(d))
    child.on('error', (e) => reject(new Error(`ffmpeg could not start: ${e.message}`)))
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg failed (exit ${code}): ${Buffer.concat(err).toString('utf8').slice(0, 200)}`))
        return
      }
      const buf = Buffer.concat(out)
      if (buf.length === 0) {
        reject(new Error('ffmpeg produced no audio'))
        return
      }
      resolve(new Uint8Array(buf))
    })
    child.stdin.on('error', () => { /* the close handler reports the real error */ })
    child.stdin.end(audio)
  })
}

/** Uploaded audio → mono 16 kHz float samples ready for a local Whisper model. */
export async function toMono16kSamples(audio: Buffer, mime: string): Promise<Float32Array> {
  const bytes = new Uint8Array(audio)
  if (isWavBuffer(bytes)) return decodeWavToMono16k(bytes)
  const converted = await convertToPcm16kWav(audio, mime)
  return decodeWavToMono16k(converted)
}
