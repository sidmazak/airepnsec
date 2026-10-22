'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/lib/client/store'
import { api, formatDateTime } from '@/lib/client/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useToast } from '@/hooks/use-toast'
import {
  Activity,
  CheckCircle2,
  XCircle,
  CircleHelp,
  TriangleAlert,
  RefreshCw,
  DatabaseBackup,
  Download,
  PlayCircle,
  ShieldCheck,
  Bot,
  ArrowRight,
} from 'lucide-react'

type ProviderMini = { provider?: string; enabled?: boolean; lastTestOk?: boolean }

type WorkerRow = {
  name: 'automation' | 'outbox' | 'datasources'
  enabled?: boolean
  running?: boolean
  lastRunAt?: string | null
  lastError?: string
  leaseExpiresAt?: string | null
}

type HealthDetail = {
  db?: boolean
  database?: { kind?: string; journalMode?: string; busyTimeoutMs?: number | null } | null
  encryptionKey?: boolean
  webhookSecret?: boolean
  workerHeartbeat?: { lastTick?: string | null; healthy?: boolean }
  workers?: WorkerRow[]
  providers?: { llm?: ProviderMini; embedding?: ProviderMini }
  counts?: {
    customers?: number
    bookings?: number
    invoices?: number
    conversations?: number
    outboxQueued?: number
  }
  dataMode?: string
}

const POLL_MS = 20_000

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes}`
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const WORKER_LABELS: Record<string, string> = {
  automation: 'Automation engine',
  outbox: 'Outbox dispatcher',
  datasources: 'Data-source sync',
}

const WORKER_DESCRIPTIONS: Record<string, string> = {
  automation: 'Runs scheduled triggers, reminders, and escalation follow-ups every 60 seconds.',
  outbox: 'Delivers queued email / SMS / WhatsApp / webhook messages every 30 seconds with backoff.',
  datasources: 'Re-pulls enabled external data sources when their sync interval is due.',
}

const DATA_MODE_INFO: Record<string, { label: string; body: string }> = {
  local_only: {
    label: 'Local only',
    body: 'All AI processing stays on this machine. Cloud providers are blocked — no customer data leaves the server, even if keys were configured.',
  },
  hybrid: {
    label: 'Hybrid',
    body: 'Local-first: local adapters are used where available, and cloud providers you explicitly configure and test may process data.',
  },
  cloud_first: {
    label: 'Cloud first',
    body: 'Cloud providers are preferred when configured. Data sent to those providers is subject to their handling — review the AI Providers section.',
  },
}

function CheckRow({
  state,
  title,
  explanation,
  detail,
}: {
  state: 'ok' | 'fail' | 'unknown'
  title: string
  explanation: string
  detail?: string
}) {
  return (
    <li className="flex items-start gap-3 rounded-lg border p-3">
      {state === 'ok' ? (
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" role="img" aria-label="Healthy" />
      ) : state === 'fail' ? (
        <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" role="img" aria-label="Failing" />
      ) : (
        <CircleHelp className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" role="img" aria-label="Unknown" />
      )}
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{explanation}</p>
        {detail && <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>}
      </div>
    </li>
  )
}

function tri(bool: boolean | undefined): 'ok' | 'fail' | 'unknown' {
  if (bool === true) return 'ok'
  if (bool === false) return 'fail'
  return 'unknown'
}

export function DiagnosticsSection() {
  const session = useAppStore((s) => s.session)
  const setActiveSection = useAppStore((s) => s.setActiveSection)
  const { toast } = useToast()

  const role = session?.user?.role ?? ''
  const isAdmin = role === 'owner' || role === 'admin'

  const [data, setData] = useState<HealthDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [runningAutomations, setRunningAutomations] = useState(false)
  const [backingUp, setBackingUp] = useState(false)
  const [backup, setBackup] = useState<{ file: string; bytes: number } | null>(null)
  const [updatedLabel, setUpdatedLabel] = useState('')

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const d = await api.get<HealthDetail>('/api/health/detail')
      setData(d)
      setUpdatedLabel(`Updated ${formatDateTime(new Date().toISOString())}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load diagnostics')
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

  const runAutomations = async () => {
    setRunningAutomations(true)
    try {
      await api.post('/api/automations/run')
      toast({ title: 'Automations ran', description: 'The automation engine executed a tick for this workspace.' })
      await load(true)
    } catch (err) {
      toast({
        title: 'Could not run automations',
        description: err instanceof Error ? err.message : 'Unexpected error',
        variant: 'destructive',
      })
    } finally {
      setRunningAutomations(false)
    }
  }

  const createBackup = async () => {
    setBackingUp(true)
    try {
      const res = await api.post<{ file: string; bytes: number }>('/api/admin/backup')
      setBackup(res)
      toast({
        title: 'Backup created',
        description: `${res.file} (${formatBytes(res.bytes)}) written to the server's backups directory.`,
      })
    } catch (err) {
      toast({
        title: 'Backup failed',
        description: err instanceof Error ? err.message : 'Unexpected error',
        variant: 'destructive',
      })
    } finally {
      setBackingUp(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading diagnostics">
        <Skeleton className="h-8 w-56" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-4">
        <Alert variant="destructive" role="alert">
          <TriangleAlert className="h-4 w-4" aria-hidden />
          <AlertTitle>Diagnostics unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <Button onClick={() => void load()} className="min-h-[44px]">
          <RefreshCw className="h-4 w-4" aria-hidden />
          Retry
        </Button>
      </div>
    )
  }

  const heartbeat = data?.workerHeartbeat
  const heartbeatHealthy = heartbeat?.healthy === true
  const automationWorker = data?.workers?.find((w) => w.name === 'automation')
  const automationDisabled = automationWorker?.enabled === false
  const dbDetail = data?.database
    ? data.database.kind === 'sqlite'
      ? `SQLite · journal ${data.database.journalMode ?? 'unknown'} · busy timeout ${data.database.busyTimeoutMs ?? 0} ms`
      : data.database.kind === 'postgres'
        ? 'PostgreSQL'
        : `Database kind: ${data.database.kind ?? 'unknown'}`
    : undefined
  const llm = data?.providers?.llm
  const embedding = data?.providers?.embedding
  const counts = data?.counts
  const dataMode = data?.dataMode ?? 'unknown'
  const modeInfo = DATA_MODE_INFO[dataMode] ?? {
    label: dataMode,
    body: 'The server did not report a recognized data mode.',
  }

  const providerExplanation = (p: ProviderMini | undefined, name: string): { state: 'ok' | 'fail' | 'unknown'; text: string } => {
    if (!p || typeof p.enabled !== 'boolean') {
      return { state: 'unknown', text: `${name} status was not reported by the server.` }
    }
    if (!p.enabled) return { state: 'fail', text: `No ${name} provider enabled — features that need it are disabled.` }
    if (p.lastTestOk) return { state: 'ok', text: `${p.provider ?? name} enabled and the last connection test passed.` }
    return { state: 'fail', text: `${p.provider ?? name} enabled, but the last connection test did not pass — check its settings.` }
  }

  const llmInfo = providerExplanation(llm, 'conversation model')
  const embeddingInfo = providerExplanation(embedding, 'embedding model')

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Diagnostics</h1>
          <p className="text-sm text-muted-foreground">
            Real, measured checks — refreshed every 20 seconds. Nothing here is faked.
          </p>
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

      {!heartbeatHealthy && !automationDisabled && (
        <Alert role="alert" className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          <TriangleAlert className="h-4 w-4" aria-hidden />
          <AlertTitle>Automation worker is not ticking</AlertTitle>
          <AlertDescription>
            {heartbeat?.lastTick
              ? `Last tick was ${formatDateTime(heartbeat.lastTick)} — more than 5 minutes ago. Scheduled reminders and follow-ups are paused.`
              : 'No automation tick has been recorded yet. Scheduled reminders and follow-ups will not run until the worker ticks.'}{' '}
            The worker ticks every 60 seconds while the server is running — or run one now:
            <span className="mt-2 block">
              <Button
                size="sm"
                variant="outline"
                className="min-h-[44px] border-amber-400 text-amber-900 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900"
                onClick={() => void runAutomations()}
                disabled={runningAutomations}
              >
                <PlayCircle className="h-4 w-4" aria-hidden />
                Run automations now
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4" aria-hidden />
              Core health
            </CardTitle>
            <CardDescription>Infrastructure checks measured live on this server.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2" aria-label="Core health checks">
              <CheckRow
                state={tri(data?.db)}
                title="Database"
                explanation={
                  data?.db === true
                    ? 'Database reachable — a live round-trip query succeeded.'
                    : data?.db === false
                      ? 'Database check failed — records cannot be read or written right now.'
                      : 'Not reported by the server.'
                }
                detail={dbDetail}
              />
              <CheckRow
                state={tri(data?.encryptionKey)}
                title="Encryption key"
                explanation={
                  data?.encryptionKey === true
                    ? 'Server-side encryption key present — stored secrets (e.g. provider API keys) are encrypted at rest.'
                    : data?.encryptionKey === false
                      ? 'No server encryption key — new secrets cannot be stored safely.'
                      : 'Not reported by the server.'
                }
              />
              <CheckRow
                state={tri(data?.webhookSecret)}
                title="Webhook secret"
                explanation={
                  data?.webhookSecret === true
                    ? 'Configured — incoming payment webhooks are signature-verified before processing.'
                    : data?.webhookSecret === false
                      ? 'Not configured — payment webhooks will be rejected until a secret is rotated in Settings.'
                      : 'Not reported by the server.'
                }
              />
              <CheckRow
                state={tri(heartbeatHealthy)}
                title="Worker heartbeat"
                explanation={
                  heartbeatHealthy
                    ? 'Worker heartbeat: automation runner ticked recently — scheduled jobs are flowing.'
                    : heartbeat
                      ? 'No recent tick from the automation runner — scheduled reminders and follow-ups are not being processed.'
                      : 'Not reported by the server.'
                }
                detail={heartbeat?.lastTick ? `Last tick: ${formatDateTime(heartbeat.lastTick)}` : 'Last tick: never'}
              />
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="h-4 w-4" aria-hidden />
              AI providers
            </CardTitle>
            <CardDescription>Enabled, tested state for each AI capability.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <ul className="space-y-2" aria-label="AI provider checks">
              <CheckRow
                state={llmInfo.state}
                title="Conversation model (LLM)"
                explanation={llmInfo.text}
                detail={llm?.provider ? `Provider: ${llm.provider}` : undefined}
              />
              <CheckRow
                state={embeddingInfo.state}
                title="Embedding model"
                explanation={embeddingInfo.text}
                detail={embedding?.provider ? `Provider: ${embedding.provider}` : undefined}
              />
            </ul>
            <Separator className="my-3" />
            <Button variant="secondary" size="sm" className="min-h-[44px]" onClick={() => setActiveSection('ai')}>
              Open AI Providers
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" aria-hidden />
            Background workers
          </CardTitle>
          <CardDescription>
            Lease-protected across app instances — only one instance runs each worker at a time. Turn workers off on
            web-only instances with <code className="text-xs">AIS_DISABLE_WORKERS=1</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!data?.workers?.length ? (
            <p className="text-sm text-muted-foreground">Worker state was not reported by the server.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Worker</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last run</TableHead>
                  <TableHead>Last error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.workers.map((worker) => (
                  <TableRow key={worker.name}>
                    <TableCell className="min-w-0">
                      <p className="text-sm font-medium">{WORKER_LABELS[worker.name] ?? worker.name}</p>
                      <p className="text-xs text-muted-foreground">{WORKER_DESCRIPTIONS[worker.name] ?? ''}</p>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        <Badge variant={worker.enabled === false ? 'secondary' : 'default'}>
                          {worker.enabled === false ? 'Disabled' : 'Enabled'}
                        </Badge>
                        {worker.enabled !== false && (
                          <Badge variant={worker.running ? 'default' : 'outline'}>
                            {worker.running ? 'Running' : 'Idle'}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {worker.lastRunAt ? formatDateTime(worker.lastRunAt) : 'Never'}
                    </TableCell>
                    <TableCell className="max-w-[24rem] text-xs text-muted-foreground">
                      {worker.lastError ? (
                        <span className="text-destructive break-words">{worker.lastError}</span>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {automationDisabled && (
            <p className="mt-3 text-xs text-muted-foreground">
              The automation worker is disabled by environment configuration on this instance. Run a dedicated worker
              instance with <code>AIS_WORKER_AUTOMATION=1</code> if scheduled jobs should run.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4" aria-hidden />
              Data privacy
            </CardTitle>
            <CardDescription>Where your data is allowed to go when AI is used.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge
                className={
                  dataMode === 'local_only'
                    ? 'border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                    : dataMode === 'cloud_first'
                      ? 'border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300'
                      : undefined
                }
              >
                {modeInfo.label}
              </Badge>
              <span className="font-mono text-xs text-muted-foreground">{dataMode}</span>
            </div>
            <p className="text-sm text-muted-foreground">{modeInfo.body}</p>
            <p className="text-sm text-muted-foreground">
              Change this and review each provider&rsquo;s data handling in the AI Providers section.
            </p>
            <Button variant="secondary" size="sm" className="min-h-[44px]" onClick={() => setActiveSection('ai')}>
              Review AI providers
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Record counts</CardTitle>
            <CardDescription>Total records currently stored for this workspace.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table aria-label="Record counts">
              <TableHeader>
                <TableRow>
                  <TableHead>Record type</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>Customers</TableCell>
                  <TableCell className="text-right tabular-nums">{counts?.customers ?? 0}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Bookings</TableCell>
                  <TableCell className="text-right tabular-nums">{counts?.bookings ?? 0}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Invoices</TableCell>
                  <TableCell className="text-right tabular-nums">{counts?.invoices ?? 0}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Conversations</TableCell>
                  <TableCell className="text-right tabular-nums">{counts?.conversations ?? 0}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Outbox queued</TableCell>
                  <TableCell className="text-right tabular-nums">{counts?.outboxQueued ?? 0}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <DatabaseBackup className="h-4 w-4" aria-hidden />
            Backup &amp; export
          </CardTitle>
          <CardDescription>
            Owner/admin only. Backups are honest database snapshots written on the server — no overwrite magic.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isAdmin ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => void createBackup()} disabled={backingUp} className="min-h-[44px]">
                  {backingUp ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden /> : <DatabaseBackup className="h-4 w-4" aria-hidden />}
                  {backingUp ? 'Creating backup…' : 'Create backup'}
                </Button>
                <Button
                  variant="outline"
                  className="min-h-[44px]"
                  onClick={() => window.open('/api/admin/export', '_blank', 'noopener')}
                >
                  <Download className="h-4 w-4" aria-hidden />
                  Export data (JSON)
                </Button>
              </div>
              {backup && (
                <div
                  className="flex items-start gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
                  role="status"
                  aria-live="polite"
                >
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>
                    Last backup: <span className="font-mono">{backup.file}</span> — {formatBytes(backup.bytes)} stored in the
                    server&rsquo;s <span className="font-mono">backups/</span> directory.
                  </span>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Export downloads a full JSON copy of this org&rsquo;s data (no secrets, no credentials) straight from the
                server.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Backup and export are available to owner and admin accounts only. You are signed in as{' '}
              <strong>{role || 'a limited user'}</strong>.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
