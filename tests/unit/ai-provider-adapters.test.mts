import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ANTHROPIC_VERSION,
  anthropicHeaders,
  anthropicRequestBody,
  normalizeAnthropicBase,
  parseAnthropicResponse,
  parseAnthropicStreamEvent,
  toAnthropicMessages,
} from '../../src/lib/ai/anthropic.ts'
import {
  googleHeaders,
  googleRequestBody,
  normalizeGoogleBase,
  parseGoogleResponse,
  parseGoogleStreamEvent,
  toGoogleContents,
} from '../../src/lib/ai/google.ts'
import {
  AZURE_DEFAULT_API_VERSION,
  azureEndpoint,
  azureHeaders,
  azureUrl,
} from '../../src/lib/ai/azure.ts'
import { AI_PRESETS, PROVIDER_KIND_LABELS, findPreset, presetsFor } from '../../src/lib/ai/presets.ts'
import type { LlmMessage } from '../../src/lib/ai/llm-protocol.ts'

const messages: LlmMessage[] = [
  { role: 'system', content: 'You are a receptionist.' },
  { role: 'system', content: 'Be concise.' },
  { role: 'user', content: 'Hi' },
  { role: 'assistant', content: 'Hello!' },
  { role: 'tool', content: '{"open":"9-5"}', toolCallId: 'c1', name: 'business_info' },
  { role: 'tool', content: '{"ok":true}', toolCallId: 'c2', name: 'check_availability' },
]

test('normalizeAnthropicBase appends /v1 once', () => {
  assert.equal(normalizeAnthropicBase('https://api.anthropic.com'), 'https://api.anthropic.com/v1')
  assert.equal(normalizeAnthropicBase('https://api.anthropic.com/'), 'https://api.anthropic.com/v1')
  assert.equal(normalizeAnthropicBase('https://proxy.test/v1/'), 'https://proxy.test/v1')
  assert.equal(normalizeAnthropicBase(''), '')
})

test('anthropicHeaders include the version and never leak into the body', () => {
  const headers = anthropicHeaders('sk-ant-test')
  assert.equal(headers['x-api-key'], 'sk-ant-test')
  assert.equal(headers['anthropic-version'], ANTHROPIC_VERSION)
  assert.equal(JSON.stringify(anthropicRequestBody('claude', messages)).includes('sk-ant-test'), false)
})

test('toAnthropicMessages lifts system prompts and merges consecutive turns', () => {
  const { system, messages: turns } = toAnthropicMessages(messages)
  assert.equal(system, 'You are a receptionist.\n\nBe concise.')
  assert.equal(turns.length, 3)
  assert.deepEqual(turns[0], { role: 'user', content: 'Hi' })
  assert.deepEqual(turns[1], { role: 'assistant', content: 'Hello!' })
  assert.equal(turns[2].role, 'user')
  assert.match(String(turns[2].content), /Tool result \(business_info\)/)
  assert.match(String(turns[2].content), /\n\nTool result \(check_availability\)/)
})

test('anthropicRequestBody clamps temperature and sets stream', () => {
  const body = anthropicRequestBody('claude-sonnet', messages, { temperature: 2, maxTokens: 64, stream: true })
  assert.equal(body.model, 'claude-sonnet')
  assert.equal(body.max_tokens, 64)
  assert.equal(body.temperature, 1)
  assert.equal(body.stream, true)
  assert.equal('system' in body, true)
})

test('parseAnthropicResponse joins text and normalizes tool_use blocks', () => {
  const parsed = parseAnthropicResponse({
    content: [
      { type: 'text', text: 'Let me check. ' },
      { type: 'tool_use', id: 'toolu_1', name: 'check_availability', input: { service: 'Cut' } },
      { type: 'text', text: 'One moment.' },
    ],
    usage: { input_tokens: 12, output_tokens: 7 },
  })
  assert.equal(parsed.content, 'Let me check. One moment.')
  assert.deepEqual(parsed.toolCalls, [{ id: 'toolu_1', name: 'check_availability', args: { service: 'Cut' } }])
  assert.equal(parsed.tokensIn, 12)
  assert.equal(parsed.tokensOut, 7)
})

test('parseAnthropicStreamEvent reads deltas, usage and completion', () => {
  assert.deepEqual(
    parseAnthropicStreamEvent(JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } })),
    { delta: 'Hi' }
  )
  assert.deepEqual(
    parseAnthropicStreamEvent(JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 9 } } })),
    { tokensIn: 9 }
  )
  assert.deepEqual(parseAnthropicStreamEvent(JSON.stringify({ type: 'message_stop' })), { done: true })
  assert.deepEqual(parseAnthropicStreamEvent('not json'), {})
})

test('normalizeGoogleBase appends /v1beta once', () => {
  assert.equal(normalizeGoogleBase('https://generativelanguage.googleapis.com'), 'https://generativelanguage.googleapis.com/v1beta')
  assert.equal(normalizeGoogleBase('https://generativelanguage.googleapis.com/v1beta/'), 'https://generativelanguage.googleapis.com/v1beta')
  assert.equal(normalizeGoogleBase('https://proxy.test/v1'), 'https://proxy.test/v1')
  assert.equal(normalizeGoogleBase(''), '')
})

test('googleHeaders use x-goog-api-key and omit it when empty', () => {
  assert.equal(googleHeaders('AIza-test')['x-goog-api-key'], 'AIza-test')
  assert.equal('x-goog-api-key' in googleHeaders(''), false)
})

test('toGoogleContents maps assistant to model and merges turns', () => {
  const { system, contents } = toGoogleContents(messages)
  assert.equal(system, 'You are a receptionist.\n\nBe concise.')
  assert.equal(contents[0].role, 'user')
  assert.equal(contents[1].role, 'model')
  assert.equal(contents[2].role, 'user')
  assert.match(contents[2].parts[0].text, /Tool result/)
})

test('googleRequestBody builds generationConfig and systemInstruction', () => {
  const body = googleRequestBody(messages, { temperature: 0.2, maxTokens: 300 })
  assert.equal('systemInstruction' in body, true)
  assert.deepEqual(body.generationConfig, { temperature: 0.2, maxOutputTokens: 300 })
})

test('parseGoogleResponse and stream events normalize Gemini payloads', () => {
  const parsed = parseGoogleResponse({
    candidates: [{ content: { parts: [{ text: 'Hello ' }, { text: 'there' }] } }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
  })
  assert.deepEqual(parsed, { content: 'Hello there', tokensIn: 5, tokensOut: 2 })
  assert.deepEqual(
    parseGoogleStreamEvent(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hi' }] } }] })),
    { delta: 'Hi' }
  )
  assert.deepEqual(parseGoogleStreamEvent('nope'), {})
})

test('azureEndpoint supports deployment, resource and v1 shapes', () => {
  assert.equal(
    azureEndpoint('https://res.openai.azure.com/openai/deployments/my-deploy/chat/completions', 'ignored'),
    'https://res.openai.azure.com/openai/deployments/my-deploy'
  )
  assert.equal(
    azureEndpoint('https://res.openai.azure.com', 'my-deploy'),
    'https://res.openai.azure.com/openai/deployments/my-deploy'
  )
  assert.equal(
    azureEndpoint('https://res.openai.azure.com/openai', 'my-deploy'),
    'https://res.openai.azure.com/openai/deployments/my-deploy'
  )
  assert.equal(azureEndpoint('https://res.openai.azure.com/openai/v1', 'ignored'), 'https://res.openai.azure.com/openai/v1')
  assert.equal(azureEndpoint('', 'x'), '')
})

test('azureUrl adds api-version except on the v1 endpoint', () => {
  assert.equal(
    azureUrl('https://res.openai.azure.com/openai/deployments/d', 'd', 'chat/completions'),
    `https://res.openai.azure.com/openai/deployments/d/chat/completions?api-version=${AZURE_DEFAULT_API_VERSION}`
  )
  assert.equal(
    azureUrl('https://res.openai.azure.com/openai/deployments/d', 'd', 'embeddings', '2024-02-01'),
    'https://res.openai.azure.com/openai/deployments/d/embeddings?api-version=2024-02-01'
  )
  assert.equal(
    azureUrl('https://res.openai.azure.com/openai/v1', 'ignored', 'chat/completions'),
    'https://res.openai.azure.com/openai/v1/chat/completions'
  )
})

test('azureHeaders only include a non-empty api-key', () => {
  assert.equal(azureHeaders('k')['api-key'], 'k')
  assert.equal('api-key' in azureHeaders(''), false)
})

test('AI presets stay unique and expose provider labels', () => {
  const ids = AI_PRESETS.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const preset of AI_PRESETS) {
    assert.ok(preset.label)
    assert.ok(preset.provider)
    assert.ok(preset.models.every((m) => typeof m === 'string' && m.length > 0))
    assert.ok(PROVIDER_KIND_LABELS[preset.provider], `missing label for ${preset.provider}`)
  }
  assert.ok(presetsFor('llm').some((p) => p.id === 'anthropic'))
  assert.ok(presetsFor('llm').some((p) => p.id === 'xai'))
  assert.ok(presetsFor('embedding').every((p) => p.capabilities.includes('embedding')))
  assert.equal(findPreset('llm', 'https://api.anthropic.com', 'anthropic')?.id, 'anthropic')
  assert.equal(findPreset('llm', 'https://wrong.test', 'anthropic'), undefined)
})
