import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { exchangeCodeForTokens } from '@/lib/integrations/microsoftGraph'
import { findMicrosoftIntegration, microsoftState, storeMicrosoftTokens } from '@/lib/integrations/microsoftAuth'

const STATE_TTL_MS = 10 * 60 * 1000

function backToApp(origin: string, params: string): NextResponse {
  return NextResponse.redirect(new URL(`/?${params}#integrations`, origin), { status: 302 })
}

/**
 * GET /api/integrations/microsoft_calendar/callback
 * Microsoft's redirect target. The browser arrives cross-site, so the session
 * cookie is NOT relied on — the one-time `state` nonce (stored server-side,
 * 10 min TTL) identifies the org. Tokens are written to the encrypted secrets
 * blob and never exposed to the browser.
 */
export const GET = withPublic(async (req) => {
  const url = new URL(req.url)
  const origin = url.origin
  const code = url.searchParams.get('code') || ''
  const state = url.searchParams.get('state') || ''
  const oauthError = url.searchParams.get('error') || ''

  if (oauthError) {
    return backToApp(origin, `microsoft_calendar=error&reason=${encodeURIComponent(`Microsoft returned an error: ${oauthError}`)}`)
  }
  if (!code || !state) {
    return backToApp(origin, `microsoft_calendar=error&reason=${encodeURIComponent('Microsoft did not return an authorization code')}`)
  }

  const row = await db.appSetting.findFirst({ where: { key: `microsoft_oauth_state:${state}` } })
  if (!row) {
    return backToApp(origin, `microsoft_calendar=error&reason=${encodeURIComponent('This connect request expired — try again')}`)
  }
  // One-time use: destroy the nonce before doing anything else.
  await db.appSetting.deleteMany({ where: { id: row.id } })

  let meta: { userId?: string; createdAt?: number } = {}
  try {
    meta = JSON.parse(row.value) as { userId?: string; createdAt?: number }
  } catch {
    meta = {}
  }
  if (!meta.createdAt || Date.now() - meta.createdAt > STATE_TTL_MS) {
    return backToApp(origin, `microsoft_calendar=error&reason=${encodeURIComponent('This connect request expired — try again')}`)
  }

  const integration = await findMicrosoftIntegration(row.orgId)
  if (!integration) {
    return backToApp(origin, `microsoft_calendar=error&reason=${encodeURIComponent('The Microsoft 365 integration was removed while connecting')}`)
  }
  const mState = microsoftState(integration, origin)
  if (!mState.clientId || !mState.clientSecret) {
    return backToApp(origin, `microsoft_calendar=error&reason=${encodeURIComponent('The Microsoft application ID or secret is missing')}`)
  }

  try {
    const tokens = await exchangeCodeForTokens({
      clientId: mState.clientId,
      clientSecret: mState.clientSecret,
      code,
      redirectUri: mState.redirectUri,
      tenant: mState.tenant,
    })
    await storeMicrosoftTokens(integration, tokens)
    await audit({
      orgId: row.orgId, actorType: 'user', actorId: meta.userId || '',
      action: 'integration.microsoft_oauth_connected', entity: 'integration', entityId: integration.id,
      meta: { tenant: mState.tenant },
    })
    return backToApp(origin, 'microsoft_calendar=connected')
  } catch (err) {
    await audit({
      orgId: row.orgId, actorType: 'user', actorId: meta.userId || '',
      action: 'integration.microsoft_oauth_failed', entity: 'integration', entityId: integration.id,
      meta: { error: err instanceof Error ? err.message : 'unknown error' },
    })
    return backToApp(origin, `microsoft_calendar=error&reason=${encodeURIComponent(err instanceof Error ? err.message : 'Microsoft authorization failed')}`)
  }
})
