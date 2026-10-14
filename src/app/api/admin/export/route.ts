import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'

/**
 * GET /api/admin/export (owner/admin) — full JSON export of org data as an
 * attachment. Secrets are excluded by construction:
 * - providerConfig is omitted entirely (contains encrypted API keys)
 * - appSettings are omitted (contains the raw webhook secret)
 * - sessions are omitted; user password hashes are stripped
 */
export const GET = withAuth(
  async (req, ctx) => {
    const orgId = ctx.org.id

    const [org, users, customers, services, staff, staffServices, workingHours, bookings, invoices, payments, ledgerEntries, knowledgeDocs, conversations, messages, automations, automationRuns, outbox, auditEvents] =
      await Promise.all([
        db.organization.findUnique({ where: { id: orgId } }),
        db.user.findMany({ where: { orgId } }),
        db.customer.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } }),
        db.service.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } }),
        db.staff.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } }),
        db.staffService.findMany({ where: { staff: { orgId } } }),
        db.workingHour.findMany({ where: { orgId }, orderBy: [{ staffId: 'asc' }, { dow: 'asc' }] }),
        db.booking.findMany({ where: { orgId }, orderBy: { startAt: 'asc' } }),
        db.invoice.findMany({ where: { orgId }, orderBy: { issueDate: 'asc' }, include: { items: true } }),
        db.payment.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } }),
        db.ledgerEntry.findMany({ where: { orgId }, orderBy: { ts: 'asc' } }),
        db.knowledgeDoc.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } }),
        db.conversation.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } }),
        db.message.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } }),
        db.automation.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } }),
        db.automationRun.findMany({ where: { orgId }, orderBy: { scheduledFor: 'asc' } }),
        db.outboxMessage.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } }),
        db.auditEvent.findMany({ where: { orgId }, orderBy: { ts: 'asc' } }),
      ])

    const data = {
      exportedAt: new Date().toISOString(),
      org,
      users: users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt })),
      customers,
      services,
      staff,
      staffServices,
      workingHours,
      bookings,
      invoices,
      payments,
      ledgerEntries,
      knowledge: knowledgeDocs,
      conversations,
      messages,
      automations,
      automationRuns,
      outbox,
      auditEvents,
    }

    await audit({
      orgId,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'admin.exported',
      entity: 'organization',
      entityId: orgId,
      meta: {
        customers: customers.length,
        bookings: bookings.length,
        invoices: invoices.length,
        ledgerEntries: ledgerEntries.length,
      },
    })

    return new NextResponse(JSON.stringify(data, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-disposition': 'attachment; filename="export.json"',
        'cache-control': 'no-store',
      },
    })
  },
  { roles: ['owner', 'admin'] }
)
