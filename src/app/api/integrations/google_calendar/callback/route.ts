import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { exchangeCodeForTokens } from '@/lib/integrations/googleCalendar'
import { findGoogleIntegration, googleState, storeGoogleTokens } from '@/lib/integrations/googleAuth'

const STATE_TTL_MS = 10 * 60 * 1000

function backToApp(origin: string, params: string): NextResponse {
  return NextResponse.redirect(new URL(`/?${params}#integrations`, origin), { status: 302 })
}

/**
 * GET /api/integrations/google_calendar/callback
 * Google's redirect target. The browser arrives cross-site, so the session cookie
 * is NOT relied on — the one-time `state` nonce (stored server-side, 10 min TTL)
 * identifies the org. Tokens are written to the encrypted secrets blob and never
 * exposed to the browser.
 */
export const GET = withPublic(async (req) => {
  const url = new URL(req.url)
  const origin = url.origin
  const code = url.searchParams.get('code') || ''
  const state = url.searchParams.get('state') || ''
  const oauthError = url.searchParams.get('error') || ''

  if (oauthError) {
    return backToApp(origin, `google_calendar=error&reason=${encodeURIComponent(`Google returned an error: ${oauthError}`)}`)
  }
  if (!code || !state) {
    return backToApp(origin, `google_calendar=error&reason=${encodeURIComponent('Google did not return an authorization code')}`)
  }

  const row = await db.appSetting.findFirst({ where: { key: `google_oauth_state:${state}` } })
  if (!row) {
    return backToApp(origin, `google_calendar=error&reason=${encodeURIComponent('This connect request expired — try again')}`)
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
    return backToApp(origin, `google_calendar=error&reason=${encodeURIComponent('This connect request expired — try again')}`)
  }

  const integration = await findGoogleIntegration(row.orgId)
  if (!integration) {
    return backToApp(origin, `google_calendar=error&reason=${encodeURIComponent('The Google Calendar integration was removed while connecting')}`)
  }
  const gState = googleState(integration, origin)
  if (!gState.clientId || !gState.clientSecret) {
    return backToApp(origin, `google_calendar=error&reason=${encodeURIComponent('The Google client ID or client secret is missing')}`)
  }

  try {
    const tokens = await exchangeCodeForTokens({
      clientId: gState.clientId,
      clientSecret: gState.clientSecret,
      code,
      redirectUri: gState.redirectUri,
    })
    await storeGoogleTokens(integration, tokens)
    await audit({
      orgId: row.orgId, actorType: 'user', actorId: meta.userId || '',
      action: 'integration.google_oauth_connected', entity: 'integration', entityId: integration.id,
      meta: { calendarId: gState.calendarId },
    })
    return backToApp(origin, 'google_calendar=connected')
  } catch (err) {
    await audit({
      orgId: row.orgId, actorType: 'user', actorId: meta.userId || '',
      action: 'integration.google_oauth_failed', entity: 'integration', entityId: integration.id,
      meta: { error: err instanceof Error ? err.message : 'unknown error' },
    })
    return backToApp(origin, `google_calendar=error&reason=${encodeURIComponent(err instanceof Error ? err.message : 'Google authorization failed')}`)
  }
})
