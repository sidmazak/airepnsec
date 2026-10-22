import { db } from '@/lib/db'
import { ApiError } from '@/lib/api'
import { encryptSecret } from '@/lib/crypto'
import { decryptSecrets, integrationConfig, str, type TestResult } from '@/lib/integrations/connectors'
import {
  isAccessTokenFresh,
  refreshAccessToken,
  testGoogleCalendar,
} from '@/lib/integrations/googleCalendar'

/**
 * Google Calendar OAuth orchestration (server-side only).
 *
 * Flow:
 *  1. the operator saves clientId + clientSecret on the `google_calendar` integration;
 *  2. /api/integrations/google_calendar/authorize redirects to Google's consent screen;
 *  3. Google calls back with a code; we exchange it for tokens and store the refresh
 *     token encrypted (never returned to the browser);
 *  4. access tokens are refreshed on demand with the refresh token.
 *
 * All tokens live in Integration.secretsEnc (AES-256-GCM) — never in the DB in
 * clear text and never echoed back to the client.
 */

export const GOOGLE_INTEGRATION_KIND = 'google_calendar'
export const GOOGLE_CALLBACK_PATH = '/api/integrations/google_calendar/callback'

export type GoogleState = {
  clientId: string
  clientSecret: string
  calendarId: string
  redirectUri: string
  refreshToken: string
  accessToken: string
  accessTokenExpiresAt: string
}

/** Read the integration's Google state (secrets stay server-side). */
export function googleState(integration: { configJson: string; secretsEnc: string }, origin: string): GoogleState {
  const config = integrationConfig(integration)
  const secrets = decryptSecrets(integration)
  return {
    clientId: str(secrets, 'clientId'),
    clientSecret: str(secrets, 'clientSecret'),
    calendarId: str(config, 'calendarId') || 'primary',
    redirectUri: str(config, 'redirectUri') || `${origin.replace(/\/$/, '')}${GOOGLE_CALLBACK_PATH}`,
    refreshToken: str(secrets, 'refreshToken'),
    accessToken: str(secrets, 'accessToken'),
    accessTokenExpiresAt: str(secrets, 'accessTokenExpiresAt'),
  }
}

/** The org's Google Calendar integration row (singleton), or null. */
export async function findGoogleIntegration(orgId: string) {
  return db.integration.findFirst({ where: { orgId, kind: GOOGLE_INTEGRATION_KIND } })
}

/** Persist the OAuth tokens returned by Google's callback. */
export async function storeGoogleTokens(
  integration: { id: string; orgId: string; configJson: string; secretsEnc: string },
  tokens: { accessToken: string; refreshToken: string; accessTokenExpiresAt: string }
): Promise<void> {
  const secrets = decryptSecrets(integration)
  const merged = {
    ...secrets,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
  }
  await db.integration.update({
    where: { id: integration.id },
    data: { secretsEnc: encryptSecret(JSON.stringify(merged)), enabled: true },
  })
}

/**
 * Return a usable access token, refreshing it when needed and persisting the
 * new one. Throws a clear error when the integration was never connected.
 */
export async function ensureGoogleAccessToken(
  integration: { id: string; orgId: string; configJson: string; secretsEnc: string },
  origin: string
): Promise<{ token: string; state: GoogleState }> {
  const state = googleState(integration, origin)
  if (!state.clientId || !state.clientSecret) {
    throw new ApiError(422, 'Google Calendar needs a client ID and client secret — save them in Integrations first', 'bad_config')
  }
  if (state.accessToken && isAccessTokenFresh(state.accessTokenExpiresAt)) {
    return { token: state.accessToken, state }
  }
  if (!state.refreshToken) {
    throw new ApiError(422, 'Google Calendar is not connected yet — use "Connect Google Calendar" to authorize it', 'not_connected')
  }
  const refreshed = await refreshAccessToken({
    clientId: state.clientId,
    clientSecret: state.clientSecret,
    refreshToken: state.refreshToken,
  })
  const secrets = decryptSecrets(integration)
  const merged = { ...secrets, accessToken: refreshed.accessToken, accessTokenExpiresAt: refreshed.accessTokenExpiresAt }
  await db.integration.update({ where: { id: integration.id }, data: { secretsEnc: encryptSecret(JSON.stringify(merged)) } })
  return {
    token: refreshed.accessToken,
    state: { ...state, accessToken: refreshed.accessToken, accessTokenExpiresAt: refreshed.accessTokenExpiresAt },
  }
}

/** Real connection test — asks Google for the calendar the integration points at. */
export async function testGoogleCalendarIntegration(
  integration: { id: string; orgId: string; configJson: string; secretsEnc: string },
  origin: string
): Promise<TestResult> {
  const state = googleState(integration, origin)
  if (!state.clientId || !state.clientSecret) {
    return { ok: false, detail: 'Google Calendar needs a client ID and client secret before it can be connected' }
  }
  if (!state.refreshToken) {
    return { ok: false, detail: 'Google Calendar is not authorized yet — use "Connect Google Calendar" to grant access' }
  }
  try {
    const { token } = await ensureGoogleAccessToken(integration, origin)
    return await testGoogleCalendar({ token, calendarId: state.calendarId })
  } catch (err) {
    return { ok: false, detail: `Google Calendar test failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
