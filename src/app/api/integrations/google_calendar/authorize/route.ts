import { NextResponse } from 'next/server'
import { withAuth, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { randomToken } from '@/lib/crypto'
import { findGoogleIntegration, googleState } from '@/lib/integrations/googleAuth'
import { googleAuthUrl } from '@/lib/integrations/googleCalendar'

/**
 * GET /api/integrations/google_calendar/authorize (owner/admin)
 * Creates a server-side nonce, stores it in AppSetting, and redirects the browser
 * to Google's consent screen. The nonce is one-time use — destroyed on callback.
 */
export const GET = withAuth(
  async (req, ctx) => {
    const integration = await findGoogleIntegration(ctx.org.id)
    if (!integration) {
      throw new ApiError(404, 'No Google Calendar integration configured yet — add one in Integrations first', 'not_found')
    }
    const origin = new URL(req.url).origin
    const state = googleState(integration, origin)
    if (!state.clientId || !state.clientSecret) {
      throw new ApiError(422, 'Save the Google client ID and client secret before connecting.', 'bad_config')
    }
    const nonce = randomToken(16)
    await db.appSetting.upsert({
      where: { orgId_key: { orgId: ctx.org.id, key: `google_oauth_state:${nonce}` } },
      create: { orgId: ctx.org.id, key: `google_oauth_state:${nonce}`, value: JSON.stringify({ userId: ctx.user.id, createdAt: Date.now() }) },
      update: { value: JSON.stringify({ userId: ctx.user.id, createdAt: Date.now() }) },
    })
    await audit({
      orgId: ctx.org.id, actorType: 'user', actorId: ctx.user.id,
      action: 'integration.google_oauth_authorize', entity: 'integration', entityId: integration.id,
      meta: { calendarId: state.calendarId },
    })
    return NextResponse.redirect(googleAuthUrl({ clientId: state.clientId, redirectUri: state.redirectUri, state: nonce }))
  },
  { roles: ['owner', 'admin'] }
)
