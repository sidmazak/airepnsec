import { db } from '@/lib/db'
import { ApiError } from '@/lib/api'
import { encryptSecret } from '@/lib/crypto'
import { decryptSecrets, integrationConfig, str, type TestResult } from '@/lib/integrations/connectors'
import {
  isAccessTokenFresh,
  refreshAccessToken,
  testMicrosoftCalendar,
  MICROSOFT_TENANT_DEFAULT,
} from '@/lib/integrations/microsoftGraph'

/**
 * Microsoft 365 calendar OAuth orchestration (server-side only).
 *
 * Same shape as the Google flow: the operator saves the client id/secret,
 * the authorize endpoint redirects to Microsoft's consent screen, the callback
 * exchanges the code for tokens and stores them encrypted. Tokens live in
 * `Integration.secretsEnc` and are never returned to the browser.
 */

export const MICROSOFT_INTEGRATION_KIND = 'microsoft_calendar'
export const MICROSOFT_CALLBACK_PATH = '/api/integrations/microsoft_calendar/callback'

export type MicrosoftState = {
  clientId: string
  clientSecret: string
  tenant: string
  calendarEmail: string
  redirectUri: string
  refreshToken: string
  accessToken: string
  accessTokenExpiresAt: string
}

export function microsoftState(integration: { configJson: string; secretsEnc: string }, origin: string): MicrosoftState {
  const config = integrationConfig(integration)
  const secrets = decryptSecrets(integration)
  return {
    clientId: str(secrets, 'clientId'),
    clientSecret: str(secrets, 'clientSecret'),
    tenant: str(config, 'tenant') || MICROSOFT_TENANT_DEFAULT,
    calendarEmail: str(config, 'calendarEmail') || '',
    redirectUri: str(config, 'redirectUri') || `${origin.replace(/\/$/, '')}${MICROSOFT_CALLBACK_PATH}`,
    refreshToken: str(secrets, 'refreshToken'),
    accessToken: str(secrets, 'accessToken'),
    accessTokenExpiresAt: str(secrets, 'accessTokenExpiresAt'),
  }
}

export async function findMicrosoftIntegration(orgId: string) {
  return db.integration.findFirst({ where: { orgId, kind: MICROSOFT_INTEGRATION_KIND } })
}

export async function storeMicrosoftTokens(
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

export async function ensureMicrosoftAccessToken(
  integration: { id: string; orgId: string; configJson: string; secretsEnc: string },
  origin: string
): Promise<{ token: string; state: MicrosoftState }> {
  const state = microsoftState(integration, origin)
  if (!state.clientId || !state.clientSecret) {
    throw new ApiError(422, 'Microsoft 365 needs a client ID and client secret — save them in Integrations first', 'bad_config')
  }
  if (state.accessToken && isAccessTokenFresh(state.accessTokenExpiresAt)) {
    return { token: state.accessToken, state }
  }
  if (!state.refreshToken) {
    throw new ApiError(422, 'Microsoft 365 is not connected yet — use "Connect Microsoft 365" to authorize it', 'not_connected')
  }
  const refreshed = await refreshAccessToken({
    clientId: state.clientId,
    clientSecret: state.clientSecret,
    refreshToken: state.refreshToken,
    tenant: state.tenant,
  })
  const secrets = decryptSecrets(integration)
  const merged = { ...secrets, accessToken: refreshed.accessToken, accessTokenExpiresAt: refreshed.accessTokenExpiresAt }
  await db.integration.update({ where: { id: integration.id }, data: { secretsEnc: encryptSecret(JSON.stringify(merged)) } })
  return {
    token: refreshed.accessToken,
    state: { ...state, accessToken: refreshed.accessToken, accessTokenExpiresAt: refreshed.accessTokenExpiresAt },
  }
}

export async function testMicrosoftCalendarIntegration(
  integration: { id: string; orgId: string; configJson: string; secretsEnc: string },
  origin: string
): Promise<TestResult> {
  const state = microsoftState(integration, origin)
  if (!state.clientId || !state.clientSecret) {
    return { ok: false, detail: 'Microsoft 365 needs a client ID and client secret before it can be connected' }
  }
  if (!state.refreshToken) {
    return { ok: false, detail: 'Microsoft 365 is not authorized yet — use "Connect Microsoft 365" to grant access' }
  }
  try {
    const { token } = await ensureMicrosoftAccessToken(integration, origin)
    return await testMicrosoftCalendar({ token })
  } catch (err) {
    return { ok: false, detail: `Microsoft 365 test failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
