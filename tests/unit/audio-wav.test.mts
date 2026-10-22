import test from 'node:test'
import assert from 'node:assert/strict'
import {
  WAV_SAMPLE_RATE,
  decodeWav,
  decodeWavToMono16k,
  durationSeconds,
  encodeWavPcm16,
  isWavBuffer,
  resample,
} from '../../src/lib/ai/audio-wav.ts'

test('encodeWavPcm16 writes a valid RIFF/WAVE header', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1])
  const wav = encodeWavPcm16(samples, 16000)
  assert.equal(isWavBuffer(wav), true)
  assert.equal(String.fromCharCode(wav[0], wav[1], wav[2], wav[3]), 'RIFF')
  assert.equal(String.fromCharCode(wav[8], wav[9], wav[10], wav[11]), 'WAVE')
  assert.equal(wav.length, 44 + samples.length * 2)
})

test('decodeWav reads back what encodeWavPcm16 wrote', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1])
  const decoded = decodeWav(encodeWavPcm16(samples, 22050))
  assert.equal(decoded.sampleRate, 22050)
  assert.equal(decoded.channels, 1)
  assert.equal(decoded.samples.length, samples.length)
  samples.forEach((value, i) => {
    assert.ok(Math.abs(decoded.samples[i] - value) < 1 / 32767, `sample ${i}: ${decoded.samples[i]} vs ${value}`)
  })
})

test('decodeWavToMono16k resamples to the Whisper rate', () => {
  const samples = new Float32Array(44100).fill(0.25)
  const out = decodeWavToMono16k(encodeWavPcm16(samples, 44100))
  assert.equal(out.length, WAV_SAMPLE_RATE)
  assert.ok(Math.abs(out[100] - 0.25) < 0.01)
})

test('resample keeps the signal and scales the length', () => {
  const input = new Float32Array([0, 1, 0, -1])
  const up = resample(input, 8000, 16000)
  assert.equal(up.length, 8)
  const down = resample(input, 16000, 8000)
  assert.equal(down.length, 2)
  assert.equal(resample(input, 16000, 16000), input)
})

test('resample rejects an invalid rate', () => {
  assert.throws(() => resample(new Float32Array(4), 0, 16000), /positive/)
})

test('isWavBuffer rejects non-WAV payloads', () => {
  assert.equal(isWavBuffer(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), false)
  assert.equal(isWavBuffer(new Uint8Array(4)), false)
})

test('decodeWav rejects files that are not PCM', () => {
  assert.throws(() => decodeWav(new Uint8Array(64)), /RIFF|WAVE/)
})

test('decodeWav mixes stereo down to mono', () => {
  const frames = 4
  const bytes = 44 + frames * 4
  const buf = new Uint8Array(bytes)
  const view = new DataView(buf.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, bytes - 8, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 2, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 64000, true)
  view.setUint16(32, 4, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, frames * 4, true)
  for (let i = 0; i < frames; i++) {
    view.setInt16(44 + i * 4, 32767, true)
    view.setInt16(44 + i * 4 + 2, -32767, true)
  }
  const decoded = decodeWav(buf)
  assert.equal(decoded.channels, 2)
  assert.equal(decoded.samples.length, frames)
  decoded.samples.forEach((v) => assert.ok(Math.abs(v) < 0.001, `mixed sample should be ~0, got ${v}`))
})

test('durationSeconds reports the clip length', () => {
  assert.equal(durationSeconds(new Float32Array(16000), 16000), 1)
  assert.equal(durationSeconds(new Float32Array(100), 0), 0)
})
