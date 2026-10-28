'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/lib/client/store'
import {
  api,
  formatMoney,
  formatDateTime,
  type Booking,
  type AuditRow,
  type OutboxRow,
  type ReadinessItem,
  type SessionInfo,
} from '@/lib/client/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import {
  CalendarDays,
  Receipt,
  Inbox,
  Wallet,
  RefreshCw,
  ArrowRight,
  CheckCircle2,
  XCircle,
  TriangleAlert,
  Mail,
  MessageSquare,
  Bell,
  PlusCircle,
  PhoneCall,
  PauseCircle,
  PlayCircle,
  StopCircle,
  Clock3,
  Save,
} from 'lucide-react'

type OverdueRow = {
  id: string
  number: string
  customer?: string
  customerName?: string
  customerId?: string
  daysOverdue: number
  outstandingCents: number
}

type DashboardData = {
  todayBookings?: Booking[]
  upcomingBookings?: Booking[]
  outstandingCents?: number
  overdue?: OverdueRow[]
  openConversations?: { total?: number; waitingHuman?: number }
  recentAudit?: AuditRow[]
  outboxRecent?: OutboxRow[]
  readiness?: { okCount?: number; total?: number; items?: ReadinessItem[] }
}

const POLL_MS = 30_000

function metaSummary(meta: string): string {
  if (!meta || meta === '{}') return ''
  try {
    const obj = JSON.parse(meta) as Record<string, unknown>
    const parts = Object.entries(obj)
      .slice(0, 3)
      .map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`)
    return parts.join(' · ')
  } catch {
    return meta.slice(0, 60)
  }
}

function BookingStatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase()
  if (s === 'confirmed')
    return (
      <Badge className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
        {status}
      </Badge>
    )
  if (s === 'pending')
    return (
      <Badge className="border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300">
        {status}
      </Badge>
    )
  return <Badge variant="secondary">{status}</Badge>
}

function OutboxStatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase()
  if (s === 'sent')
    return (
      <Badge className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
        sent
      </Badge>
    )
  if (s === 'failed') return <Badge variant="destructive">{status}</Badge>
  if (s === 'queued')
    return (
      <Badge className="border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300">
        queued
      </Badge>
    )
  return <Badge variant="secondary">{status}</Badge>
}

function ChannelIcon({ channel }: { channel: string }) {
  const c = channel.toLowerCase()
  if (c === 'email') return <Mail className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
  if (c === 'sms') return <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
  return <Bell className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
}

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  target,
  targetLabel,
}: {
  label: string
  value: string
  sub?: string
  icon: typeof CalendarDays
  target: 'bookings' | 'invoices' | 'inbox'
  targetLabel: string
}) {
  const setActiveSection = useAppStore((s) => s.setActiveSection)
  return (
    <button
      type="button"
      onClick={() => setActiveSection(target)}
      aria-label={`${label}: ${value}. Open ${targetLabel}`} title={`${label}: ${value}. Open ${targetLabel}`}
      className="min-h-[44px] rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card className="h-full transition-colors hover:bg-muted/50">
        <CardContent className="flex items-start gap-3 p-4">
          <div className="rounded-lg bg-primary/10 p-2" aria-hidden>
            <Icon className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className="truncate text-2xl font-semibold tabular-nums">{value}</p>
            {sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
          </div>
          <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        </CardContent>
      </Card>
    </button>
  )
}

function ProviderLabel({ kind }: { kind: string }) {
  const labels: Record<string, string> = {
    twilio_sms: 'Twilio SMS', twilio_whatsapp: 'Twilio WhatsApp', meta_whatsapp: 'Meta WhatsApp',
    sinch: 'Sinch', infobip: 'Infobip', clicksend: 'ClickSend', vonage: 'Vonage',
    messagebird: 'MessageBird', plivo: 'Plivo', telnyx: 'Telnyx', textbee: 'TextBee',
    httpsms: 'httpSMS', android_sms_gateway: 'Android SMS Gateway',
    email_api: 'Email API', smtp: 'SMTP',
  }
  return <>{labels[kind] ?? kind}</>
}

function deliveryLabel(status?: string): string {
  if (!status || status === 'accepted') return ''
  if (status === 'failed') return 'not delivered'
  if (status === 'delivered') return 'delivered'
  if (status === 'read') return 'read'
  return status
}

type ReceptionistStatus = 'running' | 'paused' | 'stopped'

type DayWindow = { start: string; end: string }
type ReceptionistSchedule = {
  enabled: boolean
  days: Record<string, DayWindow | null>
  timezone?: string
}

const DAY_ROWS: Array<{ key: string; label: string }> = [
  { key: '1', label: 'Monday' },
  { key: '2', label: 'Tuesday' },
  { key: '3', label: 'Wednesday' },
  { key: '4', label: 'Thursday' },
  { key: '5', label: 'Friday' },
  { key: '6', label: 'Saturday' },
  { key: '0', label: 'Sunday' },
]

const RECEPTIONIST_OPTIONS: Array<{
  status: ReceptionistStatus
  label: string
  detail: string
  icon: typeof PlayCircle
}> = [
  {
    status: 'running',
    label: 'Running',
    detail: 'The assistant answers inbound SMS, WhatsApp, phone calls and web chat.',
    icon: PlayCircle,
  },
  {
    status: 'paused',
    label: 'Paused',
    detail: 'Inbound is recorded for staff, but the assistant does not reply. Calls get a short notice.',
    icon: PauseCircle,
  },
  {
    status: 'stopped',
    label: 'Stopped',
    detail: 'The app stops listening: inbound webhooks are acknowledged and audited, nothing is answered.',
    icon: StopCircle,
  },
]

/**
 * Runtime switch for the AI receptionist — pause, resume or stop the assistant for
 * the whole organization from the dashboard. Every change is audited server-side.
 */
function ReceptionistControl() {
  const session = useAppStore((s) => s.session)
  const setSession = useAppStore((s) => s.setSession)
  const { toast } = useToast()
  const canManage = session?.user?.role === 'owner' || session?.user?.role === 'admin'
  const [status, setStatus] = useState<ReceptionistStatus>(
    ((session?.org?.receptionistBaseStatus ?? session?.org?.receptionistStatus) as ReceptionistStatus) || 'running',
  )
  const [effectiveStatus, setEffectiveStatus] = useState<ReceptionistStatus>(
    (session?.org?.receptionistStatus as ReceptionistStatus) || 'running',
  )
  const [schedule, setSchedule] = useState<ReceptionistSchedule | null>(
    session?.org?.receptionistSchedule ?? null,
  )
  const [scheduledOff, setScheduledOff] = useState(Boolean(session?.org?.receptionistScheduledOff))
  const [savingSchedule, setSavingSchedule] = useState(false)
  const [scheduleError, setScheduleError] = useState('')
  const [pending, setPending] = useState<ReceptionistStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    api
      .get<{
        status: ReceptionistStatus
        baseStatus: ReceptionistStatus
        scheduledOff: boolean
        schedule: ReceptionistSchedule
      }>('/api/settings/receptionist')
      .then((d) => {
        if (cancelled) return
        setStatus(d.baseStatus)
        setEffectiveStatus(d.status)
        setScheduledOff(d.scheduledOff)
        setSchedule(d.schedule)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const apply = async (next: ReceptionistStatus) => {
    setBusy(true)
    setError('')
    try {
      const r = await api.patch<{
        status: ReceptionistStatus
        baseStatus: ReceptionistStatus
        scheduledOff: boolean
        schedule: ReceptionistSchedule
      }>('/api/settings/receptionist', { status: next })
      setStatus(r.baseStatus)
      setEffectiveStatus(r.status)
      setScheduledOff(r.scheduledOff)
      setSchedule(r.schedule)
      const s = await api.get<SessionInfo>('/api/session')
      setSession(s)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the receptionist state')
    } finally {
      setBusy(false)
      setPending(null)
    }
  }

  const updateDay = (key: string, window: DayWindow | null) => {
    setSchedule((current) => current ? { ...current, days: { ...current.days, [key]: window } } : current)
  }

  const saveSchedule = async () => {
    if (!schedule) return
    setSavingSchedule(true)
    setScheduleError('')
    try {
      const r = await api.patch<{
        status: ReceptionistStatus
        baseStatus: ReceptionistStatus
        scheduledOff: boolean
        schedule: ReceptionistSchedule
      }>('/api/settings/receptionist', { schedule })
      setStatus(r.baseStatus)
      setEffectiveStatus(r.status)
      setScheduledOff(r.scheduledOff)
      setSchedule(r.schedule)
      const s = await api.get<SessionInfo>('/api/session')
      setSession(s)
      toast({ title: r.schedule.enabled ? 'Receptionist schedule saved' : 'Schedule disabled', description: r.schedule.enabled ? 'The assistant follows these weekly hours.' : 'The assistant now follows the running/paused switch around the clock.' })
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : 'Could not save the schedule')
    } finally {
      setSavingSchedule(false)
    }
  }

  const displayStatus = scheduledOff ? 'paused' : effectiveStatus
  const current = RECEPTIONIST_OPTIONS.find((o) => o.status === displayStatus) ?? RECEPTIONIST_OPTIONS[0]
  const CurrentIcon = current.icon
  const timezone = schedule?.timezone || session?.org?.timezone || 'UTC+00:00'

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <CurrentIcon className="h-4 w-4" aria-hidden /> AI receptionist
          </CardTitle>
          <Badge
            className={
              displayStatus === 'running'
                ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-300'
                : displayStatus === 'paused'
                  ? 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300'
                  : 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-300'
            }
          >
            {scheduledOff ? 'Paused · off schedule' : current.label}
          </Badge>
        </div>
        <CardDescription>
          {scheduledOff
            ? `Outside the configured schedule (${timezone}). Inbound is recorded for staff, but the assistant does not reply.`
            : current.detail}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="grid gap-2 sm:grid-cols-3" role="group" aria-label="Receptionist state">
          {RECEPTIONIST_OPTIONS.map((opt) => {
            const Icon = opt.icon
            const active = status === opt.status
            return (
              <button
                key={opt.status}
                type="button"
                disabled={!canManage || busy}
                aria-pressed={active}
                aria-label={`${opt.label}: ${opt.detail}`} title={`${opt.label}: ${opt.detail}`}
                onClick={() => {
                  if (active) return
                  if (opt.status === 'running') void apply('running')
                  else setPending(opt.status)
                }}
                className={cn(
                  'min-h-[44px] rounded-lg border p-3 text-left transition-colors disabled:opacity-60',
                  active ? 'border-primary bg-primary/5' : 'hover:bg-muted/60',
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <Icon className="h-4 w-4" aria-hidden /> {opt.label}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">{opt.detail}</span>
              </button>
            )
          })}
        </div>
        {!canManage && (
          <p className="text-xs text-muted-foreground">Only owners and admins can start, pause or stop the receptionist.</p>
        )}
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <PhoneCall className="h-3.5 w-3.5" aria-hidden />
          Calls routed to a human agent line are not affected. Scheduled reminders and automations keep running.
        </p>

        <Separator />
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="flex items-center gap-2 text-sm font-medium">
                <Clock3 className="h-4 w-4" aria-hidden /> Weekly schedule
              </p>
              <p className="text-xs text-muted-foreground">
                {timezone} · outside these hours the assistant pauses (inbound is still recorded for staff).
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="receptionist-schedule-enabled" className="text-xs">Run on schedule</Label>
              <Switch
                id="receptionist-schedule-enabled"
                checked={Boolean(schedule?.enabled)}
                disabled={!canManage || !schedule}
                onCheckedChange={(enabled) => setSchedule((current) => current ? { ...current, enabled } : current)}
                aria-label="Run the receptionist on a weekly schedule"
              />
            </div>
          </div>
          {scheduleError && <Alert variant="destructive" role="alert"><AlertDescription>{scheduleError}</AlertDescription></Alert>}
          <div className="space-y-1.5">
            {DAY_ROWS.map((day) => {
              const window = schedule?.days?.[day.key] ?? null
              const open = Boolean(window)
              return (
                <div key={day.key} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
                  <Switch
                    checked={open}
                    disabled={!canManage || !schedule}
                    onCheckedChange={(next) => updateDay(day.key, next ? { start: window?.start ?? '09:00', end: window?.end ?? '17:00' } : null)}
                    aria-label={`${day.label} open`}
                  />
                  <span className={cn('w-24 text-sm', !open && 'text-muted-foreground')}>{day.label}</span>
                  <Input
                    type="time"
                    value={window?.start ?? ''}
                    disabled={!canManage || !open}
                    onChange={(e) => updateDay(day.key, { start: e.target.value, end: window?.end ?? '17:00' })}
                    aria-label={`${day.label} opening time`}
                    className="min-h-[40px] w-[120px]"
                  />
                  <span className="text-xs text-muted-foreground">to</span>
                  <Input
                    type="time"
                    value={window?.end ?? ''}
                    disabled={!canManage || !open}
                    onChange={(e) => updateDay(day.key, { start: window?.start ?? '09:00', end: e.target.value })}
                    aria-label={`${day.label} closing time`}
                    className="min-h-[40px] w-[120px]"
                  />
                  {!open && <Badge variant="outline" className="text-[10px]">closed</Badge>}
                </div>
              )
            })}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">The running/paused switch above always wins over the schedule.</p>
            <Button
              type="button"
              size="sm"
              onClick={() => void saveSchedule()}
              disabled={!canManage || !schedule || savingSchedule}
            >
              <Save className="mr-1.5 h-4 w-4" aria-hidden /> {savingSchedule ? 'Saving…' : 'Save schedule'}
            </Button>
          </div>
        </div>

        <AlertDialog open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {pending === 'paused' ? 'Pause the AI receptionist?' : 'Stop the AI receptionist?'}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {pending === 'paused'
                  ? 'Inbound SMS, WhatsApp, calls and web chat are still recorded for staff, but the assistant will not reply. Calls get a short notice that the assistant is taking a break.'
                  : 'The app stops listening: inbound webhooks are acknowledged and audited, but no conversation is opened and nothing is answered. Customers get no reply at all until you restart the receptionist.'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => { if (pending) void apply(pending) }}>
                {pending === 'paused' ? 'Pause receptionist' : 'Stop receptionist'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  )
}

export function DashboardSection() {
  const session = useAppStore((s) => s.session)
  const setActiveSection = useAppStore((s) => s.setActiveSection)
  const currency = session?.org?.currency ?? 'USD'

  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updatedLabel, setUpdatedLabel] = useState('')

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const d = await api.get<DashboardData>('/api/dashboard')
      setData(d)
      setUpdatedLabel(`Updated ${formatDateTime(new Date().toISOString())}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the dashboard')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => {
      void load(true)
    }, POLL_MS)
    return () => clearInterval(t)
  }, [load])

  const today = data?.todayBookings ?? []
  const upcoming = data?.upcomingBookings ?? []
  const seen = new Set<string>()
  const merged = [...today, ...upcoming]
    .filter((b) => {
      if (seen.has(b.id)) return false
      seen.add(b.id)
      return true
    })
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
  const visibleBookings = merged.slice(0, 8)
  const hiddenBookings = merged.length - visibleBookings.length

  const overdue = data?.overdue ?? []
  const readiness = data?.readiness
  const readinessItems = readiness?.items ?? []
  const okCount = readiness?.okCount ?? 0
  const total = readiness?.total ?? 0
  const readinessPct = total > 0 ? Math.round((okCount / total) * 100) : 0
  const waitingHuman = data?.openConversations?.waitingHuman ?? 0
  const openTotal = data?.openConversations?.total ?? 0

  if (loading) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading dashboard">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-9 w-28" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
        <Skeleton className="h-56 rounded-xl" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-4">
        <Alert variant="destructive" role="alert">
          <TriangleAlert className="h-4 w-4" aria-hidden />
          <AlertTitle>Dashboard unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <Button onClick={() => void load()} className="min-h-[44px]">
          <RefreshCw className="h-4 w-4" aria-hidden />
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Today at a glance — real data, refreshed every 30 seconds.</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {updatedLabel}
          </span>
          <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => void load(true)} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden />
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Key numbers">
        <StatCard
          label="Today's appointments"
          value={String(today.length)}
          sub={today.length === 0 ? 'Nothing in the next 24 hours' : 'Next 24 hours'}
          icon={CalendarDays}
          target="bookings"
          targetLabel="Bookings"
        />
        <StatCard
          label="Outstanding balance"
          value={formatMoney(data?.outstandingCents ?? 0, currency)}
          sub="Across all invoices"
          icon={Wallet}
          target="invoices"
          targetLabel="Invoices & Payments"
        />
        <StatCard
          label="Overdue invoices"
          value={String(overdue.length)}
          sub={overdue.length === 0 ? 'All invoices on time' : 'Needs a nudge'}
          icon={Receipt}
          target="invoices"
          targetLabel="Invoices & Payments"
        />
        <StatCard
          label="Inbox waiting on human"
          value={String(waitingHuman)}
          sub={`${openTotal} open conversation${openTotal === 1 ? '' : 's'}`}
          icon={Inbox}
          target="inbox"
          targetLabel="Inbox"
        />
      </div>

      <ReceptionistControl />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Today &amp; upcoming</CardTitle>
            <CardDescription>Confirmed and pending bookings, soonest first.</CardDescription>
          </CardHeader>
          <CardContent>
            {visibleBookings.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-6 text-center">
                <CalendarDays className="h-8 w-8 text-muted-foreground" aria-hidden />
                <p className="text-sm text-muted-foreground">No upcoming appointments yet.</p>
                <Button variant="secondary" size="sm" className="min-h-[44px]" onClick={() => setActiveSection('bookings')}>
                  <PlusCircle className="h-4 w-4" aria-hidden />
                  Create a booking
                </Button>
              </div>
            ) : (
              <ul className="max-h-96 space-y-3 overflow-y-auto pr-1 scrollbar-thin" aria-label="Upcoming bookings">
                {visibleBookings.map((b) => (
                  <li key={b.id} className="rounded-lg border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium">{b.customer?.name ?? 'Unknown customer'}</p>
                      <BookingStatusBadge status={b.status} />
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {b.service?.name ?? 'Service'} · {formatDateTime(b.startAt)}
                      {b.staff?.name ? ` · with ${b.staff.name}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {hiddenBookings > 0 && (
              <Button variant="link" size="sm" className="mt-2 px-0" onClick={() => setActiveSection('bookings')}>
                +{hiddenBookings} more — open Bookings
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Overdue invoices</CardTitle>
            <CardDescription>Past their due date with a balance still outstanding.</CardDescription>
          </CardHeader>
          <CardContent>
            {overdue.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-6 text-center">
                <CheckCircle2 className="h-8 w-8 text-emerald-600" aria-hidden />
                <p className="text-sm text-muted-foreground">No overdue invoices — every account is current.</p>
                <Button variant="secondary" size="sm" className="min-h-[44px]" onClick={() => setActiveSection('invoices')}>
                  Open Invoices &amp; Payments
                </Button>
              </div>
            ) : (
              <ul className="max-h-96 space-y-3 overflow-y-auto pr-1 scrollbar-thin" aria-label="Overdue invoices">
                {overdue.map((inv) => (
                  <li key={inv.id}>
                    <button
                      type="button"
                      onClick={() => setActiveSection('invoices')}
                      aria-label={`Invoice ${inv.number}, ${formatMoney(inv.outstandingCents, currency)}, ${inv.daysOverdue} days overdue. Open Invoices`}
                      className="w-full min-h-[44px] rounded-lg border p-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium">
                          {inv.number} · {inv.customer ?? inv.customerName ?? 'Unknown customer'}
                        </p>
                        <Badge className="border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300">
                          {inv.daysOverdue}d overdue
                        </Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Outstanding {formatMoney(inv.outstandingCents, currency)}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base">Setup readiness</CardTitle>
                <CardDescription>
                  {okCount} of {total} checks passed — finish these to run on autopilot.
                </CardDescription>
              </div>
              <span className="text-sm font-semibold tabular-nums" aria-hidden>
                {readinessPct}%
              </span>
            </div>
            <Progress value={readinessPct} className="mt-2" aria-label={`Setup readiness ${okCount} of ${total}`} />
          </CardHeader>
          <CardContent>
            {readinessItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">Readiness checks are not available right now.</p>
            ) : (
              <ul className="space-y-2" aria-label="Readiness checks">
                {readinessItems.map((item) => (
                  <li key={item.key} className="flex items-start gap-2 text-sm">
                    {item.ok ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-label="Done" />
                    ) : (
                      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-label="Not done" />
                    )}
                    <div className="min-w-0">
                      <p className="text-foreground">{item.label}</p>
                      {item.detail && <p className="truncate text-xs text-muted-foreground">{item.detail}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <Separator className="my-4" />
            <Button className="min-h-[44px]" onClick={() => setActiveSection('setup')}>
              Open setup wizard
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent activity</CardTitle>
              <CardDescription>Latest audited events across the workspace.</CardDescription>
            </CardHeader>
            <CardContent>
              {(data?.recentAudit ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
              ) : (
                <ul className="max-h-72 space-y-2 overflow-y-auto pr-1 scrollbar-thin" aria-label="Recent audit events">
                  {(data?.recentAudit ?? []).map((a) => (
                    <li key={a.id} className="flex items-start justify-between gap-2 text-sm">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-xs font-medium">{a.action}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {a.entity}
                          {metaSummary(a.meta) ? ` · ${metaSummary(a.meta)}` : ''}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(a.ts)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Outbox</CardTitle>
              <CardDescription>
                Recent outbound messages with honest delivery statuses — nothing is reported sent unless it really was.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {(data?.outboxRecent ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No outbound messages queued yet.</p>
              ) : (
                <ul className="max-h-72 space-y-2 overflow-y-auto pr-1 scrollbar-thin" aria-label="Recent outbox messages">
                  {(data?.outboxRecent ?? []).map((m) => (
                    <li key={m.id} className="rounded-lg border p-2.5">
                      <div className="flex items-center gap-2">
                        <ChannelIcon channel={m.channel} />
                        <p className="min-w-0 flex-1 truncate text-sm font-medium">{m.subject || '(no subject)'}</p>
                        {m.deliveryStatus && m.deliveryStatus !== 'accepted' && (
                          <Badge
                            variant={m.deliveryStatus === 'failed' ? 'destructive' : 'secondary'}
                            className="text-[10px]"
                            title={m.deliveryDetail || undefined}
                          >
                            {m.deliveryStatus}
                          </Badge>
                        )}
                        <OutboxStatusBadge status={m.status} />
                      </div>
                      {(m.status === 'queued' || m.status === 'failed') && m.statusReason && (
                        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">Reason: {m.statusReason}</p>
                      )}
                      <p className="mt-0.5 text-xs text-muted-foreground">{formatDateTime(m.createdAt)}</p>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-xs text-muted-foreground">
                &ldquo;Sent&rdquo; means the provider accepted the message. Twilio, Meta and carrier delivery receipts
                upgrade rows to &ldquo;delivered&rdquo; or &ldquo;failed&rdquo; when the handset result arrives.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
