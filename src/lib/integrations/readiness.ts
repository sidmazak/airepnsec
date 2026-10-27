import { db } from '@/lib/db'
import { catalogEntry } from './catalog'
import { decryptSecrets, integrationConfig, str, type IntegrationKind } from './connectors'
import {
  googleOAuthConnected, microsoftOAuthConnected, secretsAreSufficient,
} from './kinds'

/**
 * Live channel readiness, computed from the integrations that are actually
 * enabled and configured. This is the single source of truth for "can this
 * channel deliver?" — never an AppSetting toggle.
 */

export type ChannelKey =
  | 'email' | 'sms' | 'whatsapp' | 'voice' | 'imap'
  | 'calendar' | 'payments' | 'accounting' | 'commerce'

export type ChannelReadiness = {
  key: ChannelKey
  label: string
  ready: boolean
  /** Provider id within the kind (e.g. sendgrid, textbee) when meaningful. */
  provider: string | null
  /** Human label for the provider/kind. */
  providerLabel: string | null
  /** Enabled integration backing this channel, if any (for deep links). */
  integrationId: string | null
  /** Honest one-line status shown in the UI and stored on queued outbox rows. */
  detail: string
}

const CHANNEL_DEFS: Array<{ key: ChannelKey; label: string; kinds: IntegrationKind[] }> = [
  { key: 'email', label: 'Email', kinds: ['smtp', 'email_api'] },
  { key: 'sms', label: 'SMS', kinds: ['twilio_sms', 'sms_gateway'] },
  { key: 'whatsapp', label: 'WhatsApp', kinds: ['twilio_whatsapp', 'meta_whatsapp'] },
  { key: 'voice', label: 'Phone receptionist', kinds: ['twilio_voice'] },
  { key: 'imap', label: 'Inbound email', kinds: ['imap'] },
  { key: 'calendar', label: 'Calendar sync', kinds: ['google_calendar', 'microsoft_calendar', 'caldav'] },
  { key: 'payments', label: 'Payment links', kinds: ['stripe', 'square'] },
  { key: 'accounting', label: 'Accounting sync', kinds: ['quickbooks', 'xero', 'myob'] },
  { key: 'commerce', label: 'Customer import', kinds: ['shopify', 'woocommerce', 'wix', 'mailchimp'] },
]

type IntegrationRow = {
  id: string
  kind: string
  configJson: string
  secretsEnc: string
  enabled: boolean
}

function safeSecrets(row: { secretsEnc: string }): Record<string, string> {
  try {
    return decryptSecrets(row)
  } catch {
    return {}
  }
}

function usable(row: IntegrationRow): boolean {
  if (!row.enabled) return false
  const config = integrationConfig(row)
  const secrets = safeSecrets(row)
  switch (row.kind) {
    case 'smtp':
      return Boolean(str(config, 'host') && str(config, 'from'))
    case 'email_api':
      return Boolean(
        secrets.apiKey && str(config, 'provider') && str(config, 'from') &&
        (str(config, 'provider') !== 'mailjet' || secrets.apiSecret)
      )
    case 'twilio_sms':
    case 'twilio_whatsapp':
    case 'twilio_voice':
      return Boolean(secrets.accountSid && secrets.authToken && str(config, 'from'))
    case 'meta_whatsapp':
      return Boolean(secrets.accessToken && secrets.appSecret && str(config, 'phoneNumberId'))
    case 'sms_gateway': {
      const provider = str(config, 'provider')
      return Boolean(provider) && (provider !== 'generic_http' || Boolean(str(config, 'url')))
    }
    case 'imap':
      return Boolean(str(config, 'host') && str(config, 'username') && secrets.password)
    case 'caldav':
      return Boolean(str(config, 'url'))
    case 'google_calendar':
      return googleOAuthConnected(secrets)
    case 'microsoft_calendar':
      return microsoftOAuthConnected(secrets)
    case 'stripe':
      return Boolean(secrets.secretKey)
    case 'square':
      return Boolean(secrets.accessToken && str(config, 'locationId'))
    case 'shopify':
      return Boolean(secrets.accessToken && str(config, 'shopDomain'))
    case 'woocommerce':
      return Boolean(secrets.consumerKey && secrets.consumerSecret && str(config, 'storeUrl'))
    case 'wix':
      return Boolean(secrets.apiKey && str(config, 'siteId'))
    case 'mailchimp':
      return Boolean(secrets.apiKey && str(config, 'listId'))
    default:
      return secretsAreSufficient(row.kind, secrets)
  }
}

function providerInfo(kind: string, config: Record<string, unknown>): { provider: string | null; label: string } {
  const entry = catalogEntry(kind)
  const configProvider = str(config, 'provider')
  if (configProvider) {
    const match = entry?.providers?.find((p) => p.id === configProvider)
    return { provider: configProvider, label: match?.label ?? configProvider }
  }
  switch (kind) {
    case 'smtp': return { provider: 'smtp', label: 'SMTP' }
    case 'twilio_sms': return { provider: 'twilio', label: 'Twilio SMS' }
    case 'twilio_whatsapp': return { provider: 'twilio', label: 'Twilio WhatsApp' }
    case 'meta_whatsapp': return { provider: 'meta', label: 'Meta WhatsApp' }
    case 'twilio_voice': return { provider: 'twilio', label: 'Twilio Voice' }
    case 'imap': return { provider: 'imap', label: 'IMAP' }
    default: return { provider: kind, label: entry?.title ?? kind }
  }
}

function readyDetail(kind: string, config: Record<string, unknown>, label: string): string {
  switch (kind) {
    case 'smtp': return `SMTP · ${str(config, 'host')}`
    case 'email_api': return `${label} · from ${str(config, 'from') || 'not set'}`
    case 'twilio_sms':
    case 'twilio_whatsapp':
    case 'twilio_voice': return `Twilio · ${str(config, 'from') || 'sender not set'}`
    case 'meta_whatsapp': return `Meta Cloud API · ${str(config, 'phoneNumberId') || 'phone number ID not set'}`
    case 'sms_gateway': return `${label}${str(config, 'from') ? ` · ${str(config, 'from')}` : ''}`
    case 'imap': return `IMAP · ${str(config, 'host')}`
    case 'caldav': return `CalDAV · ${str(config, 'url')}`
    case 'google_calendar': return 'Google Calendar connected'
    case 'microsoft_calendar': return 'Microsoft 365 connected'
    case 'stripe': return 'Stripe keys saved'
    case 'square': return `Square · ${str(config, 'environment') || 'production'}`
    case 'quickbooks': return 'QuickBooks connected'
    case 'xero': return 'Xero connected'
    case 'myob': return 'MYOB connected'
    default: return label
  }
}

export async function getChannelReadiness(orgId: string): Promise<ChannelReadiness[]> {
  const rows = await db.integration.findMany({
    where: { orgId },
    select: { id: true, kind: true, configJson: true, secretsEnc: true, enabled: true },
    orderBy: { createdAt: 'asc' },
  })

  return CHANNEL_DEFS.map((def) => {
    const matching = rows.filter((row) => def.kinds.includes(row.kind as IntegrationKind))
    const enabled = matching.filter((row) => row.enabled)
    const ready = enabled.find((row) => usable(row))

    if (ready) {
      const config = integrationConfig(ready)
      const provider = providerInfo(ready.kind, config)
      return {
        key: def.key,
        label: def.label,
        ready: true,
        provider: provider.provider,
        providerLabel: provider.label,
        integrationId: ready.id,
        detail: readyDetail(ready.kind, config, provider.label),
      }
    }

    const pending = enabled[0]
    if (pending) {
      const label = providerInfo(pending.kind, integrationConfig(pending)).label
      const needsConsent = pending.kind === 'google_calendar' || pending.kind === 'microsoft_calendar'
      return {
        key: def.key,
        label: def.label,
        ready: false,
        provider: providerInfo(pending.kind, integrationConfig(pending)).provider,
        providerLabel: label,
        integrationId: pending.id,
        detail: needsConsent
          ? `${label} is enabled — finish the OAuth connection in Integrations`
          : `${label} is enabled but missing required configuration`,
      }
    }

    return {
      key: def.key,
      label: def.label,
      ready: false,
      provider: null,
      providerLabel: null,
      integrationId: null,
      detail: `No ${def.label.toLowerCase()} integration is enabled`,
    }
  })
}

/** Map form for callers that only need one channel. */
export async function getChannelReadinessMap(orgId: string): Promise<Record<ChannelKey, ChannelReadiness>> {
  const list = await getChannelReadiness(orgId)
  return Object.fromEntries(list.map((item) => [item.key, item])) as Record<ChannelKey, ChannelReadiness>
}
