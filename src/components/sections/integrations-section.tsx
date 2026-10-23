'use client'

/**
 * Integrations hub — BYOK connectors (SMTP, Twilio SMS/WhatsApp, Stripe,
 * outbound webhooks), the outbox with real dispatch, the iCalendar feed and
 * the inbound payment webhook secret.
 *
 * Honesty rules mirrored from the backend:
 * - Secrets are encrypted at rest (AES-256-GCM) and are NEVER returned after
 *   saving — the UI only knows whether credentials exist (`configured`).
 * - Saving a credential field replaces the whole stored credential set, so the
 *   dialog says so explicitly and only sends fields the user typed.
 * - Delivery states come straight from the outbox rows (queued/sent/failed/
 *   skipped + statusReason). Nothing here claims "sent" unless the API did.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  api, formatDateTime,
  type IntegrationInfo, type IntegrationTestResult, type OutboxDispatchStats, type OutboxRow,
} from '@/lib/client/api'
import { useAppStore } from '@/lib/client/store'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  BookOpen, CalendarClock, CalendarDays, CheckCircle2, Copy, CreditCard, ExternalLink, KeyRound, Loader2,
  Mail, MessageSquare, Phone, PhoneCall, Plug, RefreshCw, Send, ShoppingBag, Smartphone, Store, Trash2, Users, Webhook as WebhookIcon, XCircle,
} from 'lucide-react'

/* ------------------------------ helpers ------------------------------ */

function friendlyApiErrorLocal(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  return fallback
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

/** window.location.origin — this section only mounts client-side (after auth), so a lazy initializer is hydration-safe. */
function useOrigin(): string {
  const [origin] = useState(() => (typeof window !== 'undefined' ? window.location.origin : ''))
  return origin
}

const KIND_META: Record<string, { title: string; icon: typeof Mail; blurb: string; needsCredentials: boolean }> = {
  smtp: {
    title: 'Email (SMTP)',
    icon: Mail,
    blurb: 'Outgoing email for invoices, reminders and receipts. Point it at your own SMTP server or relay.',
    needsCredentials: false,
  },
  email_api: {
    title: 'Email (provider API)',
    icon: Mail,
    blurb: 'Send invoice and reminder email through SendGrid, Mailgun, Postmark, Resend or Brevo — alternative to SMTP.',
    needsCredentials: true,
  },
  twilio_sms: {
    title: 'SMS (Twilio)',
    icon: MessageSquare,
    blurb: 'Text messages for reminders and escalations, sent from your own Twilio account.',
    needsCredentials: true,
  },
  twilio_whatsapp: {
    title: 'WhatsApp (Twilio)',
    icon: Phone,
    blurb: 'WhatsApp messages via Twilio (requires a WhatsApp-enabled sender).',
    needsCredentials: true,
  },
  twilio_voice: {
    title: 'Phone Receptionist (Twilio Voice)',
    icon: PhoneCall,
    blurb: 'Point your Twilio number at this app: the AI receptionist answers real calls and texts, books, quotes prices and escalates.',
    needsCredentials: true,
  },
  sms_gateway: {
    title: 'SMS Gateway (bring your own)',
    icon: Smartphone,
    blurb: 'Send SMS through your own phone/modem or bridge — TextBee, httpSMS, android-sms-gateway, or any HTTP gateway (incl. iOS/iMessage bridges). Alternative to Twilio.',
    // Self-hosted gateways (android-sms-gateway local mode, a LAN/iOS bridge) can be
    // credential-less, so enabling is not blocked; the real connection test reports the truth.
    needsCredentials: false,
  },
  caldav: {
    title: 'Calendar Sync (CalDAV)',
    icon: CalendarClock,
    blurb: 'Push upcoming bookings to your own calendar — Nextcloud, Fastmail, Radicale, iCloud (app password).',
    needsCredentials: false,
  },
  google_calendar: {
    title: 'Google Calendar',
    icon: CalendarDays,
    blurb: 'Two-way sync with Google Calendar: your busy times block the bookable slots, and bookings appear on your calendar.',
    needsCredentials: true,
  },
  microsoft_calendar: {
    title: 'Microsoft 365 Calendar',
    icon: CalendarDays,
    blurb: 'Two-way sync with Microsoft 365 through the Graph API: busy times block the bookable slots, and bookings appear in Outlook.',
    needsCredentials: true,
  },
  stripe: {
    title: 'Payments (Stripe)',
    icon: CreditCard,
    blurb: 'Real Stripe payment links on invoices. Callbacks are verified against your signing secret.',
    needsCredentials: true,
  },
  square: {
    title: 'Payments (Square)',
    icon: CreditCard,
    blurb: 'Square payment links on invoices, with signed webhook callbacks that record verified payments.',
    needsCredentials: true,
  },
  quickbooks: {
    title: 'Accounting (QuickBooks Online)',
    icon: BookOpen,
    blurb: 'Push issued invoices and create customers in QuickBooks Online with your own OAuth app.',
    needsCredentials: true,
  },
  xero: {
    title: 'Accounting (Xero)',
    icon: BookOpen,
    blurb: 'Push issued invoices and contacts into Xero using your Xero OAuth app.',
    needsCredentials: true,
  },
  myob: {
    title: 'Accounting (MYOB AccountRight)',
    icon: BookOpen,
    blurb: 'Push issued invoices and customers into MYOB AccountRight company files.',
    needsCredentials: true,
  },
  shopify: {
    title: 'Shopify',
    icon: ShoppingBag,
    blurb: 'Import Shopify customers (with tags) into your customer list.',
    needsCredentials: true,
  },
  woocommerce: {
    title: 'WooCommerce',
    icon: Store,
    blurb: 'Import WooCommerce customers from your WordPress store.',
    needsCredentials: true,
  },
  wix: {
    title: 'Wix',
    icon: Users,
    blurb: 'Import Wix contacts into your customer list.',
    needsCredentials: true,
  },
  mailchimp: {
    title: 'Mailchimp',
    icon: Mail,
    blurb: 'Import Mailchimp audience members into your customer list.',
    needsCredentials: true,
  },
  webhook_out: {
    title: 'Webhooks',
    icon: WebhookIcon,
    blurb: 'Zapier / Make / custom endpoints that receive signed events.',
    needsCredentials: false,
  },
}

const SINGLETON_KINDS = [
  'smtp', 'email_api', 'twilio_sms', 'twilio_whatsapp', 'twilio_voice', 'sms_gateway', 'caldav',
  'google_calendar', 'microsoft_calendar', 'stripe', 'square', 'quickbooks', 'xero', 'myob',
  'shopify', 'woocommerce', 'wix', 'mailchimp',
] as const

const COMMERCE_KINDS = ['shopify', 'woocommerce', 'wix', 'mailchimp'] as const

const OUTBOX_STATUS_CLASS: Record<string, string> = {
  sent: 'bg-emerald-100 text-emerald-900',
  queued: 'bg-amber-100 text-amber-900',
  failed: 'bg-rose-100 text-rose-900',
  skipped: 'bg-muted text-muted-foreground border',
}

function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
  const { toast } = useToast()
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button" variant="outline" size="sm"
      className={cn('min-h-[44px]', className)}
      aria-label={label}
      disabled={!value}
      onClick={async () => {
        const ok = await copyText(value)
        setCopied(ok)
        if (ok) toast({ title: 'Copied to clipboard' })
        else toast({ title: 'Copy failed', description: 'Select the text and copy it manually.', variant: 'destructive' })
        setTimeout(() => setCopied(false), 2000)
      }}
    >
      {copied ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}

type GoogleLastSync = { at: string; direction?: string; pushed: number; failed: number; total: number; blocksAdded?: number; blocksRemoved?: number; pulled?: { cancelled: number; rescheduled: number; unchanged: number; removed: number; failed: number; total: number } }

function GoogleCalendarBox({ connected, canManage, onChanged }: { connected: boolean; canManage: boolean; onChanged: () => Promise<void> | void }) {
  const { toast } = useToast()
  const [info, setInfo] = useState<{ enabled: boolean; lastSync: GoogleLastSync | null; activeBlocks: number } | null>(null)
  const [syncing, setSyncing] = useState(false)

  const load = useCallback(() => {
    api.get<{ enabled: boolean; lastSync: GoogleLastSync | null; activeBlocks: number }>('/api/integrations/google-calendar/sync')
      .then(setInfo).catch(() => setInfo(null))
  }, [])

  useEffect(() => { load() }, [load])

  const syncNow = async () => {
    setSyncing(true)
    try {
      const r = await api.post<{ direction: string; pushed: number; failed: number; total: number; pulled: Record<string,number>; results: Array<unknown>; syncedAt: string; errors: string[] }>('/api/integrations/google-calendar/sync')
      const pulledBits = [
        r.pulled.cancelled ? `${r.pulled.cancelled} cancelled remotely` : '',
        r.pulled.rescheduled ? `${r.pulled.rescheduled} moved remotely` : '',
        r.pulled.removed ? `${r.pulled.removed} pulled back` : '',
        r.pulled.failed ? `${r.pulled.failed} pull errors` : '',
      ].filter(Boolean).join(', ')
      toast({
        title: r.total === 0 && Object.keys(r.pulled||{}).length === 0
          ? 'No upcoming bookings to sync'
          : `Google Calendar sync: ${r.pushed}/${r.total} bookings written${r.failed ? `, ${r.failed} failed` : ''}${pulledBits ? `; ${pulledBits}` : ''}`,
        variant: r.failed > 0 || (r.pulled?.failed ?? 0) > 0 ? 'destructive' : 'default',
      })
      load()
      await onChanged()
    } catch (err) {
      toast({ title: 'Google Calendar sync failed', description: friendlyApiErrorLocal(err, 'Unknown error'), variant: 'destructive' })
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Bookings ↔ Google Calendar (two-way)</p>
        {connected && info?.enabled ? (
          <Button variant="outline" size="sm" className="min-h-[36px]" onClick={() => void syncNow()} disabled={syncing}>
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
            Sync now
          </Button>
        ) : !connected ? (
          <Button asChild variant="outline" size="sm" className="min-h-[36px]" disabled={!canManage}>
            <a href="/api/integrations/google_calendar/authorize">Connect Google Calendar</a>
          </Button>
        ) : null}
      </div>
      {!connected ? (
        <p className="text-xs text-muted-foreground">Save your OAuth client ID and secret under Integrations first, then connect.</p>
      ) : info?.lastSync ? (
        <p className="text-xs text-muted-foreground">
          Last sync {formatDateTime(info.lastSync.at)} — {info.lastSync.pushed}/{info.lastSync.total} bookings written{info.lastSync.failed ? `, ${info.lastSync.failed} failed` : ''}
          {(info.lastSync.blocksAdded !== undefined || info.lastSync.blocksRemoved !== undefined)
            ? ` · blocks ${info.lastSync.blocksAdded ?? 0} added / ${info.lastSync.blocksRemoved ?? 0} removed`
            : ''}.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">No sync yet — connect a calendar first.</p>
      )}
    </div>
  )
}

/* ------------------------------ drafts ------------------------------ */


type ConfigDraft = {
  host: string; port: string; secure: boolean; from: string; fromName: string; domain: string; region: string; messageStream: string
  url: string; username: string; language: string; voiceName: string; transferNumber: string; publicBaseUrl: string; provider: string
  baseUrl: string; deviceId: string; method: string; authHeaderName: string; bodyTemplate: string; testRecipient: string; allowPrivate: boolean
  calendarId: string; redirectUri: string; tenant: string; calendarEmail: string
  locationId: string; environment: string; notificationUrl: string
  realmId: string; tenantId: string; companyFileId: string; salesAccountCode: string
  shopDomain: string; storeUrl: string; siteId: string; serverPrefix: string; listId: string
}
type SecretsDraft = {
  user: string; pass: string; accountSid: string; authToken: string; secretKey: string; webhookSecret: string; secret: string
  password: string; apiKey: string; apiSecret: string; accountId: string; username: string; passwordGw: string; token: string
  authValue: string; clientId: string; clientSecret: string; accessToken: string; webhookSignatureKey: string; refreshToken: string
  consumerKey: string; consumerSecret: string
}

const EMPTY_CONFIG: ConfigDraft = {
  host: '', port: '', secure: false, from: '', fromName: '', domain: '', region: 'us', messageStream: '',
  url: '', username: '', language: '', voiceName: '', transferNumber: '', publicBaseUrl: '', provider: 'textbee',
  baseUrl: '', deviceId: '', method: 'POST', authHeaderName: '', bodyTemplate: '', testRecipient: '', allowPrivate: false,
  calendarId: 'primary', redirectUri: '', tenant: 'common', calendarEmail: '',
  locationId: '', environment: 'production', notificationUrl: '',
  realmId: '', tenantId: '', companyFileId: '', salesAccountCode: '',
  shopDomain: '', storeUrl: '', siteId: '', serverPrefix: '', listId: '',
}
const EMPTY_SECRETS: SecretsDraft = {
  user: '', pass: '', accountSid: '', authToken: '', secretKey: '', webhookSecret: '', secret: '', password: '',
  apiKey: '', apiSecret: '', accountId: '', username: '', passwordGw: '', token: '', authValue: '',
  clientId: '', clientSecret: '', accessToken: '', webhookSignatureKey: '', refreshToken: '',
  consumerKey: '', consumerSecret: '',
}

function buildConfig(kind: string, d: ConfigDraft): Record<string, unknown> {
  if (kind === 'smtp') {
    return { host: d.host.trim(), port: Number.parseInt(d.port, 10) || 0, secure: d.secure, from: d.from.trim() }
  }
  if (kind === 'email_api') {
    const out: Record<string, unknown> = { provider: d.provider || 'sendgrid', from: d.from.trim() }
    if (d.fromName.trim()) out.fromName = d.fromName.trim()
    if (d.provider === 'mailgun') {
      out.domain = d.domain.trim()
      out.region = d.region === 'eu' ? 'eu' : 'us'
    }
    if (d.provider === 'postmark' && d.messageStream.trim()) out.messageStream = d.messageStream.trim()
    return out
  }
  if (kind === 'twilio_sms' || kind === 'twilio_whatsapp') return { from: d.from.trim() }
  if (kind === 'twilio_voice') {
    const out: Record<string, unknown> = { from: d.from.trim() }
    if (d.language.trim()) out.language = d.language.trim()
    if (d.voiceName.trim()) out.voiceName = d.voiceName.trim()
    if (d.transferNumber.trim()) out.transferNumber = d.transferNumber.trim()
    if (d.publicBaseUrl.trim()) out.publicBaseUrl = d.publicBaseUrl.trim()
    return out
  }
  if (kind === 'sms_gateway') {
    const out: Record<string, unknown> = { provider: d.provider }
    if (d.baseUrl.trim()) out.baseUrl = d.baseUrl.trim()
    if (d.from.trim()) out.from = d.from.trim()
    if (d.deviceId.trim()) out.deviceId = d.deviceId.trim()
    if (d.provider === 'generic_http') {
      out.url = d.url.trim()
      out.method = d.method === 'PUT' ? 'PUT' : 'POST'
      if (d.authHeaderName.trim()) out.authHeaderName = d.authHeaderName.trim()
      if (d.bodyTemplate.trim()) out.bodyTemplate = d.bodyTemplate.trim()
      if (d.testRecipient.trim()) out.testRecipient = d.testRecipient.trim()
    }
    return out
  }
  if (kind === 'caldav') {
    const out: Record<string, unknown> = { url: d.url.trim() }
    if (d.username.trim()) out.username = d.username.trim()
    return out
  }
  if (kind === 'google_calendar') {
    const out: Record<string, unknown> = { calendarId: d.calendarId.trim() || 'primary' }
    if (d.redirectUri.trim()) out.redirectUri = d.redirectUri.trim()
    return out
  }
  if (kind === 'microsoft_calendar') {
    const out: Record<string, unknown> = { tenant: d.tenant.trim() || 'common' }
    if (d.calendarEmail.trim()) out.calendarEmail = d.calendarEmail.trim()
    if (d.redirectUri.trim()) out.redirectUri = d.redirectUri.trim()
    return out
  }
  if (kind === 'webhook_out') {
    const out: Record<string, unknown> = { url: d.url.trim() }
    if (d.allowPrivate) out.allowPrivate = true
    return out
  }
  if (kind === 'square') {
    const out: Record<string, unknown> = { locationId: d.locationId.trim(), environment: d.environment === 'sandbox' ? 'sandbox' : 'production' }
    if (d.notificationUrl.trim()) out.notificationUrl = d.notificationUrl.trim()
    return out
  }
  if (kind === 'quickbooks' || kind === 'xero' || kind === 'myob') {
    const out: Record<string, unknown> = {}
    if (kind === 'quickbooks') out.realmId = d.realmId.trim()
    if (kind === 'xero') out.tenantId = d.tenantId.trim()
    if (kind === 'myob') out.companyFileId = d.companyFileId.trim()
    if (d.salesAccountCode.trim()) out.salesAccountCode = d.salesAccountCode.trim()
    return out
  }
  if (kind === 'shopify') return { shopDomain: d.shopDomain.trim() }
  if (kind === 'woocommerce') {
    const out: Record<string, unknown> = { storeUrl: d.storeUrl.trim() }
    if (d.allowPrivate) out.allowPrivate = true
    return out
  }
  if (kind === 'wix') return { siteId: d.siteId.trim() }
  if (kind === 'mailchimp') return { serverPrefix: d.serverPrefix.trim(), listId: d.listId.trim() }
  return {} // stripe — config only holds secrets
}

/**
 * Only fields the user actually typed are sent. The backend treats `secrets`
 * as FULL replacement, so sending nothing keeps the stored set intact.
 */
function collectSecrets(kind: string, d: SecretsDraft): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  if (kind === 'smtp') {
    if (d.user.trim()) out.user = d.user.trim()
    if (d.pass) out.pass = d.pass
  } else if (kind === 'twilio_sms' || kind === 'twilio_whatsapp' || kind === 'twilio_voice') {
    if (d.accountSid.trim()) out.accountSid = d.accountSid.trim()
    if (d.authToken) out.authToken = d.authToken
  } else if (kind === 'email_api') {
    if (d.apiKey) out.apiKey = d.apiKey
  } else if (kind === 'sms_gateway') {
    if (d.apiKey) out.apiKey = d.apiKey
    if (d.apiSecret) out.apiSecret = d.apiSecret
    if (d.accountId.trim()) out.accountId = d.accountId.trim()
    if (d.username.trim()) out.username = d.username.trim()
    if (d.passwordGw) out.password = d.passwordGw
    if (d.token) out.token = d.token
    if (d.authValue) out.authValue = d.authValue
  } else if (kind === 'caldav') {
    if (d.password) out.password = d.password
  } else if (kind === 'stripe') {
    if (d.secretKey) out.secretKey = d.secretKey
    if (d.webhookSecret) out.webhookSecret = d.webhookSecret
  } else if (kind === 'square') {
    if (d.accessToken) out.accessToken = d.accessToken
    if (d.webhookSignatureKey) out.webhookSignatureKey = d.webhookSignatureKey
  } else if (kind === 'quickbooks' || kind === 'xero' || kind === 'myob') {
    if (d.clientId.trim()) out.clientId = d.clientId.trim()
    if (d.clientSecret) out.clientSecret = d.clientSecret
    if (d.refreshToken) out.refreshToken = d.refreshToken
  } else if (kind === 'shopify') {
    if (d.accessToken) out.accessToken = d.accessToken
  } else if (kind === 'woocommerce') {
    if (d.consumerKey.trim()) out.consumerKey = d.consumerKey.trim()
    if (d.consumerSecret) out.consumerSecret = d.consumerSecret
  } else if (kind === 'wix' || kind === 'mailchimp') {
    if (d.apiKey) out.apiKey = d.apiKey
  } else if (kind === 'google_calendar' || kind === 'microsoft_calendar') {
    if (d.clientId.trim()) out.clientId = d.clientId.trim()
    if (d.clientSecret) out.clientSecret = d.clientSecret
  } else if (kind === 'webhook_out') {
    if (d.secret) out.secret = d.secret
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/* ------------------------------ drafts ------------------------------ */

/** One copyable webhook URL row (used by Twilio Voice/SMS setup). */
function WebhookUrlRow({ url, label }: { url: string; label: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground w-full sm:w-auto sm:min-w-[150px]">{label}</span>
      <code className="text-[11px] bg-muted rounded px-1.5 py-1 break-all flex-1 min-w-0">{url || '…'}</code>
      <CopyButton value={url} label={`Copy ${label} webhook URL`} className="min-h-[36px] px-2 text-xs" />
    </div>
  )
}

/** CalDAV push-sync box: shows last sync summary + runs a real sync now. */
type CalDavPulled = { cancelled: number; rescheduled: number; unchanged: number; missing: number; failed: number; total: number }
type CalDavLastSync = { at: string; direction?: string; pushed: number; failed: number; total: number; pulled?: CalDavPulled }

function CalDavSyncBox({ canManage, onChanged }: { canManage: boolean; onChanged: () => Promise<void> | void }) {
  const { toast } = useToast()
  const [info, setInfo] = useState<{ enabled: boolean; lastSync: CalDavLastSync | null } | null>(null)
  const [syncing, setSyncing] = useState(false)

  const load = useCallback(() => {
    api.get<{ enabled: boolean; lastSync: CalDavLastSync | null }>('/api/integrations/caldav-sync')
      .then(setInfo)
      .catch(() => setInfo(null))
  }, [])

  useEffect(() => { load() }, [load])

  const syncNow = async () => {
    setSyncing(true)
    try {
      const r = await api.post<{ pushed: number; failed: number; total: number; pulled: CalDavPulled }>('/api/integrations/caldav-sync')
      const pulledBits = [
        r.pulled.cancelled ? `${r.pulled.cancelled} cancelled remotely` : '',
        r.pulled.rescheduled ? `${r.pulled.rescheduled} moved remotely` : '',
        r.pulled.failed ? `${r.pulled.failed} pull errors` : '',
      ].filter(Boolean).join(', ')
      toast({
        title: r.total === 0 && r.pulled.total === 0
          ? 'Nothing to sync — no upcoming bookings in the next 45 days'
          : `Calendar sync: ${r.pushed}/${r.total} events written${r.failed ? `, ${r.failed} failed` : ''}${pulledBits ? `; ${pulledBits}` : ''}`,
        variant: r.failed > 0 || r.pulled.failed > 0 ? 'destructive' : 'default',
      })
      load()
      await onChanged()
    } catch (err) {
      toast({ title: 'CalDAV sync failed', description: friendlyApiErrorLocal(err, 'Unknown error'), variant: 'destructive' })
    } finally {
      setSyncing(false)
    }
  }

  const last = info?.lastSync
  const lastPulled = last?.pulled

  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Bookings ↔ calendar (two-way)</p>
        <Button variant="outline" size="sm" className="min-h-[36px]" onClick={() => void syncNow()} disabled={syncing || !canManage || !info?.enabled}>
          {syncing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
          Sync now
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {last
          ? `Last sync ${formatDateTime(last.at)} — ${last.pushed}/${last.total} events written${last.failed ? `, ${last.failed} failed` : ''}` +
            (lastPulled
              ? `; pulled: ${lastPulled.cancelled} cancelled, ${lastPulled.rescheduled} moved, ${lastPulled.missing} missing remotely${lastPulled.failed ? `, ${lastPulled.failed} errors` : ''}.`
              : '.')
          : 'Never synced yet. Enable the integration, then sync upcoming bookings (next 45 days). Remote cancellations and time changes are pulled back automatically.'}
      </p>
      {lastPulled && lastPulled.missing > 0 && (
        <p className="text-xs text-amber-700">
          {lastPulled.missing} pushed event(s) are no longer on the remote calendar. Local bookings are deliberately NOT cancelled by remote deletion — review the calendar first.
        </p>
      )}
    </div>
  )
}

function MicrosoftCalendarBox({ connected, canManage, onChanged }: { connected: boolean; canManage: boolean; onChanged: () => Promise<void> | void }) {
  const { toast } = useToast()
  const [info, setInfo] = useState<{ enabled: boolean; lastSync: GoogleLastSync | null; activeBlocks: number } | null>(null)
  const [syncing, setSyncing] = useState(false)

  const load = useCallback(() => {
    api.get<{ enabled: boolean; lastSync: GoogleLastSync | null; activeBlocks: number }>('/api/integrations/microsoft-calendar/sync')
      .then(setInfo).catch(() => setInfo(null))
  }, [])

  useEffect(() => { load() }, [load])

  const syncNow = async () => {
    setSyncing(true)
    try {
      const r = await api.post<{ direction: string; pushed: number; failed: number; total: number; pulled: Record<string, number>; results: Array<unknown>; syncedAt: string; errors: string[] }>('/api/integrations/microsoft-calendar/sync')
      const pulledBits = [
        r.pulled.cancelled ? `${r.pulled.cancelled} cancelled remotely` : '',
        r.pulled.rescheduled ? `${r.pulled.rescheduled} moved remotely` : '',
        r.pulled.removed ? `${r.pulled.removed} pulled back` : '',
        r.pulled.failed ? `${r.pulled.failed} pull errors` : '',
      ].filter(Boolean).join(', ')
      toast({
        title: r.total === 0 && Object.keys(r.pulled || {}).length === 0
          ? 'No upcoming bookings to sync'
          : `Microsoft 365 sync: ${r.pushed}/${r.total} bookings written${r.failed ? `, ${r.failed} failed` : ''}${pulledBits ? `; ${pulledBits}` : ''}`,
        variant: r.failed > 0 || (r.pulled?.failed ?? 0) > 0 ? 'destructive' : 'default',
      })
      load()
      await onChanged()
    } catch (err) {
      toast({ title: 'Microsoft 365 sync failed', description: friendlyApiErrorLocal(err, 'Unknown error'), variant: 'destructive' })
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Bookings &#8596; Microsoft 365 (two-way)</p>
        {connected && info?.enabled ? (
          <Button variant="outline" size="sm" className="min-h-[36px]" onClick={() => void syncNow()} disabled={syncing}>
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
            Sync now
          </Button>
        ) : !connected ? (
          <Button asChild variant="outline" size="sm" className="min-h-[36px]" disabled={!canManage}>
            <a href="/api/integrations/microsoft_calendar/authorize">Connect Microsoft 365</a>
          </Button>
        ) : null}
      </div>
      {!connected ? (
        <p className="text-xs text-muted-foreground">
          Save the Entra ID application (client) ID and secret under Integrations first, then connect. The redirect URI is{' '}
          <code className="bg-muted rounded px-1 py-0.5">/api/integrations/microsoft_calendar/callback</code>.
        </p>
      ) : info?.lastSync ? (
        <p className="text-xs text-muted-foreground">
          Last sync {formatDateTime(info.lastSync.at)} — {info.lastSync.pushed}/{info.lastSync.total} bookings written{info.lastSync.failed ? `, ${info.lastSync.failed} failed` : ''}
          {(info.lastSync.blocksAdded !== undefined || info.lastSync.blocksRemoved !== undefined)
            ? ` · blocks ${info.lastSync.blocksAdded ?? 0} added / ${info.lastSync.blocksRemoved ?? 0} removed`
            : ''}.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">No sync yet — connect the calendar first.</p>
      )}
    </div>
  )
}

/* ------------------------------ connector card (singletons) ------------------------------ */

function ConnectorCard({
  kind, row, canManage, onChanged,
}: {
  kind: string
  row: IntegrationInfo | null
  canManage: boolean
  onChanged: () => Promise<void> | void
}) {
  const { toast } = useToast()
  const origin = useOrigin()
  const meta = KIND_META[kind]
  const Icon = meta.icon

  const [dlgOpen, setDlgOpen] = useState(false)
  const [initialCfg, setInitialCfg] = useState<ConfigDraft>(EMPTY_CONFIG)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(null)
  const [toggling, setToggling] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const canSync = (COMMERCE_KINDS as readonly string[]).includes(kind)

  /** Snapshot the row's config at open time — later refreshes must not reset the dialog mid-edit. */
  const openDialog = () => {
    const c = row?.config ?? {}
    setInitialCfg({
      host: str(c.host), port: c.port != null ? String(c.port) : '', secure: c.secure === true,
      from: str(c.from), fromName: str(c.fromName), domain: str(c.domain),
      region: str(c.region) || 'us', messageStream: str(c.messageStream),
      url: str(c.url), username: str(c.username),
      language: str(c.language), voiceName: str(c.voiceName),
      transferNumber: str(c.transferNumber), publicBaseUrl: str(c.publicBaseUrl),
      provider: str(c.provider) || (kind === 'email_api' ? 'sendgrid' : 'textbee'), baseUrl: str(c.baseUrl), deviceId: str(c.deviceId),
      method: str(c.method) || 'POST', authHeaderName: str(c.authHeaderName),
      bodyTemplate: str(c.bodyTemplate), testRecipient: str(c.testRecipient),
      allowPrivate: c.allowPrivate === true,
      calendarId: str(c.calendarId) || 'primary', redirectUri: str(c.redirectUri),
      tenant: str(c.tenant) || 'common', calendarEmail: str(c.calendarEmail),
      locationId: str(c.locationId), environment: str(c.environment) || 'production', notificationUrl: str(c.notificationUrl),
      realmId: str(c.realmId), tenantId: str(c.tenantId), companyFileId: str(c.companyFileId), salesAccountCode: str(c.salesAccountCode),
      shopDomain: str(c.shopDomain), storeUrl: str(c.storeUrl), siteId: str(c.siteId),
      serverPrefix: str(c.serverPrefix), listId: str(c.listId),
    })
    setDlgOpen(true)
  }

  const runTest = async () => {
    if (!row) return
    setTesting(true)
    try {
      const r = await api.post<IntegrationTestResult>(`/api/integrations/${row.id}/test`)
      setTestResult(r)
      await onChanged()
    } catch (err) {
      setTestResult({ ok: false, detail: friendlyApiErrorLocal(err, 'Test failed') })
    } finally {
      setTesting(false)
    }
  }

  const toggleEnabled = async (next: boolean) => {
    if (!row) return
    setToggling(true)
    try {
      await api.patch(`/api/integrations/${row.id}`, { enabled: next })
      await onChanged()
      toast({
        title: next ? `${meta.title} enabled` : `${meta.title} disabled`,
        description: next ? 'The dispatcher will use this channel for queued messages.' : undefined,
      })
    } catch (err) {
      toast({ title: next ? 'Could not enable' : 'Could not disable', description: friendlyApiErrorLocal(err, 'Update failed'), variant: 'destructive' })
    } finally {
      setToggling(false)
    }
  }

  const runSync = async () => {
    if (!row) return
    setSyncing(true)
    try {
      const r = await api.post<{ label: string; fetched: number; created: number; updated: number; skipped: number }>(`/api/integrations/${row.id}/sync`)
      toast({
        title: `${r.label}: ${r.fetched} contacts fetched`,
        description: `${r.created} created · ${r.updated} updated${r.skipped ? ` · ${r.skipped} skipped (no email/phone)` : ''}`,
      })
      await onChanged()
    } catch (err) {
      toast({ title: 'Customer sync failed', description: friendlyApiErrorLocal(err, 'Sync failed'), variant: 'destructive' })
    } finally {
      setSyncing(false)
    }
  }

  const switchLocked = Boolean(row && !row.configured && meta.needsCredentials)

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <CardTitle className="text-base flex items-center gap-2">
              <Icon className="h-4 w-4 shrink-0" aria-hidden /> {meta.title}
            </CardTitle>
            <CardDescription className="mt-1">{meta.blurb}</CardDescription>
          </div>
          {row && (
            <label className="flex flex-col items-center gap-1 shrink-0 min-h-[44px]" title={switchLocked ? 'Add credentials before enabling' : undefined}>
              <Switch
                checked={row.enabled}
                disabled={!canManage || toggling || switchLocked}
                onCheckedChange={(v) => void toggleEnabled(v)}
                aria-label={`${row.enabled ? 'Disable' : 'Enable'} ${meta.title}`}
              />
              <span className="text-[10px] text-muted-foreground">{row.enabled ? 'Enabled' : 'Disabled'}</span>
            </label>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 flex-1">
        {row ? (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge className={cn('text-[10px]', row.enabled ? 'bg-emerald-100 text-emerald-900' : 'bg-muted text-muted-foreground border')}>
                {row.enabled ? 'Enabled' : 'Disabled'}
              </Badge>
              {row.configured ? (
                <Badge variant="outline" className="text-[10px] gap-1"><KeyRound className="h-3 w-3" aria-hidden /> Credentials saved</Badge>
              ) : meta.needsCredentials ? (
                <Badge className="bg-amber-100 text-amber-900 text-[10px]">No credentials yet</Badge>
              ) : (
                <Badge variant="outline" className="text-[10px]">Optional credentials</Badge>
              )}
            </div>

            {kind === 'smtp' && (
              <p className="text-xs text-muted-foreground break-all">
                {str(row.config.host) ? `${str(row.config.host)}${row.config.port ? `:${str(row.config.port)}` : ''} · from ${str(row.config.from) || '—'}` : 'No server configured yet.'}
              </p>
            )}
            {kind === 'email_api' && (
              <p className="text-xs text-muted-foreground break-all">
                {str(row.config.provider) || 'no provider selected'} · from {str(row.config.from) || 'not set'}
              </p>
            )}
            {kind === 'square' && (
              <p className="text-xs text-muted-foreground break-all">
                {str(row.config.environment) || 'production'} · location {str(row.config.locationId) || 'not set'}
              </p>
            )}
            {(kind === 'quickbooks' || kind === 'xero' || kind === 'myob') && (
              <p className="text-xs text-muted-foreground break-all">
                {kind === 'quickbooks'
                  ? `Realm ${str(row.config.realmId) || 'not set'}`
                  : kind === 'xero'
                    ? `Tenant ${str(row.config.tenantId) || 'not set'}`
                    : `Company file ${str(row.config.companyFileId) || 'not set'}`}
                {str(row.config.salesAccountCode) ? ` · sales account ${str(row.config.salesAccountCode)}` : ''}
              </p>
            )}
            {kind === 'shopify' && <p className="text-xs text-muted-foreground break-all">{str(row.config.shopDomain) || 'No shop domain configured yet.'}</p>}
            {kind === 'woocommerce' && <p className="text-xs text-muted-foreground break-all">{str(row.config.storeUrl) || 'No store URL configured yet.'}</p>}
            {kind === 'wix' && <p className="text-xs text-muted-foreground break-all">Site {str(row.config.siteId) || 'not set'}</p>}
            {kind === 'mailchimp' && <p className="text-xs text-muted-foreground break-all">{str(row.config.serverPrefix) || 'no server prefix'} · list {str(row.config.listId) || 'not set'}</p>}
            {(kind === 'twilio_sms' || kind === 'twilio_whatsapp') && (
              <p className="text-xs text-muted-foreground break-all">Sender: {str(row.config.from) || 'not set'}</p>
            )}

            {kind === 'twilio_whatsapp' && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium">Webhook URL for the Twilio console:</p>
                <WebhookUrlRow url={`${origin}/api/telephony/whatsapp/incoming`} label="A message comes in" />
              </div>
            )}

            {kind === 'sms_gateway' && (
              <p className="text-xs text-muted-foreground break-all">
                {str(row.config.provider) || 'no provider selected'}
                {str(row.config.baseUrl) ? ` · ${str(row.config.baseUrl)}` : ''}
                {str(row.config.from) ? ` · from ${str(row.config.from)}` : ''}
                {kind === 'sms_gateway' && str(row.config.url) ? ` · ${str(row.config.url)}` : ''}
              </p>
            )}

            {kind === 'twilio_voice' && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground break-all">
                  Voice number: <span className="font-medium text-foreground">{str(row.config.from) || 'not set'}</span>
                  {str(row.config.transferNumber) && <> · transfers to {str(row.config.transferNumber)}</>}
                </p>
                <div className="space-y-1.5">
                  <p className="text-xs font-medium">Webhook URLs for the Twilio console:</p>
                  <WebhookUrlRow url={`${origin}/api/telephony/voice/incoming`} label="A call comes in" />
                  <WebhookUrlRow url={`${origin}/api/telephony/voice/status`} label="Call status changes" />
                  <WebhookUrlRow url={`${origin}/api/telephony/sms/incoming`} label="A message comes in" />
                </div>
              </div>
            )}

            {kind === 'caldav' && (
              <p className="text-xs text-muted-foreground break-all">
                {str(row.config.url) ? <>Calendar: {str(row.config.url)}{str(row.config.username) ? <> · user {str(row.config.username)}</> : null}</> : 'No calendar URL configured yet.'}
              </p>
            )}

            {kind === 'caldav' && row && <CalDavSyncBox canManage={canManage} onChanged={onChanged} />}
            {kind === 'google_calendar' && (
              <p className="text-xs text-muted-foreground break-all">
                Calendar: {str(row.config.calendarId) || 'primary'}
              </p>
            )}

            {kind === 'google_calendar' && row && <GoogleCalendarBox connected={row.connected === true} canManage={canManage} onChanged={onChanged} />}

            {kind === 'microsoft_calendar' && (
              <p className="text-xs text-muted-foreground break-all">
                Tenant: {str(row.config.tenant) || 'common'}{str(row.config.calendarEmail) ? <> · mailbox {str(row.config.calendarEmail)}</> : null}
              </p>
            )}

            {kind === 'microsoft_calendar' && row && <MicrosoftCalendarBox connected={row.connected === true} canManage={canManage} onChanged={onChanged} />}


            {testResult ? (
              <Alert role="status" className={testResult.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'}>
                {testResult.ok ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <XCircle className="h-4 w-4" aria-hidden />}
                <AlertDescription>{testResult.ok ? 'Test passed. ' : 'Test failed. '}{testResult.detail}</AlertDescription>
              </Alert>
            ) : row.lastTestAt && !row.lastTestOk && row.lastTestError ? (
              <Alert role="alert" className="border-rose-200 bg-rose-50 text-rose-900">
                <XCircle className="h-4 w-4" aria-hidden />
                <AlertDescription>
                  Last test failed ({formatDateTime(row.lastTestAt)}) — {row.lastTestError}
                </AlertDescription>
              </Alert>
            ) : row.lastTestAt ? (
              <p className="text-xs text-emerald-700 flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                Last test passed · {formatDateTime(row.lastTestAt)}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">Not tested yet — the test makes a real connection and may take a few seconds.</p>
            )}
          </>
        ) : (
          <div className="rounded-md border border-dashed p-4 text-center space-y-2">
            <p className="text-sm font-medium">Not configured</p>
            <p className="text-xs text-muted-foreground">Nothing is saved for this connector yet.</p>
          </div>
        )}

        <div className="flex flex-wrap gap-2 mt-auto pt-1">
          <Button variant="outline" className="min-h-[44px]" onClick={openDialog} aria-label={`Configure ${meta.title}`}>
            <Plug className="h-4 w-4" aria-hidden /> Configure
          </Button>
          {row && (
            <Button
              variant="outline" className="min-h-[44px]"
              onClick={() => void runTest()}
              disabled={testing || !canManage}
              title={canManage ? 'Real network test — may take a few seconds' : 'Owner or admin only'}
              aria-label={`Test ${meta.title} connection`}
            >
              {testing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
              Test connection
            </Button>
          )}
          {row && canSync && (
            <Button
              variant="outline" className="min-h-[44px]"
              onClick={() => void runSync()}
              disabled={syncing || !canManage || !row.enabled || !row.configured}
              title={!row.enabled || !row.configured ? 'Enable the integration and save credentials first' : 'Pull contacts from the provider'}
              aria-label={`Sync customers from ${meta.title}`}
            >
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Users className="h-4 w-4" aria-hidden />}
              Sync customers
            </Button>
          )}
        </div>
        {!canManage && <p className="text-xs text-muted-foreground">Read-only — owner/admin can edit.</p>}
      </CardContent>

      <ConfigureDialog
        kind={kind}
        existing={row}
        initialConfig={initialCfg}
        open={dlgOpen}
        onOpenChange={setDlgOpen}
        canManage={canManage}
        onSaved={onChanged}
      />
    </Card>
  )
}

/* ------------------------------ configure dialog ------------------------------ */

function ConfigureDialog({
  kind, existing, initialConfig, open, onOpenChange, canManage, onSaved,
}: {
  kind: string
  existing: IntegrationInfo | null
  initialConfig: ConfigDraft
  open: boolean
  onOpenChange: (o: boolean) => void
  canManage: boolean
  onSaved: () => Promise<void> | void
}) {
  const { toast } = useToast()
  const origin = useOrigin()
  const meta = KIND_META[kind]
  const [cfg, setCfg] = useState<ConfigDraft>(EMPTY_CONFIG)
  const [sec, setSec] = useState<SecretsDraft>(EMPTY_SECRETS)
  const [saving, setSaving] = useState(false)
  const [savingTest, setSavingTest] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState('')
  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(null)

  // Reset only when the dialog is (re)opened — `initialConfig` identity changes exactly then.
  useEffect(() => {
    if (!open) return
    setCfg(initialConfig)
    setSec(EMPTY_SECRETS)
    setError('')
    setTestResult(null)
  }, [open, initialConfig])

  const save = async (alsoTest: boolean): Promise<boolean> => {
    setSaving(true)
    setSavingTest(alsoTest)
    setError('')
    try {
      const secrets = collectSecrets(kind, sec)
      let rowId = existing?.id ?? ''
      if (existing) {
        const body: Record<string, unknown> = { config: buildConfig(kind, cfg) }
        if (secrets) body.secrets = secrets
        const d = await api.patch<{ integration: IntegrationInfo }>(`/api/integrations/${existing.id}`, body)
        rowId = d.integration.id
      } else {
        const body: Record<string, unknown> = { kind, config: buildConfig(kind, cfg) }
        if (secrets) body.secrets = secrets
        const d = await api.post<{ integration: IntegrationInfo }>('/api/integrations', body)
        rowId = d.integration.id
      }
      await onSaved()

      if (alsoTest) {
        // Real network test — may take up to ~10s; keep the dialog open to show it.
        const r = await api.post<IntegrationTestResult>(`/api/integrations/${rowId}/test`)
        setTestResult(r)
        await onSaved()
        toast({ title: r.ok ? `${meta.title} saved — test passed` : `${meta.title} saved — test failed`, description: r.detail, variant: r.ok ? 'default' : 'destructive' })
        return false
      }
      toast({ title: `${meta.title} saved` })
      return true
    } catch (err) {
      setError(friendlyApiErrorLocal(err, 'Save failed'))
      return false
    } finally {
      setSaving(false)
      setSavingTest(false)
    }
  }

  const clearCredentials = async () => {
    if (!existing) return
    setClearing(true)
    setError('')
    try {
      await api.patch(`/api/integrations/${existing.id}`, { secrets: null })
      await onSaved()
      setSec(EMPTY_SECRETS)
      toast({ title: 'Credentials cleared', description: 'The stored credential set was deleted and the integration was disabled.' })
    } catch (err) {
      setError(friendlyApiErrorLocal(err, 'Could not clear credentials'))
    } finally {
      setClearing(false)
    }
  }

  const idBase = `int-${kind}`
  const busy = saving || savingTest || clearing

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{existing ? `Configure ${meta.title}` : `Set up ${meta.title}`}</DialogTitle>
          <DialogDescription>
            {existing ? 'Changes apply to future sends immediately. Saved credentials are never shown again.' : meta.blurb}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (busy) return
            void save(false).then((ok) => { if (ok) onOpenChange(false) })
          }}
        >
          {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}

          {kind === 'email_api' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-emailprovider`}>Provider</Label>
                <select
                  id={`${idBase}-emailprovider`}
                  value={cfg.provider}
                  onChange={(e) => setCfg((s) => ({ ...s, provider: e.target.value }))}
                  className="min-h-[44px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  disabled={busy || !canManage}
                >
                  <option value="sendgrid">SendGrid</option>
                  <option value="mailgun">Mailgun</option>
                  <option value="postmark">Postmark</option>
                  <option value="resend">Resend</option>
                  <option value="brevo">Brevo</option>
                </select>
                <p className="text-xs text-muted-foreground">The API key goes in Credentials below. A 2xx response means the provider accepted the email — delivery receipts depend on the provider.</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-emailfrom`}>From address</Label>
                  <Input id={`${idBase}-emailfrom`} type="email" value={cfg.from} onChange={(e) => setCfg((s) => ({ ...s, from: e.target.value }))} placeholder="invoices@yourdomain.com" className="min-h-[44px]" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-fromname`}>From name (optional)</Label>
                  <Input id={`${idBase}-fromname`} value={cfg.fromName} onChange={(e) => setCfg((s) => ({ ...s, fromName: e.target.value }))} placeholder="Your Business" className="min-h-[44px]" />
                </div>
              </div>
              {cfg.provider === 'mailgun' && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={`${idBase}-domain`}>Sending domain</Label>
                    <Input id={`${idBase}-domain`} value={cfg.domain} onChange={(e) => setCfg((s) => ({ ...s, domain: e.target.value }))} placeholder="mg.yourdomain.com" className="min-h-[44px]" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`${idBase}-region`}>Region</Label>
                    <select id={`${idBase}-region`} value={cfg.region} onChange={(e) => setCfg((s) => ({ ...s, region: e.target.value }))} className="min-h-[44px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                      <option value="us">US (api.mailgun.net)</option>
                      <option value="eu">EU (api.eu.mailgun.net)</option>
                    </select>
                  </div>
                </div>
              )}
              {cfg.provider === 'postmark' && (
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-stream`}>Message stream (optional)</Label>
                  <Input id={`${idBase}-stream`} value={cfg.messageStream} onChange={(e) => setCfg((s) => ({ ...s, messageStream: e.target.value }))} placeholder="outbound" className="min-h-[44px]" />
                </div>
              )}
            </div>
          )}

          {kind === 'smtp' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-host`}>SMTP host</Label>
                <Input id={`${idBase}-host`} value={cfg.host} onChange={(e) => setCfg((s) => ({ ...s, host: e.target.value }))} placeholder="smtp.example.com" autoComplete="off" className="min-h-[44px]" />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-port`}>Port</Label>
                  <Input id={`${idBase}-port`} type="number" min={1} max={65535} value={cfg.port} onChange={(e) => setCfg((s) => ({ ...s, port: e.target.value }))} placeholder="587" className="min-h-[44px]" />
                </div>
                <label className="flex items-center gap-3 text-sm rounded-md border p-3 min-h-[44px]">
                  <Switch checked={cfg.secure} onCheckedChange={(v) => setCfg((s) => ({ ...s, secure: v }))} aria-label="Use implicit TLS (port 465)" />
                  Use implicit TLS (port 465)
                </label>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-from`}>From address</Label>
                <Input id={`${idBase}-from`} type="email" value={cfg.from} onChange={(e) => setCfg((s) => ({ ...s, from: e.target.value }))} placeholder="invoices@yourdomain.com" className="min-h-[44px]" />
              </div>
            </div>
          )}

          {(kind === 'twilio_sms' || kind === 'twilio_whatsapp') && (
            <div className="space-y-1.5">
              <Label htmlFor={`${idBase}-from`}>From {kind === 'twilio_whatsapp' ? '(whatsapp:+E.164)' : '(+E.164)'}</Label>
              <Input
                id={`${idBase}-from`} value={cfg.from}
                onChange={(e) => setCfg((s) => ({ ...s, from: e.target.value }))}
                placeholder={kind === 'twilio_whatsapp' ? 'whatsapp:+15551234567' : '+15551234567'}
                autoComplete="off" className="min-h-[44px]"
              />
            </div>
          )}

          {kind === 'twilio_voice' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-from`}>Voice number (+E.164)</Label>
                <Input id={`${idBase}-from`} value={cfg.from} onChange={(e) => setCfg((s) => ({ ...s, from: e.target.value }))} placeholder="+15551234567" autoComplete="off" className="min-h-[44px]" />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-lang`}>Speech language (optional)</Label>
                  <Input id={`${idBase}-lang`} value={cfg.language} onChange={(e) => setCfg((s) => ({ ...s, language: e.target.value }))} placeholder="en-US" autoComplete="off" className="min-h-[44px]" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-voice`}>Twilio voice (optional)</Label>
                  <Input id={`${idBase}-voice`} value={cfg.voiceName} onChange={(e) => setCfg((s) => ({ ...s, voiceName: e.target.value }))} placeholder="alice" autoComplete="off" className="min-h-[44px]" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-transfer`}>Transfer number for escalations (optional)</Label>
                <Input id={`${idBase}-transfer`} value={cfg.transferNumber} onChange={(e) => setCfg((s) => ({ ...s, transferNumber: e.target.value }))} placeholder="+15559876543" autoComplete="off" className="min-h-[44px]" />
                <p className="text-xs text-muted-foreground">When the AI escalates, Twilio dials this number; without it the caller gets a message-taken promise.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-pub`}>Public base URL (optional)</Label>
                <Input id={`${idBase}-pub`} type="url" value={cfg.publicBaseUrl} onChange={(e) => setCfg((s) => ({ ...s, publicBaseUrl: e.target.value }))} placeholder="https://appointments.example.com" autoComplete="off" className="min-h-[44px]" />
                <p className="text-xs text-muted-foreground">The https origin you configured in the Twilio console — used to validate webhook signatures behind proxies.</p>
              </div>
              <div className="rounded-md border p-3 space-y-2">
                <p className="text-sm font-medium">Webhook URLs for the Twilio console</p>
                <WebhookUrlRow url={`${origin}/api/telephony/voice/incoming`} label="A call comes in" />
                <WebhookUrlRow url={`${origin}/api/telephony/voice/status`} label="Call status changes" />
                <WebhookUrlRow url={`${origin}/api/telephony/sms/incoming`} label="A message comes in" />
              </div>
            </div>
          )}

          {kind === 'caldav' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-url`}>Calendar collection URL</Label>
                <Input id={`${idBase}-url`} type="url" value={cfg.url} onChange={(e) => setCfg((s) => ({ ...s, url: e.target.value }))} placeholder="https://cloud.example.com/remote.php/dav/calendars/user/personal/" autoComplete="off" className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-usercal`}>Username (optional)</Label>
                <Input id={`${idBase}-usercal`} value={cfg.username} onChange={(e) => setCfg((s) => ({ ...s, username: e.target.value }))} autoComplete="off" className="min-h-[44px]" />
              </div>
            </div>
          )}

          {kind === 'google_calendar' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-calid`}>Calendar ID</Label>
                <Input id={`${idBase}-calid`} value={cfg.calendarId} onChange={(e) => setCfg((s) => ({ ...s, calendarId: e.target.value }))} placeholder="primary" autoComplete="off" className="min-h-[44px]" />
                <p className="text-xs text-muted-foreground">&quot;primary&quot; is your main Google Calendar. You can also use a shared calendar address.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-redirect`}>OAuth redirect URI (optional)</Label>
                <Input id={`${idBase}-redirect`} type="url" value={cfg.redirectUri} onChange={(e) => setCfg((s) => ({ ...s, redirectUri: e.target.value }))} placeholder={`${origin}/api/integrations/google_calendar/callback`} autoComplete="off" className="min-h-[44px]" />
                <p className="text-xs text-muted-foreground">Set this in the Google Cloud console as an authorized redirect URI. Leave empty to use this app&apos;s URL.</p>
              </div>
            </div>
          )}

          {kind === 'microsoft_calendar' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-tenant`}>Tenant (optional)</Label>
                <Input id={`${idBase}-tenant`} value={cfg.tenant} onChange={(e) => setCfg((s) => ({ ...s, tenant: e.target.value }))} placeholder="common" autoComplete="off" className="min-h-[44px]" />
                <p className="text-xs text-muted-foreground">&quot;common&quot; works for most Microsoft 365 tenants; a tenant ID (GUID) locks the app to one directory.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-mailbox`}>Calendar mailbox (optional)</Label>
                <Input id={`${idBase}-mailbox`} type="email" value={cfg.calendarEmail} onChange={(e) => setCfg((s) => ({ ...s, calendarEmail: e.target.value }))} placeholder="bookings@example.com" autoComplete="off" className="min-h-[44px]" />
                <p className="text-xs text-muted-foreground">Used for the free/busy query. Leave empty to use the connected account&apos;s own mailbox.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-msredirect`}>OAuth redirect URI (optional)</Label>
                <Input id={`${idBase}-msredirect`} type="url" value={cfg.redirectUri} onChange={(e) => setCfg((s) => ({ ...s, redirectUri: e.target.value }))} placeholder={`${origin}/api/integrations/microsoft_calendar/callback`} autoComplete="off" className="min-h-[44px]" />
                <p className="text-xs text-muted-foreground">Add this URI as a &quot;Web&quot; redirect URI in the Entra ID app registration.</p>
              </div>
            </div>
          )}

          {kind === 'webhook_out' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-url`}>Destination URL</Label>
                <Input id={`${idBase}-url`} type="url" value={cfg.url} onChange={(e) => setCfg((s) => ({ ...s, url: e.target.value }))} placeholder="https://hooks.zapier.com/hooks/catch/…" autoComplete="off" className="min-h-[44px]" />
              </div>
              <div className="flex items-center justify-between gap-3 rounded-md border p-3">
                <div>
                  <Label htmlFor={`${idBase}-private`}>Allow private/local destination</Label>
                  <p className="text-xs text-muted-foreground">Off blocks loopback/LAN URLs (SSRF protection). Enable only for a trusted self-hosted receiver.</p>
                </div>
                <Switch id={`${idBase}-private`} checked={cfg.allowPrivate} onCheckedChange={(v) => setCfg((s) => ({ ...s, allowPrivate: v }))} aria-label="Allow private webhook destination" />
              </div>
            </div>
          )}

          {kind === 'stripe' && (
            <div className="rounded-md border p-3 space-y-2">
              <p className="text-sm font-medium">Stripe webhook endpoint</p>
              <p className="text-xs text-muted-foreground">
                Point Stripe&apos;s webhook endpoint at this URL; payments are then verified against the signing secret (whsec_…) below.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-xs bg-muted rounded px-2 py-1.5 break-all flex-1 min-w-0">{origin ? `${origin}/api/stripe/webhook` : '/api/stripe/webhook'}</code>
                <CopyButton value={origin ? `${origin}/api/stripe/webhook` : ''} label="Copy Stripe webhook URL" />
              </div>
            </div>
          )}

          {kind === 'square' && (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-location`}>Location ID</Label>
                  <Input id={`${idBase}-location`} value={cfg.locationId} onChange={(e) => setCfg((s) => ({ ...s, locationId: e.target.value }))} placeholder="L…" autoComplete="off" className="min-h-[44px]" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-sqenv`}>Environment</Label>
                  <select id={`${idBase}-sqenv`} value={cfg.environment} onChange={(e) => setCfg((s) => ({ ...s, environment: e.target.value }))} className="min-h-[44px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                    <option value="production">Production</option>
                    <option value="sandbox">Sandbox</option>
                  </select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-sqnotify`}>Webhook notification URL (optional)</Label>
                <Input id={`${idBase}-sqnotify`} type="url" value={cfg.notificationUrl} onChange={(e) => setCfg((s) => ({ ...s, notificationUrl: e.target.value }))} placeholder={`${origin}/api/square/webhook`} autoComplete="off" className="min-h-[44px]" />
                <p className="text-xs text-muted-foreground">Must match the URL configured in Square exactly (used for signature verification).</p>
              </div>
              <div className="rounded-md border p-3 space-y-2">
                <p className="text-sm font-medium">Square webhook endpoint</p>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-xs bg-muted rounded px-2 py-1.5 break-all flex-1 min-w-0">{origin ? `${origin}/api/square/webhook` : '/api/square/webhook'}</code>
                  <CopyButton value={origin ? `${origin}/api/square/webhook` : ''} label="Copy Square webhook URL" />
                </div>
              </div>
            </div>
          )}

          {(kind === 'quickbooks' || kind === 'xero' || kind === 'myob') && (
            <div className="space-y-3">
              {kind === 'quickbooks' && (
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-realm`}>Company realm ID</Label>
                  <Input id={`${idBase}-realm`} value={cfg.realmId} onChange={(e) => setCfg((s) => ({ ...s, realmId: e.target.value }))} placeholder="123456789012345" autoComplete="off" className="min-h-[44px]" />
                </div>
              )}
              {kind === 'xero' && (
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-tenant`}>Tenant ID</Label>
                  <Input id={`${idBase}-tenant`} value={cfg.tenantId} onChange={(e) => setCfg((s) => ({ ...s, tenantId: e.target.value }))} placeholder="Xero tenant GUID" autoComplete="off" className="min-h-[44px]" />
                </div>
              )}
              {kind === 'myob' && (
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-companyfile`}>Company file ID</Label>
                  <Input id={`${idBase}-companyfile`} value={cfg.companyFileId} onChange={(e) => setCfg((s) => ({ ...s, companyFileId: e.target.value }))} placeholder="MYOB company file GUID" autoComplete="off" className="min-h-[44px]" />
                </div>
              )}
              {kind !== 'quickbooks' && (
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-accountcode`}>Sales account code</Label>
                  <Input id={`${idBase}-accountcode`} value={cfg.salesAccountCode} onChange={(e) => setCfg((s) => ({ ...s, salesAccountCode: e.target.value }))} placeholder="e.g. 200" autoComplete="off" className="min-h-[44px]" />
                  <p className="text-xs text-muted-foreground">Required by {kind === 'xero' ? 'Xero' : 'MYOB'} for invoice line items.</p>
                </div>
              )}
              <p className="text-xs text-muted-foreground">Uses a refresh-token OAuth2 connection. Access tokens are refreshed automatically and stored encrypted.</p>
            </div>
          )}

          {kind === 'shopify' && (
            <div className="space-y-1.5">
              <Label htmlFor={`${idBase}-shopdomain`}>Shop domain</Label>
              <Input id={`${idBase}-shopdomain`} value={cfg.shopDomain} onChange={(e) => setCfg((s) => ({ ...s, shopDomain: e.target.value }))} placeholder="my-store.myshopify.com" autoComplete="off" className="min-h-[44px]" />
            </div>
          )}

          {kind === 'woocommerce' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-storeurl`}>Store URL</Label>
                <Input id={`${idBase}-storeurl`} type="url" value={cfg.storeUrl} onChange={(e) => setCfg((s) => ({ ...s, storeUrl: e.target.value }))} placeholder="https://shop.example.com" autoComplete="off" className="min-h-[44px]" />
              </div>
              <div className="flex items-center justify-between gap-3 rounded-md border p-3">
                <div>
                  <Label htmlFor={`${idBase}-wooprivate`}>Allow private/local store</Label>
                  <p className="text-xs text-muted-foreground">Off blocks loopback/LAN URLs (SSRF protection). Enable only for a trusted self-hosted store.</p>
                </div>
                <Switch id={`${idBase}-wooprivate`} checked={cfg.allowPrivate} onCheckedChange={(v) => setCfg((s) => ({ ...s, allowPrivate: v }))} aria-label="Allow private WooCommerce store" />
              </div>
            </div>
          )}

          {kind === 'wix' && (
            <div className="space-y-1.5">
              <Label htmlFor={`${idBase}-siteid`}>Wix site ID</Label>
              <Input id={`${idBase}-siteid`} value={cfg.siteId} onChange={(e) => setCfg((s) => ({ ...s, siteId: e.target.value }))} placeholder="Wix site GUID" autoComplete="off" className="min-h-[44px]" />
            </div>
          )}

          {kind === 'mailchimp' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-dc`}>Server prefix</Label>
                <Input id={`${idBase}-dc`} value={cfg.serverPrefix} onChange={(e) => setCfg((s) => ({ ...s, serverPrefix: e.target.value }))} placeholder="us21" autoComplete="off" className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-listid`}>Audience (list) ID</Label>
                <Input id={`${idBase}-listid`} value={cfg.listId} onChange={(e) => setCfg((s) => ({ ...s, listId: e.target.value }))} placeholder="abc123def" autoComplete="off" className="min-h-[44px]" />
              </div>
            </div>
          )}

          {kind === 'sms_gateway' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-provider`}>Gateway provider</Label>
                <select
                  id={`${idBase}-provider`}
                  value={cfg.provider}
                  onChange={(e) => setCfg((s) => ({ ...s, provider: e.target.value }))}
                  className="min-h-[44px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  disabled={busy || !canManage}
                >
                  <option value="textbee">TextBee (Android, Apache-2.0)</option>
                  <option value="httpsms">httpSMS (Android, MIT)</option>
                  <option value="android_sms_gateway">Android SMS Gateway Server (Apache-2.0, self-hosted or cloud)</option>
                  <option value="telnyx">Telnyx (global carrier API)</option>
                  <option value="vonage">Vonage / Nexmo</option>
                  <option value="messagebird">MessageBird (Bird)</option>
                  <option value="plivo">Plivo</option>
                  <option value="generic_http">Custom HTTP gateway / bridge (incl. iOS, Gammu, Kannel, SMPP shims)</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  TextBee/httpSMS use your Android phone; Android SMS Gateway also lets you self-host the server. Telnyx, Vonage, MessageBird and Plivo are carrier APIs with their own credentials below. Custom HTTP covers anything with a documented REST endpoint.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-base`}>Base URL (optional override)</Label>
                <Input id={`${idBase}-base`} value={cfg.baseUrl} onChange={(e) => setCfg((s) => ({ ...s, baseUrl: e.target.value }))} placeholder="https://api.textbee.dev/api/v1" autoComplete="off" className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-from`}>Sender identity (optional, required for httpSMS)</Label>
                <Input id={`${idBase}-from`} value={cfg.from} onChange={(e) => setCfg((s) => ({ ...s, from: e.target.value }))} placeholder="+15551234567 (E.164)" autoComplete="off" className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-device`}>Device ID (optional, TextBee multi-device)</Label>
                <Input id={`${idBase}-device`} value={cfg.deviceId} onChange={(e) => setCfg((s) => ({ ...s, deviceId: e.target.value }))} placeholder="leave empty for default device" autoComplete="off" className="min-h-[44px]" />
              </div>
              {cfg.provider === 'generic_http' && (
                <div className="space-y-3 rounded-md border p-3">
                  <div className="space-y-1.5">
                    <Label htmlFor={`${idBase}-url`}>Destination URL</Label>
                    <Input id={`${idBase}-url`} type="url" value={cfg.url} onChange={(e) => setCfg((s) => ({ ...s, url: e.target.value }))} placeholder="https://your-bridge.example.com/send" autoComplete="off" className="min-h-[44px]" />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor={`${idBase}-method`}>HTTP method</Label>
                      <select id={`${idBase}-method`} value={cfg.method} onChange={(e) => setCfg((s) => ({ ...s, method: e.target.value }))} className="min-h-[44px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                        <option value="POST">POST</option>
                        <option value="PUT">PUT</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`${idBase}-authheader`}>Custom auth header (optional)</Label>
                      <Input id={`${idBase}-authheader`} value={cfg.authHeaderName} onChange={(e) => setCfg((s) => ({ ...s, authHeaderName: e.target.value }))} placeholder="X-Api-Key" className="min-h-[44px]" />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`${idBase}-template`}>Body template (optional)</Label>
                    <textarea
                      id={`${idBase}-template`}
                      value={cfg.bodyTemplate}
                      onChange={(e) => setCfg((s) => ({ ...s, bodyTemplate: e.target.value }))}
                      placeholder='{"to":"{{to}}","message":"{{message}}"}'
                      className="min-h-[88px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                    />
                    <p className="text-xs text-muted-foreground">Use placeholders {"{{to}}"}, {"{{message}}"}, {"{{from}}"}; credentials go in the auth header value or body via your gateway's contract.</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`${idBase}-testrecipient`}>Test recipient (optional)</Label>
                    <Input id={`${idBase}-testrecipient`} value={cfg.testRecipient} onChange={(e) => setCfg((s) => ({ ...s, testRecipient: e.target.value }))} placeholder="+15551234567" className="min-h-[44px]" />
                    <p className="text-xs text-muted-foreground">Setting it enables a live connection test (this sends a real SMS).</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* credentials */}
          <div className="space-y-3 rounded-md border p-3">
            <p className="text-sm font-medium flex items-center gap-1.5"><KeyRound className="h-4 w-4" aria-hidden /> Credentials</p>

            {kind === 'smtp' && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-user`}>Username (optional)</Label>
                  <Input id={`${idBase}-user`} value={sec.user} onChange={(e) => setSec((s) => ({ ...s, user: e.target.value }))} autoComplete="off" className="min-h-[44px]" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-pass`}>Password (optional)</Label>
                  <Input id={`${idBase}-pass`} type="password" value={sec.pass} onChange={(e) => setSec((s) => ({ ...s, pass: e.target.value }))} autoComplete="new-password" className="min-h-[44px]" />
                </div>
                <p className="text-xs text-muted-foreground">Leave empty for anonymous relays.</p>
              </>
            )}

            {kind === 'email_api' && (
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-emailkey`}>API key</Label>
                <Input id={`${idBase}-emailkey`} type="password" value={sec.apiKey} onChange={(e) => setSec((s) => ({ ...s, apiKey: e.target.value }))} placeholder={cfg.provider === 'sendgrid' ? 'SG.…' : cfg.provider === 'resend' ? 're_…' : 'provider API key'} autoComplete="new-password" className="min-h-[44px]" />
                <p className="text-xs text-muted-foreground">Stored encrypted and never returned. The read-only connection test verifies it with the provider.</p>
              </div>
            )}

            {kind === 'sms_gateway' && (
              <>
                {(cfg.provider === 'textbee' || cfg.provider === 'httpsms' || cfg.provider === 'telnyx' || cfg.provider === 'messagebird') && (
                  <div className="space-y-1.5">
                    <Label htmlFor={`${idBase}-gwkey`}>API key</Label>
                    <Input id={`${idBase}-gwkey`} type="password" value={sec.apiKey} onChange={(e) => setSec((s) => ({ ...s, apiKey: e.target.value }))} autoComplete="new-password" className="min-h-[44px]" />
                  </div>
                )}
                {cfg.provider === 'vonage' && (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor={`${idBase}-vkey`}>API key</Label>
                      <Input id={`${idBase}-vkey`} value={sec.apiKey} onChange={(e) => setSec((s) => ({ ...s, apiKey: e.target.value }))} autoComplete="off" className="min-h-[44px]" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`${idBase}-vsecret`}>API secret</Label>
                      <Input id={`${idBase}-vsecret`} type="password" value={sec.apiSecret} onChange={(e) => setSec((s) => ({ ...s, apiSecret: e.target.value }))} autoComplete="new-password" className="min-h-[44px]" />
                    </div>
                  </>
                )}
                {cfg.provider === 'plivo' && (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor={`${idBase}-plivoid`}>Auth ID</Label>
                      <Input id={`${idBase}-plivoid`} value={sec.accountId} onChange={(e) => setSec((s) => ({ ...s, accountId: e.target.value }))} placeholder="MA…" autoComplete="off" className="min-h-[44px]" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`${idBase}-plivotoken`}>Auth token</Label>
                      <Input id={`${idBase}-plivotoken`} type="password" value={sec.apiSecret} onChange={(e) => setSec((s) => ({ ...s, apiSecret: e.target.value }))} autoComplete="new-password" className="min-h-[44px]" />
                    </div>
                  </>
                )}
                {cfg.provider === 'android_sms_gateway' && (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor={`${idBase}-gwuser`}>Username (optional, basic auth)</Label>
                      <Input id={`${idBase}-gwuser`} value={sec.username} onChange={(e) => setSec((s) => ({ ...s, username: e.target.value }))} autoComplete="off" className="min-h-[44px]" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`${idBase}-gwpass`}>Password (optional, basic auth)</Label>
                      <Input id={`${idBase}-gwpass`} type="password" value={sec.passwordGw} onChange={(e) => setSec((s) => ({ ...s, passwordGw: e.target.value }))} autoComplete="new-password" className="min-h-[44px]" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`${idBase}-gwtoken`}>Bearer token (optional)</Label>
                      <Input id={`${idBase}-gwtoken`} type="password" value={sec.token} onChange={(e) => setSec((s) => ({ ...s, token: e.target.value }))} autoComplete="new-password" className="min-h-[44px]" />
                    </div>
                    <p className="text-xs text-muted-foreground">A local server may run without credentials — the connection test reports the truth.</p>
                  </>
                )}
                {cfg.provider === 'generic_http' && (
                  <div className="space-y-1.5">
                    <Label htmlFor={`${idBase}-gwauth`}>Auth header value (optional)</Label>
                    <Input id={`${idBase}-gwauth`} type="password" value={sec.authValue} onChange={(e) => setSec((s) => ({ ...s, authValue: e.target.value }))} autoComplete="new-password" className="min-h-[44px]" />
                    <p className="text-xs text-muted-foreground">Sent in the header named above (e.g. X-Api-Key).</p>
                  </div>
                )}
              </>
            )}

            {(kind === 'twilio_sms' || kind === 'twilio_whatsapp' || kind === 'twilio_voice') && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-sid`}>Account SID</Label>
                  <Input id={`${idBase}-sid`} value={sec.accountSid} onChange={(e) => setSec((s) => ({ ...s, accountSid: e.target.value }))} placeholder="AC…" autoComplete="off" className="min-h-[44px]" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-token`}>Auth token</Label>
                  <Input id={`${idBase}-token`} type="password" value={sec.authToken} onChange={(e) => setSec((s) => ({ ...s, authToken: e.target.value }))} autoComplete="new-password" className="min-h-[44px]" />
                </div>
              </>
            )}

            {kind === 'caldav' && (
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-calpass`}>Password / app password (optional)</Label>
                <Input id={`${idBase}-calpass`} type="password" value={sec.password} onChange={(e) => setSec((s) => ({ ...s, password: e.target.value }))} autoComplete="new-password" className="min-h-[44px]" />
                <p className="text-xs text-muted-foreground">For iCloud/Fastmail use an app-specific password. Anonymous local servers (e.g. Radicale) can leave this empty.</p>
              </div>
            )}

            {kind === 'google_calendar' && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-clientid`}>OAuth client ID</Label>
                  <Input id={`${idBase}-clientid`} value={sec.clientId} onChange={(e) => setSec((s) => ({ ...s, clientId: e.target.value }))} placeholder="1234…apps.googleusercontent.com" autoComplete="off" className="min-h-[44px]" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-clientsecret`}>OAuth client secret</Label>
                  <Input id={`${idBase}-clientsecret`} type="password" value={sec.clientSecret} onChange={(e) => setSec((s) => ({ ...s, clientSecret: e.target.value }))} autoComplete="new-password" className="min-h-[44px]" />
                  <p className="text-xs text-muted-foreground">Stored encrypted. Leave empty to keep the current secret — the authorization you already granted stays connected.</p>
                </div>
              </>
            )}

            {kind === 'stripe' && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-sk`}>Secret key</Label>
                  <Input id={`${idBase}-sk`} type="password" value={sec.secretKey} onChange={(e) => setSec((s) => ({ ...s, secretKey: e.target.value }))} placeholder="sk_test_… / sk_live_…" autoComplete="new-password" className="min-h-[44px]" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-whsec`}>Webhook signing secret (optional)</Label>
                  <Input id={`${idBase}-whsec`} type="password" value={sec.webhookSecret} onChange={(e) => setSec((s) => ({ ...s, webhookSecret: e.target.value }))} placeholder="whsec_…" autoComplete="new-password" className="min-h-[44px]" />
                  <p className="text-xs text-muted-foreground">Set it to verify Stripe callbacks against the endpoint shown above.</p>
                </div>
              </>
            )}

            {kind === 'square' && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-sqtoken`}>Access token</Label>
                  <Input id={`${idBase}-sqtoken`} type="password" value={sec.accessToken} onChange={(e) => setSec((s) => ({ ...s, accessToken: e.target.value }))} placeholder="EAAA…" autoComplete="new-password" className="min-h-[44px]" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-sqsig`}>Webhook signature key (optional)</Label>
                  <Input id={`${idBase}-sqsig`} type="password" value={sec.webhookSignatureKey} onChange={(e) => setSec((s) => ({ ...s, webhookSignatureKey: e.target.value }))} autoComplete="new-password" className="min-h-[44px]" />
                  <p className="text-xs text-muted-foreground">From the Square webhook subscription — required to verify and record callbacks.</p>
                </div>
              </>
            )}

            {(kind === 'quickbooks' || kind === 'xero' || kind === 'myob') && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-accclientid`}>OAuth client ID</Label>
                  <Input id={`${idBase}-accclientid`} value={sec.clientId} onChange={(e) => setSec((s) => ({ ...s, clientId: e.target.value }))} autoComplete="off" className="min-h-[44px]" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-accclientsecret`}>OAuth client secret</Label>
                  <Input id={`${idBase}-accclientsecret`} type="password" value={sec.clientSecret} onChange={(e) => setSec((s) => ({ ...s, clientSecret: e.target.value }))} autoComplete="new-password" className="min-h-[44px]" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-accrefresh`}>Refresh token</Label>
                  <Input id={`${idBase}-accrefresh`} type="password" value={sec.refreshToken} onChange={(e) => setSec((s) => ({ ...s, refreshToken: e.target.value }))} autoComplete="new-password" className="min-h-[44px]" />
                  <p className="text-xs text-muted-foreground">Leave empty to keep the stored refresh token. Access tokens rotate automatically on first use.</p>
                </div>
              </>
            )}

            {kind === 'shopify' && (
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-shoptoken`}>Admin API access token</Label>
                <Input id={`${idBase}-shoptoken`} type="password" value={sec.accessToken} onChange={(e) => setSec((s) => ({ ...s, accessToken: e.target.value }))} placeholder="shpat_…" autoComplete="new-password" className="min-h-[44px]" />
              </div>
            )}

            {kind === 'woocommerce' && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-woock`}>Consumer key</Label>
                  <Input id={`${idBase}-woock`} value={sec.consumerKey} onChange={(e) => setSec((s) => ({ ...s, consumerKey: e.target.value }))} placeholder="ck_…" autoComplete="off" className="min-h-[44px]" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idBase}-woocs`}>Consumer secret</Label>
                  <Input id={`${idBase}-woocs`} type="password" value={sec.consumerSecret} onChange={(e) => setSec((s) => ({ ...s, consumerSecret: e.target.value }))} placeholder="cs_…" autoComplete="new-password" className="min-h-[44px]" />
                </div>
              </>
            )}

            {(kind === 'wix' || kind === 'mailchimp') && (
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-apikey`}>{kind === 'wix' ? 'Wix API key' : 'Mailchimp API key'}</Label>
                <Input id={`${idBase}-apikey`} type="password" value={sec.apiKey} onChange={(e) => setSec((s) => ({ ...s, apiKey: e.target.value }))} placeholder={kind === 'wix' ? 'IST.…' : '…-us21'} autoComplete="new-password" className="min-h-[44px]" />
              </div>
            )}

            {kind === 'webhook_out' && (
              <div className="space-y-1.5">
                <Label htmlFor={`${idBase}-secret`}>Signing secret (optional)</Label>
                <Input id={`${idBase}-secret`} type="password" value={sec.secret} onChange={(e) => setSec((s) => ({ ...s, secret: e.target.value }))} autoComplete="new-password" className="min-h-[44px]" />
                <p className="text-xs text-muted-foreground">Every automation can also post to these URLs, signed with your secret (x-signature header).</p>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              {existing?.configured
                ? 'Credentials are saved and never shown again. Saving any credential field replaces the whole stored set — fill in every field you want kept.'
                : 'Saved credentials are never shown again. Saving any credential field replaces the whole stored set.'}
            </p>

            {existing?.configured && (
              <Button
                type="button" variant="ghost" size="sm"
                className="min-h-[44px] text-destructive hover:text-destructive"
                onClick={() => void clearCredentials()} disabled={busy || !canManage}
                aria-label={`Clear saved credentials for ${meta.title}`}
              >
                {clearing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
                Clear saved credentials
              </Button>
            )}
          </div>

          {testResult && (
            <Alert role="status" className={testResult.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'}>
              {testResult.ok ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <XCircle className="h-4 w-4" aria-hidden />}
              <AlertDescription>{testResult.ok ? 'Test passed. ' : 'Test failed. '}{testResult.detail}</AlertDescription>
            </Alert>
          )}
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button type="button" variant="outline" className="min-h-[44px]" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              type="submit"
              className="min-h-[44px]"
              disabled={!canManage || busy}
              aria-label={`Save ${meta.title}`}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Save
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-[44px]"
              disabled={!canManage || busy}
              onClick={() => void save(true)}
              aria-label={`Save and test ${meta.title}`}
            >
              {savingTest ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
              Save &amp; test
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------ webhook destinations (list card) ------------------------------ */

function WebhookDestinationsCard({
  rows, canManage, onChanged,
}: {
  rows: IntegrationInfo[]
  canManage: boolean
  onChanged: () => Promise<void> | void
}) {
  const { toast } = useToast()
  const [addOpen, setAddOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [testBusy, setTestBusy] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, IntegrationTestResult>>({})
  const [deleteTarget, setDeleteTarget] = useState<IntegrationInfo | null>(null)
  const [deleting, setDeleting] = useState(false)

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const body: Record<string, unknown> = { kind: 'webhook_out', config: { url: url.trim() } }
      if (secret) body.secrets = { secret }
      await api.post('/api/integrations', body)
      await onChanged()
      toast({ title: 'Webhook destination added', description: 'Automations can now post signed events to it.' })
      setUrl(''); setSecret(''); setAddOpen(false)
    } catch (err) {
      setError(friendlyApiErrorLocal(err, 'Could not add destination'))
    } finally {
      setSaving(false)
    }
  }

  const runTest = async (row: IntegrationInfo) => {
    setTestBusy(row.id)
    try {
      const r = await api.post<IntegrationTestResult>(`/api/integrations/${row.id}/test`)
      setTestResults((t) => ({ ...t, [row.id]: r }))
      await onChanged()
    } catch (err) {
      setTestResults((t) => ({ ...t, [row.id]: { ok: false, detail: friendlyApiErrorLocal(err, 'Test failed') } }))
    } finally {
      setTestBusy(null)
    }
  }

  const doDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api.delete(`/api/integrations/${deleteTarget.id}`)
      await onChanged()
      toast({ title: 'Webhook destination deleted' })
      setDeleteTarget(null)
    } catch (err) {
      toast({ title: 'Delete failed', description: friendlyApiErrorLocal(err, 'Unknown error'), variant: 'destructive' })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><WebhookIcon className="h-4 w-4" aria-hidden /> Webhooks (Zapier / Make / custom)</CardTitle>
        <CardDescription>Outbound destinations for automation events. Posts are signed with your secret in the x-signature header.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 flex-1">
        {rows.length === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-center space-y-2">
            <p className="text-sm font-medium">No destinations yet</p>
            <p className="text-xs text-muted-foreground">Add one to receive signed events from automations.</p>
          </div>
        ) : (
          <ul className="space-y-2 max-h-96 overflow-y-auto" aria-label="Webhook destinations">
            {rows.map((row) => {
              const t = testResults[row.id]
              return (
                <li key={row.id} className="rounded-md border p-3 space-y-2">
                  <div className="flex flex-wrap items-start gap-2">
                    <p className="text-sm break-all min-w-0 flex-1">{str(row.config.url) || '(no URL)'}</p>
                    <Badge className={cn('text-[10px]', row.enabled ? 'bg-emerald-100 text-emerald-900' : 'bg-muted text-muted-foreground border')}>
                      {row.enabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                  </div>
                  {t && (
                    <Alert role="status" className={t.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'}>
                      {t.ok ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <XCircle className="h-4 w-4" aria-hidden />}
                      <AlertDescription className="text-xs">{t.ok ? 'Delivered. ' : 'Failed. '}{t.detail}</AlertDescription>
                    </Alert>
                  )}
                  {!t && row.lastTestAt && !row.lastTestOk && row.lastTestError && (
                    <p className="text-xs text-rose-700">Last test failed — {row.lastTestError}</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm" variant="outline" className="min-h-[44px]"
                      onClick={() => void runTest(row)} disabled={testBusy === row.id || !canManage}
                      aria-label={`Test webhook ${str(row.config.url)}`}
                    >
                      {testBusy === row.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
                      Test
                    </Button>
                    <Button
                      size="sm" variant="ghost"
                      className="min-h-[44px] text-destructive hover:text-destructive"
                      onClick={() => setDeleteTarget(row)} disabled={!canManage}
                      aria-label={`Delete webhook ${str(row.config.url)}`}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden /> Delete
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        <Button className="min-h-[44px] w-full sm:w-auto" onClick={() => { setError(''); setAddOpen(true) }} disabled={!canManage} aria-label="Add webhook destination">
          <Plug className="h-4 w-4" aria-hidden /> Add destination
        </Button>
        {!canManage && <p className="text-xs text-muted-foreground">Read-only — owner/admin can edit.</p>}
        <p className="text-xs text-muted-foreground">Every automation can also post to these URLs, signed with your secret (x-signature header).</p>
      </CardContent>

      {/* add destination dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add webhook destination</DialogTitle>
            <DialogDescription>
              Automation events are POSTed as JSON to this URL, signed with your secret (x-signature header) when one is set.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={add} className="space-y-3" aria-label="Add webhook destination form">
            {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
            <div className="space-y-1.5">
              <Label htmlFor="wh-url">Destination URL</Label>
              <Input id="wh-url" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.zapier.com/hooks/catch/…" autoComplete="off" className="min-h-[44px]" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wh-secret">Signing secret (optional)</Label>
              <Input id="wh-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" className="min-h-[44px]" />
              <p className="text-xs text-muted-foreground">Saved credentials are never shown again.</p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" className="min-h-[44px]" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button type="submit" className="min-h-[44px]" disabled={saving || !url.trim()}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plug className="h-4 w-4" aria-hidden />}
                Add destination
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this webhook destination?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? `${str(deleteTarget.config.url)} will stop receiving events. Its encrypted signing secret is deleted with it.` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-[44px]">Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="min-h-[44px] bg-destructive text-white hover:bg-destructive/90"
              disabled={deleting}
              onClick={(e) => { e.preventDefault(); void doDelete() }}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
              Delete destination
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

/* ------------------------------ outbox tab ------------------------------ */

function OutboxTab({ canManage }: { canManage: boolean }) {
  const { toast } = useToast()
  const [messages, setMessages] = useState<OutboxRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [dispatching, setDispatching] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await api.get<{ messages: OutboxRow[] }>('/api/outbox')
      setMessages(d.messages)
      setError('')
    } catch (err) {
      setError(friendlyApiErrorLocal(err, 'Could not load the outbox'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Calendar OAuth returns here with ?google_calendar=... / ?microsoft_calendar=...
  // — report the outcome once and clean the URL.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const key = params.get('google_calendar') ? 'google_calendar' : params.get('microsoft_calendar') ? 'microsoft_calendar' : ''
    if (!key) return
    const state = params.get(key) ?? ''
    params.delete(key)
    const reason = params.get('reason')
    params.delete('reason')
    const query = params.toString()
    const url = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`
    window.history.replaceState(null, '', url)
    const label = key === 'google_calendar' ? 'Google Calendar' : 'Microsoft 365'
    if (state === 'connected') {
      toast({ title: `${label} connected`, description: 'Run a sync to pull your busy times and push upcoming bookings.' })
    } else {
      toast({ title: `${label} connection failed`, description: reason || 'The provider did not authorize the calendar.', variant: 'destructive' })
    }
  }, [toast])

  const dispatch = async () => {
    setDispatching(true)
    try {
      const r = await api.post<{ ok: boolean; stats: OutboxDispatchStats }>('/api/outbox/dispatch')
      const s = r.stats
      toast({
        title: 'Outbox dispatched',
        description: `${s.processed} processed · ${s.sent} sent · ${s.failed} failed · ${s.waiting} waiting`,
      })
      await load()
    } catch (err) {
      toast({ title: 'Dispatch failed', description: friendlyApiErrorLocal(err, 'Unknown error'), variant: 'destructive' })
    } finally {
      setDispatching(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground mr-auto">Every outbound message with its real delivery state — queued rows say why.</p>
        {canManage && (
          <Button onClick={() => void dispatch()} disabled={dispatching} className="min-h-[44px]" aria-label="Dispatch the outbox now">
            {dispatching ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
            Dispatch now
          </Button>
        )}
        <Button variant="outline" onClick={() => void load()} disabled={loading} className="min-h-[44px]" aria-label="Refresh outbox">
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden /> Refresh
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2" aria-label="Loading outbox">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
        </div>
      ) : error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="space-y-2">
            <p>{error}</p>
            <Button size="sm" variant="outline" onClick={() => void load()} className="min-h-[44px]">Retry</Button>
          </AlertDescription>
        </Alert>
      ) : messages.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center space-y-2">
            <Send className="h-8 w-8 mx-auto text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">Nothing queued yet — invoice sends, reminders and automation messages appear here with honest delivery states.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="max-h-96 overflow-y-auto">
              <Table aria-label="Outbox messages">
                <TableHeader className="sticky top-0 bg-background">
                  <TableRow>
                    <TableHead>Created</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>Recipient</TableHead>
                    <TableHead className="hidden sm:table-cell">Subject</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {messages.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{formatDateTime(m.createdAt)}</TableCell>
                      <TableCell><Badge variant="secondary" className="font-normal text-[11px]">{m.channel}</Badge></TableCell>
                      <TableCell className="text-sm break-all max-w-[180px]">{m.recipient || '—'}</TableCell>
                      <TableCell className="hidden sm:table-cell text-sm max-w-[240px]"><p className="truncate" title={m.subject}>{m.subject || '—'}</p></TableCell>
                      <TableCell>
                        <Badge className={cn('text-[10px] px-1.5', OUTBOX_STATUS_CLASS[m.status] ?? 'bg-muted')}>{m.status}</Badge>
                        {typeof m.attempts === 'number' && m.attempts > 0 && (
                          <p className="text-[10px] text-muted-foreground mt-1">attempt {m.attempts}</p>
                        )}
                        {m.statusReason && <p className="text-xs text-muted-foreground mt-1 max-w-[220px]">{m.statusReason}</p>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

/* ------------------------------ calendar tab ------------------------------ */

function CalendarTab() {
  const origin = useOrigin()
  const feedUrl = `${origin}/api/calendar/bookings.ics`
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><CalendarDays className="h-4 w-4" aria-hidden /> Calendar feed (iCalendar)</CardTitle>
        <CardDescription>
          Your bookings are available as an iCalendar feed — subscribe from Google Calendar, Apple Calendar or Outlook using &ldquo;Add calendar from URL&rdquo;.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <code className="text-xs bg-muted rounded px-2 py-2 break-all flex-1 min-w-0">{origin ? feedUrl : '/api/calendar/bookings.ics'}</code>
          <CopyButton value={feedUrl} label="Copy calendar feed URL" />
          <Button
            variant="outline" size="sm" className="min-h-[44px]"
            disabled={!origin}
            onClick={() => window.open(feedUrl, '_blank', 'noopener')}
            aria-label="Open calendar feed"
          >
            <ExternalLink className="h-4 w-4" aria-hidden /> Open feed
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Links work inside your network; when self-hosting publicly they work anywhere. Each booking also has its own .ics link.
        </p>
      </CardContent>
    </Card>
  )
}

/* ------------------------------ inbound webhook tab ------------------------------ */

function InboundWebhookTab({ canManage }: { canManage: boolean }) {
  const origin = useOrigin()
  const { toast } = useToast()
  const [secret, setSecret] = useState('')
  const [secretState, setSecretState] = useState<'loading' | 'ready' | 'none'>(() => (canManage ? 'loading' : 'none'))
  const [rotating, setRotating] = useState(false)

  useEffect(() => {
    if (!canManage) return
    let cancelled = false
    api.get<{ secret?: string }>('/api/webhook-secret')
      .then((d) => {
        if (cancelled) return
        if (d && typeof d.secret === 'string' && d.secret) { setSecret(d.secret); setSecretState('ready') }
        else setSecretState('none')
      })
      .catch(() => { if (!cancelled) setSecretState('none') })
    return () => { cancelled = true }
  }, [canManage])

  const rotate = async () => {
    setRotating(true)
    try {
      const d = await api.put<{ secret: string }>('/api/webhook-secret')
      setSecret(d.secret)
      setSecretState('ready')
      toast({ title: 'Webhook secret rotated', description: 'The new value is shown once — copy it now.' })
    } catch (err) {
      toast({ title: 'Could not rotate secret', description: friendlyApiErrorLocal(err, 'Unknown error'), variant: 'destructive' })
    } finally {
      setRotating(false)
    }
  }

  const webhookUrl = `${origin}/api/payments/webhook`

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><WebhookIcon className="h-4 w-4" aria-hidden /> Inbound payment webhook</CardTitle>
        <CardDescription>Receive signed payment events from any provider into your ledger.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Webhook URL</Label>
          <div className="flex flex-wrap items-center gap-2">
            <code className="text-xs bg-muted rounded px-2 py-2 break-all flex-1 min-w-0">{origin ? webhookUrl : '/api/payments/webhook'}</code>
            <CopyButton value={webhookUrl} label="Copy payment webhook URL" />
          </div>
          <p className="text-xs text-muted-foreground">
            Any payment provider that can POST JSON with <code>org_slug</code> and an <code>x-signature</code> header works out of the box.
            Stripe users should point Stripe at <code>/api/stripe/webhook</code> instead — it is verified with the signing secret in the Stripe card above.
          </p>
        </div>

        <div className="space-y-2">
          <Label className="flex items-center gap-1.5"><KeyRound className="h-3.5 w-3.5" aria-hidden /> Signing secret (x-signature)</Label>
          {!canManage ? (
            <p className="text-sm text-muted-foreground">Owner/admin only — sign in as owner or admin to view or rotate the secret.</p>
          ) : secretState === 'loading' ? (
            <Skeleton className="h-10 w-full max-w-md" />
          ) : secretState === 'ready' ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-xs bg-muted rounded px-2 py-2 break-all flex-1 min-w-0" aria-label="Webhook signing secret">{secret}</code>
                <CopyButton value={secret} label="Copy webhook signing secret" />
              </div>
              <p className="text-xs text-muted-foreground">Keep this private — anyone holding it can post payment claims to your webhook.</p>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                No secret is retrievable right now. Rotate to generate a new one — the value is displayed exactly once, so copy it immediately.
              </p>
              <Button onClick={() => void rotate()} disabled={rotating} className="min-h-[44px]" aria-label="Rotate webhook signing secret">
                {rotating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
                Rotate secret
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/* ------------------------------ section ------------------------------ */

export function IntegrationsSection() {
  const session = useAppStore((s) => s.session)
  const canManage = session?.user?.role === 'owner' || session?.user?.role === 'admin'
  const { toast } = useToast()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [rows, setRows] = useState<IntegrationInfo[]>([])

  /**
   * Refresh never flips `loading` back to true — a skeleton swap would unmount
   * connector cards mid-interaction (closing open dialogs). Initial load shows
   * the skeleton; later failures keep the stale data and surface an inline alert.
   */
  const load = useCallback(async () => {
    try {
      const d = await api.get<{ integrations: IntegrationInfo[] }>('/api/integrations')
      setRows(d.integrations)
      setError('')
    } catch (err) {
      setError(friendlyApiErrorLocal(err, 'Could not load integrations'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const singleton = (kind: string) => rows.find((r) => r.kind === kind) ?? null
  const webhookRows = rows.filter((r) => r.kind === 'webhook_out')

  if (loading) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading integrations">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-12 w-full max-w-2xl" />
        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-56 w-full" />)}
        </div>
      </div>
    )
  }

  if (error && rows.length === 0) {
    return (
      <div className="space-y-4">
        <Alert variant="destructive" role="alert">
          <AlertDescription className="space-y-2">
            <p>{error}</p>
            <Button size="sm" variant="outline" onClick={() => void load()} className="min-h-[44px]">Retry</Button>
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className="space-y-6" aria-label="Integrations">
      <div className="flex flex-wrap items-start gap-2">
        <div className="mr-auto">
          <h2 className="text-lg font-semibold tracking-tight">Integrations</h2>
          <p className="text-sm text-muted-foreground max-w-3xl">
            Bring your own keys — everything is optional; the assistant works fully without any of these. Credentials are
            encrypted at rest (AES-256-GCM) and are never returned after saving.
          </p>
        </div>
        {!canManage && <Badge variant="outline">read-only — owner/admin can edit</Badge>}
      </div>

      {error && rows.length > 0 && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="space-y-2">
            <p>Refresh failed, showing the last known state — {error}</p>
            <Button size="sm" variant="outline" onClick={() => void load()} className="min-h-[44px]">Retry</Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {SINGLETON_KINDS.map((kind) => (
          <ConnectorCard
            key={kind}
            kind={kind}
            row={singleton(kind)}
            canManage={canManage}
            onChanged={load}
          />
        ))}
        <WebhookDestinationsCard rows={webhookRows} canManage={canManage} onChanged={load} />
      </div>

      <Tabs defaultValue="outbox">
        <TabsList aria-label="Integration tools">
          <TabsTrigger value="outbox" className="min-h-[44px]"><Send className="h-4 w-4 mr-1.5" aria-hidden /> Outbox</TabsTrigger>
          <TabsTrigger value="calendar" className="min-h-[44px]"><CalendarDays className="h-4 w-4 mr-1.5" aria-hidden /> Calendar</TabsTrigger>
          <TabsTrigger value="inbound" className="min-h-[44px]"><WebhookIcon className="h-4 w-4 mr-1.5" aria-hidden /> Inbound webhook</TabsTrigger>
        </TabsList>

        <TabsContent value="outbox" className="mt-4">
          <OutboxTab canManage={canManage} />
        </TabsContent>

        <TabsContent value="calendar" className="mt-4">
          <CalendarTab />
        </TabsContent>

        <TabsContent value="inbound" className="mt-4">
          <InboundWebhookTab canManage={canManage} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
