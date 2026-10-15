import { withAuth, json } from '@/lib/api'
import { db } from '@/lib/db'
import { testProvider } from '@/lib/ai/providers'
import { parseJson } from '@/lib/org'

export type ReadinessItem = { key: string; label: string; ok: boolean; detail: string }

/**
 * GET /api/setup/readiness — REAL checks only, never faked:
 * counts come from the database, LLM readiness from the stored provider test result.
 */
export const GET = withAuth(async (req, ctx) => {
  const orgId = ctx.org.id
  const [serviceCount, staffCount, workingHourCount, approvedKnowledgeCount, customerCount, automationCount, llmRowFromQuery, secretRow] =
    await Promise.all([
      db.service.count({ where: { orgId } }),
      db.staff.count({ where: { orgId } }),
      db.workingHour.count({ where: { orgId } }),
      db.knowledgeDoc.count({ where: { orgId, approved: true } }),
      db.customer.count({ where: { orgId } }),
      db.automation.count({ where: { orgId } }),
      db.providerConfig.findUnique({ where: { orgId_capability: { orgId, capability: 'llm' } } }),
      db.appSetting.findUnique({ where: { orgId_key: { orgId, key: 'webhook_secret' } } }),
    ])

  const setupState = parseJson<Record<string, { done?: boolean; savedAt?: string }>>(ctx.org.setupState, {})

  // REAL live check of the conversation model — a stale `lastTestOk` must never be
  // reported as "ready" (the gateway can lose its config, an endpoint can go down).
  let llmLive: { ok: boolean; message: string } = { ok: false, message: 'no conversation model configured' }
  const llmRow = llmRowFromQuery
  if (llmRow && llmRow.enabled && llmRow.provider !== 'none') {
    try {
      const test = await testProvider(
        { provider: llmRow.provider, baseUrl: llmRow.baseUrl, model: llmRow.model, apiKeyEnc: llmRow.apiKeyEnc },
        'llm'
      )
      llmLive = { ok: Boolean(test.ok), message: test.message || 'live check failed' }
    } catch (err) {
      llmLive = { ok: false, message: err instanceof Error ? err.message.slice(0, 200) : 'live check failed' }
    }
  }

  const items: ReadinessItem[] = [
    {
      key: 'hasServices',
      label: 'Services defined',
      ok: serviceCount > 0,
      detail: `${serviceCount} service(s) configured`,
    },
    {
      key: 'hasStaff',
      label: 'Staff added',
      ok: staffCount > 0,
      detail: `${staffCount} staff member(s)`,
    },
    {
      key: 'hasWorkingHours',
      label: 'Working hours set',
      ok: workingHourCount > 0,
      detail: `${workingHourCount} working-hour window(s)`,
    },
    {
      key: 'hasKnowledge',
      label: 'Approved knowledge',
      ok: approvedKnowledgeCount > 0,
      detail: `${approvedKnowledgeCount} approved document(s) — only approved docs are served to the AI`,
    },
    {
      key: 'llmReady',
      label: 'AI model configured & tested',
      ok: llmRow ? llmLive.ok : false,
      detail: !llmRow
        ? 'no conversation model configured'
        : llmLive.ok
          ? `live check passed (provider: ${llmRow.provider})`
          : `${llmRow.lastTestOk ? 'stale test passed, but live check now fails: ' : ''}${llmLive.message || 'live check failed — see Diagnostics'}`,
    },
    {
      key: 'customersImported',
      label: 'Customers added',
      ok: customerCount > 0,
      detail: `${customerCount} customer(s) on file`,
    },
    {
      key: 'webhookSecret',
      label: 'Webhook secret configured',
      ok: Boolean(secretRow),
      detail: secretRow ? 'secret configured' : 'rotate a secret in Settings → Security to accept payment webhooks',
    },
    {
      key: 'automationsDefined',
      label: 'Automations defined',
      ok: automationCount > 0,
      detail: `${automationCount} automation(s) defined`,
    },
    {
      key: 'timezoneSet',
      label: 'Timezone set',
      ok: ctx.org.timezone !== 'UTC' || Boolean(setupState.business?.done),
      detail: ctx.org.timezone !== 'UTC' ? ctx.org.timezone : `currently "${ctx.org.timezone}" — pick your real timezone in Business setup`,
    },
  ]

  return json({ items })
})
