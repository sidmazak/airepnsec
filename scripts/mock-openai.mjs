/**
 * Mock OpenAI-compatible server used to verify the streaming + native tool
 * calling paths locally (no real provider is reachable in this environment).
 *
 *   node scripts/mock-openai.mjs [port]
 *
 * - POST /v1/chat/completions
 *     - with `stream: true`  -> SSE frames with content deltas
 *     - with `tools`         -> a tool_call for the first turn, plain text after
 *     - without tools        -> a single JSON payload (the strict protocol)
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] || 8099)
let turnState = 0

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

const server = createServer(async (req, res) => {
  if (req.url?.startsWith('/v1/rerank')) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      /* ignore */
    }
    const documents = Array.isArray(body.documents) ? body.documents : []
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        results: documents.map((_doc, index) => ({ index, relevance_score: index === documents.length - 1 ? 0.99 : 0.1 })),
      })
    )
    return
  }
  if (!req.url?.startsWith('/v1/chat/completions')) {
    res.writeHead(404).end('nope')
    return
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  let body = {}
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    /* ignore */
  }

  const stream = body.stream === true
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0
  const alreadyCalled = (body.messages ?? []).some((m) => m.role === 'tool')

  if (stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    if (hasTools && !alreadyCalled) {
      // tool call in streamed form
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'check_availability', arguments: '{"service":"Cut and color","date":"2026-10-23"}' } }] } }] })
      sse(res, { choices: [{ delta: {} }], usage: { prompt_tokens: 42, completion_tokens: 7 } })
      sse(res, '[DONE]')
      res.end()
      return
    }
    const text = hasTools ? 'Yes — I have two slots tomorrow at 10:00 and 14:00.' : '{"action":"reply","message":"Hello from the mock model."}'
    for (const piece of text.match(/.{1,7}/gs) ?? []) {
      sse(res, { choices: [{ delta: { content: piece } }] })
      await new Promise((r) => setTimeout(r, 10))
    }
    sse(res, { choices: [{ delta: {} }], usage: { prompt_tokens: 11, completion_tokens: 5 } })
    sse(res, '[DONE]')
    res.end()
    return
  }

  if (hasTools && !alreadyCalled) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'check_availability', arguments: '{"service":"Cut and color","date":"2026-10-23"}' } }] } }],
        usage: { prompt_tokens: 42, completion_tokens: 7 },
      })
    )
    return
  }

  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '{"action":"reply","message":"Hello from the mock model."}' } }],
      usage: { prompt_tokens: 11, completion_tokens: 5 },
    })
  )
})

server.listen(port, () => {
  process.stdout.write(`mock-openai listening on http://localhost:${port}\n`)
})
