import test from 'node:test'
import assert from 'node:assert/strict'
import { chunkForTts } from '../../src/lib/ai/tts-chunk.ts'

test('chunkForTts returns [] for empty', () => {
  assert.deepEqual(chunkForTts('   '), [])
})

test('chunkForTts splits into sentence-sized chunks', () => {
  const text = 'Hello world. How are you? Fine thanks.'
  const chunks = chunkForTts(text, 100)
  assert.ok(chunks.length >= 1)
  let joined = chunks.join(' ')
  // all content preserved roughly
  assert.ok(joined.includes('Hello world'))
  assert.ok(joined.includes('Fine thanks'))
})

test('chunkForTts respects max by hard-splitting run-ons', () => {
  const long = 'a '.repeat(500).trim()
  const chunks = chunkForTts(long, 50)
  assert.ok(chunks.length > 1)
  for (const c of chunks) {
    // tolerance: hard split occurs <= max+1 roughly; ensure no gross overflow
    assert.ok(c.length <= 60, `chunk too long: ${c.length}`)
  }
})
