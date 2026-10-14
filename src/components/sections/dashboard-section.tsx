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
} from '@/lib/client/api'
import { Button } from '@/components/ui/button'
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
      aria-label={`${label}: ${value}. Open ${targetLabel}`}
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
                This build has no email/SMS sender wired in — messages stay honestly &ldquo;queued&rdquo; here instead of
                pretending to send. Configure channels under Settings when a sender is available.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
