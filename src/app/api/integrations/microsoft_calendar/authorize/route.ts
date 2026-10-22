import { NextResponse } from 'next/server'
import { withAuth, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { randomToken } from '@/lib/crypto'
import { findMicrosoftIntegration, microsoftState } from '@/lib/integrations/microsoftAuth'
import { microsoftAuthUrl } from '@/lib/integrations/microsoftGraph'

/**
 * GET /api/integrations/microsoft_calendar/authorize (owner/admin)
 * Creates a server-side nonce, stores it in AppSetting, and redirects the browser
 * to Microsoft's consent screen. The nonce is one-time use — destroyed on callback.
 */
export const GET = withAuth(
  async (req, ctx) => {
    const integration = await findMicrosoftIntegration(ctx.org.id)
    if (!integration) {
      throw new ApiError(404, 'No Microsoft 365 integration configured yet — add one in Integrations first', 'not_found')
    }
    const origin = new URL(req.url).origin
    const state = microsoftState(integration, origin)
    if (!state.clientId || !state.clientSecret) {
      throw new ApiError(422, 'Save the Microsoft application (client) ID and secret before connecting.', 'bad_config')
    }
    const nonce = randomToken(16)
    await db.appSetting.upsert({
      where: { orgId_key: { orgId: ctx.org.id, key: `microsoft_oauth_state:${nonce}` } },
      create: { orgId: ctx.org.id, key: `microsoft_oauth_state:${nonce}`, value: JSON.stringify({ userId: ctx.user.id, createdAt: Date.now() }) },
      update: { value: JSON.stringify({ userId: ctx.user.id, createdAt: Date.now() }) },
    })
    await audit({
      orgId: ctx.org.id, actorType: 'user', actorId: ctx.user.id,
      action: 'integration.microsoft_oauth_authorize', entity: 'integration', entityId: integration.id,
      meta: { tenant: state.tenant },
    })
    return NextResponse.redirect(microsoftAuthUrl({ clientId: state.clientId, redirectUri: state.redirectUri, state: nonce, tenant: state.tenant }))
  },
  { roles: ['owner', 'admin'] }
)
