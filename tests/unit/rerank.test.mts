import test from 'node:test'
import assert from 'node:assert/strict'
import { applyRerank, parseRerankResponse } from '../../src/lib/ai/rerank-protocol.ts'

test('parseRerankResponse reads the Cohere-style shape', () => {
  const hits = parseRerankResponse({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.4 }] })
  assert.equal(hits.length, 2)
  assert.equal(hits[0].index, 1)
  assert.equal(hits[0].score, 0.9)
})

test('parseRerankResponse accepts the score variant and ignores garbage', () => {
  const hits = parseRerankResponse({ results: [{ index: 0, score: 0.5 }, { index: 'x', score: 0.5 }, null] })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].index, 0)
})

test('parseRerankResponse returns nothing for an unexpected payload', () => {
  assert.deepEqual(parseRerankResponse({}), [])
  assert.deepEqual(parseRerankResponse(null), [])
  assert.deepEqual(parseRerankResponse('nope'), [])
})

test('applyRerank reorders candidates and keeps unscored ones at the end', () => {
  const candidates = [
    { id: 'a', score: 0.9 },
    { id: 'b', score: 0.5 },
    { id: 'c', score: 0.4 },
  ]
  const out = applyRerank(candidates, [{ index: 2, score: 1 }])
  assert.equal(out[0].id, 'c')
  assert.equal(out[0].score, 0.7)
  assert.deepEqual(out.slice(1).map((c) => c.id), ['a', 'b'])
})

test('applyRerank ignores out-of-range indices', () => {
  const candidates = [{ id: 'a', score: 1 }]
  const out = applyRerank(candidates, [{ index: 7, score: 1 }])
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'a')
})
