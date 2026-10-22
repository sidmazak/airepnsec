/**
 * Minimal RIFF/WAVE codec for 16-bit PCM audio.
 *
 * Alias-free on purpose (no `@/` imports) so the unit tests can import it
 * directly with `node --test`. Everything here is pure: no I/O, no deps.
 *
 * Used by the local speech pipeline:
 *  - encode: Float32 samples (what transformers.js produces) -> WAV bytes
 *    that a browser can play.
 *  - decode: WAV bytes -> mono Float32 at 16 kHz, the format Whisper expects.
 */

export const WAV_SAMPLE_RATE = 16000

export type DecodedAudio = {
  samples: Float32Array
  sampleRate: number
  channels: number
}

/** True when the buffer starts with a RIFF/WAVE header. */
export function isWavBuffer(buf: Uint8Array): boolean {
  if (buf.length < 12) return false
  return (
    String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) === 'RIFF' &&
    String.fromCharCode(buf[8], buf[9], buf[10], buf[11]) === 'WAVE'
  )
}

/** Encode mono float samples as a 16-bit PCM WAV file. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2
  const dataBytes = samples.length * bytesPerSample
  const out = new Uint8Array(44 + dataBytes)
  const view = new DataView(out.buffer)
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // format = PCM
  view.setUint16(22, 1, true) // channels
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true) // byte rate
  view.setUint16(32, bytesPerSample, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * bytesPerSample, Math.round(s * 32767), true)
  }
  return out
}

/**
 * Decode a WAV file into float samples.
 *
 * Supports 16-bit PCM (mono/stereo). 8-bit PCM and 32-bit float WAV files are
 * converted as well; anything else (compressed formats) is rejected with a
 * clear error instead of being silently mangled.
 */
export function decodeWav(buf: Uint8Array): DecodedAudio {
  if (!isWavBuffer(buf)) throw new Error('Not a WAV file (missing RIFF/WAVE header)')
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let offset = 12
  let format = 0
  let channels = 1
  let sampleRate = WAV_SAMPLE_RATE
  let bitsPerSample = 16
  let dataStart = -1
  let dataLength = 0

  while (offset + 8 <= buf.length) {
    const chunkId = String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3])
    const chunkSize = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (chunkId === 'fmt ') {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true) || 1
      sampleRate = view.getUint32(body + 4, true) || WAV_SAMPLE_RATE
      bitsPerSample = view.getUint16(body + 14, true) || 16
    } else if (chunkId === 'data') {
      dataStart = body
      dataLength = Math.min(chunkSize, buf.length - body)
      break
    }
    offset = body + chunkSize + (chunkSize % 2)
  }

  if (dataStart < 0) throw new Error('WAV file has no data chunk')
  if (format !== 1 && format !== 3 && format !== 0xfffe) {
    throw new Error(`Unsupported WAV format ${format} — only PCM WAV files are supported`)
  }
  if (bitsPerSample !== 8 && bitsPerSample !== 16 && bitsPerSample !== 32) {
    throw new Error(`Unsupported WAV sample width ${bitsPerSample} bits`)
  }

  const bytesPerSample = bitsPerSample / 8
  const frames = Math.floor(dataLength / (bytesPerSample * channels))
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let value = 0
    for (let c = 0; c < channels; c++) {
      const at = dataStart + (i * channels + c) * bytesPerSample
      if (bitsPerSample === 8) value += (view.getUint8(at) - 128) / 128
      else if (bitsPerSample === 16) value += view.getInt16(at, true) / 32768
      else value += view.getFloat32(at, true)
    }
    samples[i] = value / channels
  }
  return { samples, sampleRate, channels }
}

/** Linear resample — good enough for speech at 16 kHz and dependency-free. */
export function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples
  if (fromRate <= 0 || toRate <= 0) throw new Error('Sample rate must be positive')
  const ratio = toRate / fromRate
  const outLength = Math.max(1, Math.round(samples.length * ratio))
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const src = i / ratio
    const idx = Math.floor(src)
    const frac = src - idx
    const a = samples[Math.min(idx, samples.length - 1)]
    const b = samples[Math.min(idx + 1, samples.length - 1)]
    out[i] = a + (b - a) * frac
  }
  return out
}

/** Decode a WAV file and downmix/resample it to mono 16 kHz float samples. */
export function decodeWavToMono16k(buf: Uint8Array): Float32Array {
  const decoded = decodeWav(buf)
  return resample(decoded.samples, decoded.sampleRate, WAV_SAMPLE_RATE)
}

/** Approximate duration in seconds of a float sample buffer. */
export function durationSeconds(samples: Float32Array, sampleRate: number): number {
  if (sampleRate <= 0) return 0
  return samples.length / sampleRate
}
