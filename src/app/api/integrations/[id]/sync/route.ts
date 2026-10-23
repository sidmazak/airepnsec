import { withAuth, json, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { COMMERCE_LABELS, COMMERCE_PROVIDER_IDS, syncCommerceCustomers } from '@/lib/integrations/commerce'

/**
 * POST /api/integrations/[id]/sync (owner/admin) — pulls one page of contacts
 * from a commerce/CRM integration into the org's customers. Existing customers
 * are matched by provider external ref, email, or phone; tags are unioned.
 * Never reports a sync as successful when the provider call failed.
 */
export const POST = withAuth(
  async (_req, ctx, params) => {
    const integration = await db.integration.findFirst({ where: { id: params.id, orgId: ctx.org.id } })
    if (!integration) throw new ApiError(404, 'Integration not found', 'not_found')
    if (!COMMERCE_PROVIDER_IDS.includes(integration.kind as (typeof COMMERCE_PROVIDER_IDS)[number])) {
      throw new ApiError(409, 'This integration does not support customer sync', 'sync_not_supported')
    }
    if (!integration.enabled) throw new ApiError(409, 'Enable the integration before syncing', 'integration_disabled')
    if (!integration.secretsEnc) throw new ApiError(409, 'Configure the integration credentials before syncing', 'not_configured')

    try {
      const result = await syncCommerceCustomers(integration.kind, integration)
      await audit({
        orgId: ctx.org.id,
        actorType: 'user',
        actorId: ctx.user.id,
        action: 'integration.customers_synced',
        entity: 'integration',
        entityId: integration.id,
        meta: {
          kind: integration.kind,
          provider: result.provider,
          fetched: result.fetched,
          created: result.created,
          updated: result.updated,
          skipped: result.skipped,
        },
      })
      return json({ ...result, label: COMMERCE_LABELS[result.provider] })
    } catch (err) {
      throw new ApiError(
        502,
        err instanceof Error ? err.message : 'Customer sync failed',
        'sync_failed'
      )
    }
  },
  { roles: ['owner', 'admin'] }
)
