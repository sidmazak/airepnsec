import { withAuth, json } from '@/lib/api'
import { db } from '@/lib/db'
import { parseJson } from '@/lib/org'

export type ReadinessItem = { key: string; label: string; ok: boolean; detail: string }

/**
 * GET /api/setup/readiness — REAL checks only, never faked:
 * counts come from the database, LLM readiness from the stored provider test result.
 */
export const GET = withAuth(async (req, ctx) => {
  const orgId = ctx.org.id
  const [serviceCount, staffCount, workingHourCount, approvedKnowledgeCount, customerCount, automationCount, llmRow, secretRow] =
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
      ok: Boolean(llmRow?.enabled && llmRow?.lastTestOk),
      detail: llmRow
        ? llmRow.lastTestOk
          ? `last test passed (provider: ${llmRow.provider})`
          : llmRow.lastTestError || 'configured but not tested yet'
        : 'no conversation model configured',
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
