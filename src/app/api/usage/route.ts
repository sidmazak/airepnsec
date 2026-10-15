import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { withAuth, json } from '@/lib/api'

// Per-1M-token rate table (USD). Used only for estimates; unknown models are flagged.
const RATES: Record<string, { in: number; out: number }> = {
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4.1': { in: 2.0, out: 8 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4.1-nano': { in: 0.1, out: 0.4 },
  'gpt-4-turbo': { in: 10, out: 30 },
  'gpt-3.5-turbo': { in: 0.5, out: 1.5 },
  'o1': { in: 15, out: 60 },
  'o1-mini': { in: 3, out: 12 },
  'o3-mini': { in: 1.1, out: 4.4 },
  'claude-3-5-sonnet': { in: 3, out: 15 },
  'claude-3-5-haiku': { in: 0.8, out: 4 },
  'claude-3-opus': { in: 15, out: 75 },
  'llama3': { in: 0, out: 0 },
}

function rateFor(provider: string, model: string): { in: number; out: number; known: boolean } {
  const m = (model || '').toLowerCase()
  if (RATES[model]) return { ...RATES[model], known: true }
  for (const key of Object.keys(RATES)) {
    if (m.includes(key.toLowerCase())) return { ...RATES[key], known: true }
  }
  // unknown openai-compatible / ollama: treat local as free, cloud as unknown
  if (provider === 'ollama') return { in: 0, out: 0, known: true }
  return { in: 0, out: 0, known: false }
}

export const GET = withAuth(async (req, ctx) => {
  const url = new URL(req.url)
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days') || '30')))
  const since = new Date(Date.now() - days * 86400_000)

  const logs = await db.aiLog.findMany({
    where: { orgId: ctx.org.id, ts: { gte: since } },
    orderBy: { ts: 'asc' },
  })

  // capabilities, providers, models
  const byCapability: Record<string, { calls: number; ok: number; fail: number; tokensIn: number; tokensOut: number; latencyMs: number }> = {}
  const byProviderModel: Record<string, { provider: string; model: string; calls: number; ok: number; fail: number; tokensIn: number; tokensOut: number; latencyMs: number; costUsd: number; costKnown: boolean }> = {}
  const daily: Record<string, { date: string; calls: number; tokensIn: number; tokensOut: number; costUsd: number; ok: number; fail: number }> = {}
  const conversations = new Set<string>()

  let totalTokensIn = 0
  let totalTokensOut = 0
  let totalCalls = 0
  let totalOk = 0
  let totalFail = 0
  let totalLatency = 0
  let totalCost = 0
  let costKnownAll = true

  for (const l of logs) {
    totalCalls++
    if (l.ok) totalOk++; else totalFail++
    totalTokensIn += l.tokensIn
    totalTokensOut += l.tokensOut
    totalLatency += l.latencyMs
    if (l.conversationId) conversations.add(l.conversationId)

    // capability
    if (!byCapability[l.capability]) byCapability[l.capability] = { calls: 0, ok: 0, fail: 0, tokensIn: 0, tokensOut: 0, latencyMs: 0 }
    const c = byCapability[l.capability]
    c.calls++; if (l.ok) c.ok++; else c.fail++; c.tokensIn += l.tokensIn; c.tokensOut += l.tokensOut; c.latencyMs += l.latencyMs

    // provider/model
    const pmKey = `${l.provider}::${l.model || '(default)'}`
    if (!byProviderModel[pmKey]) byProviderModel[pmKey] = { provider: l.provider, model: l.model || '(default)', calls: 0, ok: 0, fail: 0, tokensIn: 0, tokensOut: 0, latencyMs: 0, costUsd: 0, costKnown: true }
    const pm = byProviderModel[pmKey]
    pm.calls++; if (l.ok) pm.ok++; else pm.fail++; pm.tokensIn += l.tokensIn; pm.tokensOut += l.tokensOut; pm.latencyMs += l.latencyMs
    const rate = rateFor(l.provider, l.model)
    const cost = (l.tokensIn / 1e6) * rate.in + (l.tokensOut / 1e6) * rate.out
    pm.costUsd += cost
    if (!rate.known) { pm.costKnown = false; costKnownAll = false }
    totalCost += cost

    // daily
    const day = l.ts.toISOString().slice(0, 10)
    if (!daily[day]) daily[day] = { date: day, calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, ok: 0, fail: 0 }
    const d = daily[day]
    d.calls++; if (l.ok) d.ok++; else d.fail++; d.tokensIn += l.tokensIn; d.tokensOut += l.tokensOut; d.costUsd += cost
  }

  const convCount = await db.conversation.count({ where: { orgId: ctx.org.id, createdAt: { gte: since } } })
  const msgCount = await db.message.count({ where: { orgId: ctx.org.id, createdAt: { gte: since } } })

  return json({
    windowDays: days,
    since: since.toISOString(),
    summary: {
      calls: totalCalls,
      ok: totalOk,
      fail: totalFail,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      tokensTotal: totalTokensIn + totalTokensOut,
      costUsd: Number(totalCost.toFixed(6)),
      costKnown: costKnownAll,
      avgLatencyMs: totalCalls ? Math.round(totalLatency / totalCalls) : 0,
      conversations: convCount,
      messages: msgCount,
      aiConversations: conversations.size,
    },
    byCapability: Object.entries(byCapability).map(([capability, v]) => ({ capability, ...v })),
    byProviderModel: Object.values(byProviderModel).map((v) => ({ ...v, costUsd: Number(v.costUsd.toFixed(6)) })),
    daily: Object.values(daily).sort((a, b) => a.date.localeCompare(b.date)).map((v) => ({ ...v, costUsd: Number(v.costUsd.toFixed(6)) })),
    rates: RATES,
  })
}, { roles: ['owner', 'admin', 'viewer'] })
