import { z } from 'zod'
import { withAuth, json, ApiError, parseBody } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { ACCOUNTING_LABELS, ACCOUNTING_PROVIDER_IDS, pushInvoiceToAccounting } from '@/lib/integrations/accounting'

const pushSchema = z.object({
  kind: z.enum(['quickbooks', 'xero', 'myob']),
})

/**
 * POST /api/invoices/[id]/push-accounting (owner/admin) — pushes the invoice
 * (and creates the customer when needed) to the org's enabled accounting
 * integration. A prior successful push for the same provider is refused to
 * avoid duplicate documents. Live provider failures return 502 with the
 * sanitized provider message.
 */
export const POST = withAuth(
  async (req, ctx, params) => {
    const body = await parseBody(req, pushSchema)
    const kind = body.kind
    if (!ACCOUNTING_PROVIDER_IDS.includes(kind)) throw new ApiError(422, 'Unsupported accounting provider', 'bad_provider')

    const integration = await db.integration.findFirst({ where: { orgId: ctx.org.id, kind, enabled: true } })
    if (!integration) {
      throw new ApiError(503, `${ACCOUNTING_LABELS[kind]} integration is not enabled — configure it in Integrations`, 'accounting_not_enabled')
    }
    if (!integration.secretsEnc) {
      throw new ApiError(409, `${ACCOUNTING_LABELS[kind]} integration has no credentials`, 'not_configured')
    }

    const invoice = await db.invoice.findFirst({
      where: { id: params.id, orgId: ctx.org.id },
      include: { customer: true },
    })
    if (!invoice) throw new ApiError(404, 'Invoice not found', 'not_found')
    if (invoice.status === 'void') throw new ApiError(409, 'Invoice is void', 'invoice_void')
    if (invoice.status === 'draft') throw new ApiError(409, 'Issue the invoice before pushing it to accounting', 'invoice_draft')

    try {
      const result = await pushInvoiceToAccounting(kind, integration, invoice, {
        id: invoice.customer.id,
        name: invoice.customer.name,
        email: invoice.customer.email,
        phone: invoice.customer.phone,
        externalRef: invoice.customer.externalRef,
      })
      await audit({
        orgId: ctx.org.id,
        actorType: 'user',
        actorId: ctx.user.id,
        action: 'invoice.pushed',
        entity: 'invoice',
        entityId: invoice.id,
        meta: { provider: kind, number: invoice.number, externalId: result.externalId, providerNumber: result.number, customerId: result.customerId },
      })
      return json({ pushed: true, label: ACCOUNTING_LABELS[kind], ...result })
    } catch (err) {
      throw new ApiError(502, err instanceof Error ? err.message : `${ACCOUNTING_LABELS[kind]} push failed`, 'accounting_push_failed')
    }
  },
  { roles: ['owner', 'admin'] }
)
