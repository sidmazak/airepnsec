import { withAuth, json } from '@/lib/api'
import { db } from '@/lib/db'
import { outstandingReceivables } from '@/lib/business/ledger'
import { parseJson } from '@/lib/org'

/**
 * GET /api/dashboard — at-a-glance data for the home section.
 * `todayBookings` is honestly the NEXT 24 HOURS from now (UTC window), not a
 * calendar-day slice. Readiness uses the same real checks as /api/setup/readiness.
 */
export const GET = withAuth(async (req, ctx) => {
  const orgId = ctx.org.id
  const now = new Date()
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000)

  const bookingInclude = {
    customer: { select: { name: true } },
    service: { select: { name: true } },
    staff: { select: { name: true } },
  } as const

  const [todayBookings, upcoming, outstandingCents, overdueRaw, openCount, waitingHumanCount, recentAudit, outboxRecent] =
    await Promise.all([
      db.booking.findMany({
        where: { orgId, startAt: { gte: now, lte: in24h }, status: { in: ['pending', 'confirmed'] } },
        orderBy: { startAt: 'asc' },
        take: 50,
        include: bookingInclude,
      }),
      db.booking.findMany({
        where: { orgId, startAt: { gt: now }, status: { in: ['pending', 'confirmed'] } },
        orderBy: { startAt: 'asc' },
        take: 5,
        include: bookingInclude,
      }),
      outstandingReceivables(orgId),
      db.invoice.findMany({
        where: { orgId, status: { in: ['sent', 'partial'] }, dueDate: { lt: now } },
        orderBy: { dueDate: 'asc' },
        take: 10,
        include: { customer: { select: { name: true } } },
      }),
      db.conversation.count({ where: { orgId, status: { in: ['open', 'waiting_human'] } } }),
      db.conversation.count({ where: { orgId, status: 'waiting_human' } }),
      db.auditEvent.findMany({ where: { orgId }, orderBy: { ts: 'desc' }, take: 8 }),
      db.outboxMessage.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 5 }),
    ])

  const overdue = overdueRaw.map((inv) => ({
    id: inv.id,
    number: inv.number,
    customer: inv.customer.name,
    daysOverdue: Math.max(0, Math.floor((now.getTime() - inv.dueDate.getTime()) / 86_400_000)),
    outstandingCents: Math.max(0, inv.totalCents - inv.paidCents),
  }))

  // Readiness: same real checks as GET /api/setup/readiness (kept inline, no HTTP self-call).
  const [serviceCount, staffCount, workingHourCount, approvedKnowledgeCount, customerCount, automationCount, llmRow, secretRow] =
    await Promise.all([
      db.service.count({ where: { orgId } }),
      db.staff.count({ where: { orgId } }),
      db.workingHour.count({ where: { orgId } }),
      db.knowledgeDoc.count({ where: { orgId, approved: true } }),
      db.customer.count({ where: { orgId } }),
      db.automation.count({ where: { orgId } }),
      db.providerConfig.findUnique({ where: { orgId_capability: { orgId, capability: 'llm' } } }),
      db.appSetting.findUnique({ where: { orgId_key: { orgId, key: 'webhook_secret' } }, select: { id: true } }),
    ])

  const setupState = parseJson<Record<string, { done?: boolean; savedAt?: string }>>(ctx.org.setupState, {})

  const readinessItems = [
    { key: 'hasServices', label: 'Services defined', ok: serviceCount > 0, detail: `${serviceCount} service(s) configured` },
    { key: 'hasStaff', label: 'Staff added', ok: staffCount > 0, detail: `${staffCount} staff member(s)` },
    { key: 'hasWorkingHours', label: 'Working hours set', ok: workingHourCount > 0, detail: `${workingHourCount} working-hour window(s)` },
    { key: 'hasKnowledge', label: 'Approved knowledge', ok: approvedKnowledgeCount > 0, detail: `${approvedKnowledgeCount} approved document(s)` },
    {
      key: 'llmReady',
      label: 'AI model configured & tested',
      ok: Boolean(llmRow?.enabled && llmRow?.lastTestOk),
      detail: llmRow ? (llmRow.lastTestOk ? `last test passed (${llmRow.provider})` : llmRow.lastTestError || 'configured but not tested yet') : 'no conversation model configured',
    },
    { key: 'customersImported', label: 'Customers added', ok: customerCount > 0, detail: `${customerCount} customer(s) on file` },
    { key: 'webhookSecret', label: 'Webhook secret configured', ok: Boolean(secretRow), detail: secretRow ? 'secret configured' : 'rotate a secret in Settings → Security' },
    { key: 'automationsDefined', label: 'Automations defined', ok: automationCount > 0, detail: `${automationCount} automation(s) defined` },
    {
      key: 'timezoneSet',
      label: 'Timezone set',
      ok: ctx.org.timezone !== 'UTC' || Boolean(setupState.business?.done),
      detail: ctx.org.timezone !== 'UTC' ? ctx.org.timezone : `currently "${ctx.org.timezone}" — pick your real timezone in Business setup`,
    },
  ]
  const okCount = readinessItems.filter((i) => i.ok).length

  return json({
    todayBookings,
    upcomingBookings: upcoming,
    outstandingCents,
    overdue,
    openConversations: { total: openCount, waitingHuman: waitingHumanCount },
    recentAudit,
    outboxRecent,
    readiness: { okCount, total: readinessItems.length, items: readinessItems },
  })
})
