import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeToolCallFrames,
  parseToolArgs,
  splitSseFrames,
  toOllamaMessages,
  toOpenAiMessages,
  type LlmMessage,
} from '../../src/lib/ai/llm-protocol.ts'

test('parseToolArgs accepts an object, a JSON string and garbage', () => {
  assert.deepEqual(parseToolArgs({ a: 1 }), { a: 1 })
  assert.deepEqual(parseToolArgs('{"b":"2"}'), { b: '2' })
  assert.deepEqual(parseToolArgs('not json'), {})
  assert.deepEqual(parseToolArgs(''), {})
  assert.deepEqual(parseToolArgs(undefined), {})
})

test('mergeToolCallFrames joins fragmented arguments per tool index', () => {
  const calls = mergeToolCallFrames([
    { index: 0, id: 'call_1', name: 'check_availability', argsText: '{"service":"Cut and' },
    { index: 0, argsText: ' color"}' },
    { index: 1, id: 'call_2', name: 'business_info', argsText: '{}' },
  ])
  assert.equal(calls.length, 2)
  assert.equal(calls[0].name, 'check_availability')
  assert.deepEqual(calls[0].args, { service: 'Cut and color' })
  assert.equal(calls[1].name, 'business_info')
})

test('mergeToolCallFrames drops fragments without a name', () => {
  const calls = mergeToolCallFrames([{ index: 0, argsText: '{"a":1}' }])
  assert.equal(calls.length, 0)
})

test('toOpenAiMessages maps tool results and assistant tool calls', () => {
  const messages: LlmMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'business_info', args: { topic: 'hours' } }] },
    { role: 'tool', content: '{"open":"9-5"}', toolCallId: 'c1', name: 'business_info' },
  ]
  const wire = toOpenAiMessages(messages)
  assert.equal(wire[0].role, 'system')
  assert.equal((wire[2] as { tool_calls: unknown[] }).tool_calls.length, 1)
  assert.equal(wire[3].role, 'tool')
  assert.equal(wire[3].tool_call_id, 'c1')
})

test('toOllamaMessages keeps roles and content only', () => {
  const wire = toOllamaMessages([
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', args: {} }] },
    { role: 'tool', content: 'ok', toolCallId: 'c1', name: 'x' },
  ])
  assert.deepEqual(wire[0], { role: 'assistant', content: '' })
  assert.deepEqual(wire[1], { role: 'tool', content: 'ok' })
})

test('splitSseFrames returns complete frames and keeps the remainder', () => {
  const { frames, rest } = splitSseFrames('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"')
  assert.deepEqual(frames, ['{"a":1}', '{"b":2}'])
  assert.equal(rest, 'data: {"c"')
})
