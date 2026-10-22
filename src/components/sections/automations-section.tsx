'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, formatDateTime, type Automation, type AutomationRun, type OutboxRow } from '@/lib/client/api'
import { useAppStore } from '@/lib/client/store'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  ChevronDown, ChevronUp, Clock, FlaskConical, History, Inbox, Loader2, Pencil,
  PlayCircle, Plus, ShieldAlert, Trash2, Workflow, Zap,
} from 'lucide-react'

/* ------------------------------ helpers ------------------------------ */

function parseJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T } catch { return fallback }
}

const TRIGGER_LABELS: Record<string, string> = {
  invoice_overdue: 'When an invoice becomes overdue',
  booking_created: 'When a booking is created',
  conversation_escalated: 'When a conversation is escalated',
  manual: 'Run manually',
}

const ACTION_LABELS: Record<string, string> = {
  send_invoice_reminder: 'Send invoice reminder',
  notify_inapp: 'In-app notification',
  flag_for_review: 'Flag for review',
  send_email: 'Send email (outbox)',
  send_sms: 'Send SMS (outbox)',
  send_webhook: 'Post webhook',
}

const RUN_BADGE: Record<string, string> = {
  success: 'bg-emerald-100 text-emerald-900',
  failed: 'bg-rose-100 text-rose-900',
  skipped: 'bg-amber-100 text-amber-900',
  running: 'bg-muted text-muted-foreground border animate-pulse',
}

const OUTBOX_BADGE: Record<string, string> = {
  queued: 'bg-amber-100 text-amber-900',
  sent: 'bg-emerald-100 text-emerald-900',
  failed: 'bg-rose-100 text-rose-900',
}

type DraftAction = { key: number; type: string; channel: string; template: string; body: string; subject: string; destinationId: string }
type DraftCondition = { key: number; field: string; op: string; value: string }

type EditorState = {
  id: string | null
  name: string
  description: string
  triggerType: string
  minDaysOverdue: number
  delayMinutes: number
  requireOutstanding: boolean
  extraConditions: DraftCondition[]
  actions: DraftAction[]
  maxRunsPerDay: number
  quietStart: string
  quietEnd: string
  testMode: boolean
  enabled: boolean
}

let actionKey = 1
const newAction = (type = 'send_invoice_reminder'): DraftAction => ({
  key: actionKey++,
  type,
  channel: 'email',
  template: 'Hi {{customer_name}}, a friendly reminder that invoice {{invoice_number}} ({{amount_due}}) was due on {{due_date}}. You can settle it any time — just reply here. — {{business_name}}',
  body: 'A new event needs your attention.',
  subject: '',
  destinationId: '',
})

function emptyEditor(): EditorState {
  return {
    id: null,
    name: '',
    description: '',
    triggerType: 'invoice_overdue',
    minDaysOverdue: 1,
    delayMinutes: 0,
    requireOutstanding: true,
    extraConditions: [],
    actions: [newAction()],
    maxRunsPerDay: 20,
    quietStart: '21:00',
    quietEnd: '08:00',
    testMode: true,
    enabled: false,
  }
}

function editorFromAutomation(a: Automation): EditorState {
  const cfg = parseJson<Record<string, unknown>>(a.triggerCfg, {})
  const conds = parseJson<Array<{ field: string; op: string; value: string | number }>>(a.conditions, [])
  const actions = parseJson<Array<{ type: string; cfg?: Record<string, unknown> }>>(a.actions, [])
  const quiet = parseJson<{ start?: string; end?: string }>(a.quietHours, {})
  const hasOutstanding = conds.some((c) => c.field === 'outstandingCents' && c.op === 'gt' && Number(c.value) === 0)
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    triggerType: a.triggerType,
    minDaysOverdue: Number(cfg.minDaysOverdue ?? 1),
    delayMinutes: a.delayMinutes ?? 0,
    requireOutstanding: hasOutstanding,
    extraConditions: conds
      .filter((c) => !(c.field === 'outstandingCents' && c.op === 'gt'))
      .map((c) => ({ key: actionKey++, field: c.field, op: c.op, value: String(c.value) })),
    actions: actions.length
      ? actions.map((ac) => ({
        key: actionKey++,
        type: ac.type,
        channel: String(ac.cfg?.channel ?? 'email'),
        template: String(ac.cfg?.template ?? ac.cfg?.body ?? ''),
        body: String(ac.cfg?.body ?? ''),
        subject: String(ac.cfg?.subject ?? ''),
        destinationId: String(ac.cfg?.destinationId ?? ''),
      }))
      : [newAction()],
    maxRunsPerDay: a.maxRunsPerDay ?? 20,
    quietStart: quiet.start ?? '',
    quietEnd: quiet.end ?? '',
    testMode: a.testMode,
    enabled: a.enabled,
  }
}

function describeActions(a: Automation): string[] {
  const actions = parseJson<Array<{ type: string; cfg?: Record<string, unknown> }>>(a.actions, [])
  return actions.map((ac) => {
    const base = ACTION_LABELS[ac.type] ?? ac.type
    if (ac.type === 'send_invoice_reminder') return `${base} · ${String(ac.cfg?.channel ?? 'email')}`
    if (ac.type === 'send_email') {
      const subject = String(ac.cfg?.subject ?? '').trim()
      return subject ? `${base} · ${subject}` : base
    }
    if (ac.type === 'send_sms') {
      const body = String(ac.cfg?.body ?? '').trim()
      return body ? `${base} · ${body.slice(0, 24)}${body.length > 24 ? '…' : ''}` : base
    }
    return base
  })
}

/* ------------------------------ section ------------------------------ */

export function AutomationsSection() {
  const { toast } = useToast()
  const session = useAppStore((s) => s.session)
  const canManage = session?.user?.role === 'owner' || session?.user?.role === 'admin'

  const [tab, setTab] = useState('automations')

  const [automations, setAutomations] = useState<Automation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [runAllBusy, setRunAllBusy] = useState(false)

  const [historyOpen, setHistoryOpen] = useState<Record<string, boolean>>({})
  const [runMap, setRunMap] = useState<Record<string, AutomationRun[]>>({})
  const [runsLoading, setRunsLoading] = useState<Record<string, boolean>>({})
  const [runsError, setRunsError] = useState<Record<string, string>>({})

  const [editorOpen, setEditorOpen] = useState(false)
  const [editor, setEditor] = useState<EditorState>(emptyEditor())
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Automation | null>(null)
  const [deleting, setDeleting] = useState(false)

  const [outbox, setOutbox] = useState<OutboxRow[]>([])
  const [outboxLoading, setOutboxLoading] = useState(false)
  const [outboxError, setOutboxError] = useState('')

  // webhook_out destinations for the send_webhook action editor (loaded when the editor opens)
  const [webhookDests, setWebhookDests] = useState<Array<{ id: string; url: string }>>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await api.get<{ automations: Automation[] }>('/api/automations')
      setAutomations(d.automations)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load automations')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadOutbox = useCallback(async () => {
    setOutboxLoading(true)
    try {
      const d = await api.get<{ messages: OutboxRow[] }>('/api/outbox')
      setOutbox(d.messages)
      setOutboxError('')
    } catch (err) {
      setOutboxError(err instanceof Error ? err.message : 'Could not load the outbox')
    } finally {
      setOutboxLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => { if (tab === 'outbox') void loadOutbox() }, [tab, loadOutbox])

  useEffect(() => {
    if (!editorOpen) return
    let cancelled = false
    api.get<{ integrations: Array<{ id: string; kind: string; config: Record<string, unknown> }> }>('/api/integrations')
      .then((d) => {
        if (cancelled) return
        setWebhookDests(
          d.integrations
            .filter((i) => i.kind === 'webhook_out')
            .map((i) => ({ id: i.id, url: typeof i.config?.url === 'string' ? i.config.url : '' }))
            .filter((w) => w.url !== '')
        )
      })
      .catch(() => { if (!cancelled) setWebhookDests([]) })
    return () => { cancelled = true }
  }, [editorOpen])

  const toggleHistory = async (id: string) => {
    const isOpen = historyOpen[id]
    setHistoryOpen((h) => ({ ...h, [id]: !isOpen }))
    if (!isOpen && !runMap[id]) {
      setRunsLoading((m) => ({ ...m, [id]: true }))
      try {
        const d = await api.get<{ runs: AutomationRun[] }>(`/api/automations/${id}/runs`)
        setRunMap((m) => ({ ...m, [id]: d.runs }))
        setRunsError((m) => ({ ...m, [id]: '' }))
      } catch (err) {
        setRunsError((m) => ({ ...m, [id]: err instanceof Error ? err.message : 'Could not load runs' }))
      } finally {
        setRunsLoading((m) => ({ ...m, [id]: false }))
      }
    }
  }

  const toggleEnabled = async (a: Automation, enabled: boolean) => {
    setBusyId(a.id)
    try {
      await api.patch(`/api/automations/${a.id}`, { enabled })
      await load()
      toast({ title: enabled ? `${a.name} enabled` : `${a.name} paused` })
    } catch (err) {
      toast({ title: 'Could not update', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setBusyId(null)
    }
  }

  const runAll = async () => {
    setRunAllBusy(true)
    try {
      const stats = await api.post<{ evaluated: number; executed: number; failed: number; skipped: number }>('/api/automations/run')
      toast({
        title: 'Automations evaluated',
        description: `${stats.evaluated} run(s) scheduled · ${stats.executed} executed · ${stats.skipped} skipped · ${stats.failed} failed`,
      })
      await load()
    } catch (err) {
      toast({ title: 'Run failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setRunAllBusy(false)
    }
  }

  const saveEditor = async () => {
    setSaving(true)
    try {
      const conditions: Array<{ field: string; op: string; value: string | number }> = []
      if (editor.requireOutstanding && editor.triggerType === 'invoice_overdue') {
        conditions.push({ field: 'outstandingCents', op: 'gt', value: 0 })
      }
      for (const c of editor.extraConditions) {
        if (!c.field.trim()) continue
        const num = Number(c.value)
        conditions.push({ field: c.field.trim(), op: c.op, value: c.value.trim() !== '' && Number.isFinite(num) ? num : c.value })
      }
      const payload = {
        name: editor.name.trim(),
        description: editor.description.trim(),
        triggerType: editor.triggerType,
        triggerCfg: editor.triggerType === 'invoice_overdue' ? { minDaysOverdue: Math.max(0, Math.floor(editor.minDaysOverdue)) } : {},
        conditions,
        delayMinutes: Math.max(0, Math.floor(editor.delayMinutes)),
        actions: editor.actions.map((a) => {
          if (a.type === 'send_invoice_reminder') return { type: a.type, cfg: { channel: a.channel, template: a.template } }
          if (a.type === 'notify_inapp') return { type: a.type, cfg: { body: a.body } }
          if (a.type === 'send_email') {
            const cfg: Record<string, string> = { body: a.body }
            if (a.subject.trim()) cfg.subject = a.subject.trim()
            return { type: a.type, cfg }
          }
          if (a.type === 'send_sms') return { type: a.type, cfg: { body: a.body } }
          if (a.type === 'send_webhook') {
            const cfg: Record<string, string> = {}
            if (a.destinationId) cfg.destinationId = a.destinationId
            if (a.body.trim()) cfg.body = a.body
            return { type: a.type, cfg }
          }
          return { type: a.type, cfg: {} }
        }),
        maxRunsPerDay: Math.max(1, Math.floor(editor.maxRunsPerDay)),
        quietHours: { start: editor.quietStart, end: editor.quietEnd },
        testMode: editor.testMode,
        enabled: editor.enabled,
      }
      if (editor.id) {
        await api.patch(`/api/automations/${editor.id}`, payload)
        toast({ title: 'Automation updated' })
      } else {
        await api.post('/api/automations', payload)
        toast({ title: 'Automation created', description: editor.testMode ? 'Test mode: runs are logged, not sent.' : 'Live: it can message customers.' })
      }
      setEditorOpen(false)
      await load()
    } catch (err) {
      toast({ title: 'Save failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const deleteAutomation = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api.delete(`/api/automations/${deleteTarget.id}`)
      toast({ title: 'Automation deleted' })
      setDeleteTarget(null)
      await load()
    } catch (err) {
      toast({ title: 'Delete failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setDeleting(false)
    }
  }

  const quietLabel = (raw: string) => {
    const q = parseJson<{ start?: string; end?: string }>(raw, {})
    return q.start && q.end ? `${q.start}–${q.end}` : 'none'
  }

  return (
    <div className="space-y-4" aria-label="Automations">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Automations</h2>
        <p className="text-sm text-muted-foreground">Rules that react to business events — overdue invoices, new bookings, escalated chats.</p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Automations tabs">
          <TabsTrigger value="automations" className="min-h-[44px]"><Workflow className="h-4 w-4 mr-1.5" aria-hidden /> Rules</TabsTrigger>
          <TabsTrigger value="outbox" className="min-h-[44px]"><Inbox className="h-4 w-4 mr-1.5" aria-hidden /> Outbox {outbox.length > 0 ? `(${outbox.length})` : ''}</TabsTrigger>
        </TabsList>

        <TabsContent value="automations" className="space-y-4 mt-4">
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => { setEditor(emptyEditor()); setEditorOpen(true) }}
              disabled={!canManage}
              className="min-h-[44px]"
              aria-label="Create a new automation"
            >
              <Plus className="h-4 w-4" aria-hidden /> New automation
            </Button>
            <Button variant="outline" onClick={() => void runAll()} disabled={runAllBusy} className="min-h-[44px]" aria-label="Run all automations now">
              {runAllBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <PlayCircle className="h-4 w-4" aria-hidden />}
              Run all now
            </Button>
            {!canManage && <p className="text-xs text-muted-foreground self-center">Only owners and admins can change automations — you have view access.</p>}
          </div>

          {loading ? (
            <div className="space-y-3" aria-label="Loading automations">
              {[0, 1].map((i) => <Skeleton key={i} className="h-36 w-full" />)}
            </div>
          ) : error ? (
            <Alert variant="destructive" role="alert">
              <ShieldAlert className="h-4 w-4" aria-hidden />
              <AlertDescription className="space-y-2">
                <p>{error}</p>
                <Button size="sm" variant="outline" onClick={() => void load()} className="min-h-[44px]">Retry</Button>
              </AlertDescription>
            </Alert>
          ) : automations.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center space-y-3">
                <Workflow className="h-8 w-8 mx-auto text-muted-foreground" aria-hidden />
                <p className="text-sm text-muted-foreground">
                  No automations yet. A good first one: “When an invoice becomes overdue, send a reminder after 1 day” — start it in test mode to watch what it would do.
                </p>
                {canManage && (
                  <Button onClick={() => { setEditor(emptyEditor()); setEditorOpen(true) }} className="min-h-[44px]">
                    <Plus className="h-4 w-4" aria-hidden /> Create an automation
                  </Button>
                )}
              </CardContent>
            </Card>
          ) : (
            <ul className="space-y-3" aria-label="Automation list">
              {automations.map((a) => {
                const conds = parseJson<Array<{ field: string; op: string; value: string | number }>>(a.conditions, [])
                const cfg = parseJson<Record<string, unknown>>(a.triggerCfg, {})
                return (
                  <li key={a.id}>
                    <Card>
                      <CardContent className="p-4 space-y-3">
                        <div className="flex flex-wrap items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-medium">{a.name}</p>
                              {a.testMode ? (
                                <Badge className="bg-amber-100 text-amber-900"><FlaskConical className="h-3 w-3 mr-1" aria-hidden /> TEST MODE</Badge>
                              ) : (
                                <Badge className="bg-emerald-100 text-emerald-900">LIVE</Badge>
                              )}
                            </div>
                            {a.description && <p className="text-sm text-muted-foreground mt-0.5">{a.description}</p>}
                          </div>
                          <label className="flex items-center gap-2 text-sm shrink-0">
                            <Switch
                              checked={a.enabled}
                              disabled={!canManage || busyId === a.id}
                              onCheckedChange={(v) => void toggleEnabled(a, v)}
                              aria-label={`${a.enabled ? 'Disable' : 'Enable'} ${a.name}`}
                            />
                            {a.enabled ? 'Enabled' : 'Paused'}
                          </label>
                        </div>

                        <div className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
                          <p><span className="text-muted-foreground">Trigger:</span> {TRIGGER_LABELS[a.triggerType] ?? a.triggerType}{a.triggerType === 'invoice_overdue' && Number(cfg.minDaysOverdue ?? 0) > 0 ? ` (+${String(cfg.minDaysOverdue)}d overdue)` : ''}</p>
                          <p><span className="text-muted-foreground">Delay before action:</span> {a.delayMinutes > 0 ? `${a.delayMinutes} min` : 'immediately'}</p>
                          <p><span className="text-muted-foreground">Quiet hours:</span> {quietLabel(a.quietHours)}</p>
                          <p><span className="text-muted-foreground">Max runs/day:</span> {a.maxRunsPerDay}</p>
                        </div>

                        <div className="flex flex-wrap gap-1.5" aria-label="Actions">
                          {describeActions(a).map((label, i) => (
                            <Badge key={i} variant="secondary" className="gap-1"><Zap className="h-3 w-3" aria-hidden /> {label}</Badge>
                          ))}
                          {conds.length > 0 && (
                            <Badge variant="outline" className="text-[10px]">
                              {conds.map((c) => `${c.field} ${c.op} ${String(c.value)}`).join(' AND ')}
                            </Badge>
                          )}
                        </div>

                        <Separator />

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void toggleHistory(a.id)}
                            aria-expanded={Boolean(historyOpen[a.id])}
                            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground min-h-[44px] px-1"
                            aria-label={`Toggle run history for ${a.name}`}
                          >
                            <History className="h-4 w-4" aria-hidden />
                            Run history
                            {historyOpen[a.id] ? <ChevronUp className="h-3.5 w-3.5" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}
                          </button>
                          <div className="ml-auto flex gap-2">
                            <Button
                              size="sm" variant="outline" disabled={!canManage}
                              onClick={() => { setEditor(editorFromAutomation(a)); setEditorOpen(true) }}
                              className="min-h-[44px]" aria-label={`Edit ${a.name}`}
                            >
                              <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
                            </Button>
                            <Button
                              size="sm" variant="ghost" disabled={!canManage}
                              onClick={() => setDeleteTarget(a)}
                              className="min-h-[44px] text-rose-700 hover:text-rose-800" aria-label={`Delete ${a.name}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete
                            </Button>
                          </div>
                        </div>

                        {historyOpen[a.id] && (
                          <div className="rounded-md border bg-muted/20 p-3">
                            {runsLoading[a.id] ? (
                              <Skeleton className="h-16 w-full" />
                            ) : runsError[a.id] ? (
                              <Alert variant="destructive" role="alert">
                                <AlertDescription>{runsError[a.id]}</AlertDescription>
                              </Alert>
                            ) : (runMap[a.id] ?? a.runs ?? []).length === 0 ? (
                              <p className="text-sm text-muted-foreground">No runs yet. Use “Run all now” or wait for the trigger (the worker checks every minute).</p>
                            ) : (
                              <ul className="space-y-2 max-h-96 overflow-y-auto" aria-label={`Run history for ${a.name}`}>
                                {(runMap[a.id] ?? a.runs ?? []).map((r) => {
                                  const out = parseJson<unknown>(r.output, r.output)
                                  const outText = typeof out === 'string' ? out : JSON.stringify(out, null, 2)
                                  return (
                                    <li key={r.id} className="rounded border bg-background p-2.5 text-sm space-y-1">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <Badge className={cn('text-[10px] px-1.5', RUN_BADGE[r.status] ?? 'bg-muted')}>{r.status}</Badge>
                                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                                          <Clock className="h-3 w-3" aria-hidden />
                                          scheduled {formatDateTime(r.scheduledFor)}
                                          {r.finishedAt ? ` · finished ${formatDateTime(r.finishedAt)}` : ''}
                                        </span>
                                      </div>
                                      {r.error && <p className="text-xs text-rose-700 break-words">{r.error}</p>}
                                      {outText && outText !== '{}' && (
                                        <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap break-words max-h-24 overflow-y-auto">{outText.slice(0, 500)}{outText.length > 500 ? '…' : ''}</pre>
                                      )}
                                    </li>
                                  )
                                })}
                              </ul>
                            )}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </li>
                )
              })}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="outbox" className="space-y-4 mt-4">
          <Alert className="border-amber-200 bg-amber-50 text-amber-900" role="note">
            <ShieldAlert className="h-4 w-4" aria-hidden />
            <AlertDescription>
              Outbound email/SMS delivery requires configuring a channel. Messages stay queued and visible here — nothing is silently dropped or faked.
            </AlertDescription>
          </Alert>

          {outboxLoading ? (
            <div className="space-y-2" aria-label="Loading outbox">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : outboxError ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="space-y-2">
                <p>{outboxError}</p>
                <Button size="sm" variant="outline" onClick={() => void loadOutbox()} className="min-h-[44px]">Retry</Button>
              </AlertDescription>
            </Alert>
          ) : outbox.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center space-y-2">
                <Inbox className="h-8 w-8 mx-auto text-muted-foreground" aria-hidden />
                <p className="text-sm text-muted-foreground">The outbox is empty. Reminders queued by automations appear here with their real delivery status.</p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <div className="max-h-96 overflow-y-auto">
                  <Table aria-label="Outbox messages">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Channel</TableHead>
                        <TableHead>Recipient</TableHead>
                        <TableHead className="hidden sm:table-cell">Subject</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="hidden md:table-cell">Created</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {outbox.map((m) => (
                        <TableRow key={m.id}>
                          <TableCell className="text-sm">{m.channel}</TableCell>
                          <TableCell className="text-sm break-all">{m.recipient || '—'}</TableCell>
                          <TableCell className="hidden sm:table-cell text-sm max-w-[240px]">
                            <p className="truncate">{m.subject}</p>
                            {m.statusReason && <p className="text-xs text-muted-foreground truncate">{m.statusReason}</p>}
                          </TableCell>
                          <TableCell>
                            <Badge className={cn('text-[10px] px-1.5', OUTBOX_BADGE[m.status] ?? 'bg-muted')}>{m.status}</Badge>
                            {m.statusReason && <p className="text-[10px] text-muted-foreground mt-1 max-w-[160px] sm:hidden">{m.statusReason}</p>}
                          </TableCell>
                          <TableCell className="hidden md:table-cell text-xs text-muted-foreground">{formatDateTime(m.createdAt)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* editor dialog */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editor.id ? 'Edit automation' : 'New automation'}</DialogTitle>
            <DialogDescription>
              Define when it fires and what it does. Start in test mode to watch runs without messaging anyone.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="autoName">Name</Label>
                <Input id="autoName" value={editor.name} onChange={(e) => setEditor((s) => ({ ...s, name: e.target.value }))} placeholder="Overdue invoice reminders" className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="autoTrigger">Trigger</Label>
                <Select value={editor.triggerType} onValueChange={(v) => setEditor((s) => ({ ...s, triggerType: v }))}>
                  <SelectTrigger id="autoTrigger" className="min-h-[44px]" aria-label="Automation trigger">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(TRIGGER_LABELS).map(([k, label]) => (
                      <SelectItem key={k} value={k}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="autoDesc">Description (optional)</Label>
              <Input id="autoDesc" value={editor.description} onChange={(e) => setEditor((s) => ({ ...s, description: e.target.value }))} className="min-h-[44px]" />
            </div>

            {editor.triggerType === 'invoice_overdue' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="autoMinDays">Minimum days overdue</Label>
                  <Input
                    id="autoMinDays" type="number" min={0} value={editor.minDaysOverdue}
                    onChange={(e) => setEditor((s) => ({ ...s, minDaysOverdue: Number(e.target.value) }))}
                    className="min-h-[44px]"
                  />
                </div>
                <label className="flex items-center gap-2 text-sm rounded-md border p-3">
                  <Switch checked={editor.requireOutstanding} onCheckedChange={(v) => setEditor((s) => ({ ...s, requireOutstanding: v }))} aria-label="Only invoices with an outstanding balance" />
                  Only invoices with an outstanding balance (&gt; 0)
                </label>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="autoDelay">Delay before action (min)</Label>
                <Input id="autoDelay" type="number" min={0} value={editor.delayMinutes} onChange={(e) => setEditor((s) => ({ ...s, delayMinutes: Number(e.target.value) }))} className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="autoMaxRuns">Max runs / day</Label>
                <Input id="autoMaxRuns" type="number" min={1} value={editor.maxRunsPerDay} onChange={(e) => setEditor((s) => ({ ...s, maxRunsPerDay: Number(e.target.value) }))} className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label>Quiet hours</Label>
                <div className="flex gap-2">
                  <Input aria-label="Quiet hours start" placeholder="21:00" value={editor.quietStart} onChange={(e) => setEditor((s) => ({ ...s, quietStart: e.target.value }))} className="min-h-[44px]" />
                  <Input aria-label="Quiet hours end" placeholder="08:00" value={editor.quietEnd} onChange={(e) => setEditor((s) => ({ ...s, quietEnd: e.target.value }))} className="min-h-[44px]" />
                </div>
              </div>
            </div>

            {/* conditions */}
            <div className="space-y-2">
              <Label>Extra conditions (optional)</Label>
              {editor.extraConditions.map((c) => (
                <div key={c.key} className="grid grid-cols-[1fr_84px_1fr_44px] gap-2 items-center">
                  <Input aria-label="Condition field" placeholder="field (e.g. totalCents)" value={c.field} onChange={(e) => setEditor((s) => ({ ...s, extraConditions: s.extraConditions.map((x) => x.key === c.key ? { ...x, field: e.target.value } : x) }))} className="min-h-[44px]" />
                  <Select value={c.op} onValueChange={(v) => setEditor((s) => ({ ...s, extraConditions: s.extraConditions.map((x) => x.key === c.key ? { ...x, op: v } : x) }))}>
                    <SelectTrigger aria-label="Condition operator" className="min-h-[44px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="gt">&gt;</SelectItem>
                      <SelectItem value="lt">&lt;</SelectItem>
                      <SelectItem value="eq">=</SelectItem>
                      <SelectItem value="neq">≠</SelectItem>
                      <SelectItem value="contains">contains</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input aria-label="Condition value" placeholder="value" value={c.value} onChange={(e) => setEditor((s) => ({ ...s, extraConditions: s.extraConditions.map((x) => x.key === c.key ? { ...x, value: e.target.value } : x) }))} className="min-h-[44px]" />
                  <Button
                    type="button" variant="ghost" size="icon" aria-label="Remove condition" className="min-h-[44px] min-w-[44px]"
                    onClick={() => setEditor((s) => ({ ...s, extraConditions: s.extraConditions.filter((x) => x.key !== c.key) }))}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              ))}
              <Button
                type="button" variant="outline" size="sm" className="min-h-[44px]"
                onClick={() => setEditor((s) => ({ ...s, extraConditions: [...s.extraConditions, { key: actionKey++, field: '', op: 'gt', value: '0' }] }))}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden /> Add condition
              </Button>
            </div>

            {/* actions */}
            <div className="space-y-2">
              <Label>Actions</Label>
              {editor.actions.map((a) => (
                <div key={a.key} className="rounded-md border p-3 space-y-2">
                  <div className="grid grid-cols-[1fr_44px] gap-2 items-center">
                    <Select value={a.type} onValueChange={(v) => setEditor((s) => ({ ...s, actions: s.actions.map((x) => x.key === a.key ? { ...x, type: v } : x) }))}>
                      <SelectTrigger aria-label="Action type" className="min-h-[44px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(ACTION_LABELS).map(([k, label]) => (
                          <SelectItem key={k} value={k}>{label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button" variant="ghost" size="icon" aria-label="Remove action" className="min-h-[44px] min-w-[44px]"
                      disabled={editor.actions.length <= 1}
                      onClick={() => setEditor((s) => ({ ...s, actions: s.actions.filter((x) => x.key !== a.key) }))}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  </div>
                  {a.type === 'send_invoice_reminder' && (
                    <>
                      <div className="space-y-1.5">
                        <Label>Channel</Label>
                        <Select value={a.channel} onValueChange={(v) => setEditor((s) => ({ ...s, actions: s.actions.map((x) => x.key === a.key ? { ...x, channel: v } : x) }))}>
                          <SelectTrigger aria-label="Reminder channel" className="min-h-[44px]"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="email">Email</SelectItem>
                            <SelectItem value="sms">SMS</SelectItem>
                            <SelectItem value="inapp">In-app</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`tpl-${a.key}`}>Message template</Label>
                        <Textarea
                          id={`tpl-${a.key}`} rows={3} value={a.template}
                          onChange={(e) => setEditor((s) => ({ ...s, actions: s.actions.map((x) => x.key === a.key ? { ...x, template: e.target.value } : x) }))}
                          placeholder={'Hi {{customer_name}}, invoice {{invoice_number}} ({{amount_due}}) was due on {{due_date}}. — {{business_name}}'}
                        />
                        <p className="text-xs text-muted-foreground">Placeholders: {'{{customer_name}} {{invoice_number}} {{amount_due}} {{due_date}} {{business_name}} {{payment_link}}'}</p>
                      </div>
                    </>
                  )}
                  {a.type === 'notify_inapp' && (
                    <div className="space-y-1.5">
                      <Label htmlFor={`body-${a.key}`}>Notification text</Label>
                      <Textarea
                        id={`body-${a.key}`} rows={2} value={a.body}
                        onChange={(e) => setEditor((s) => ({ ...s, actions: s.actions.map((x) => x.key === a.key ? { ...x, body: e.target.value } : x) }))}
                        placeholder="A conversation was escalated — check the inbox."
                      />
                    </div>
                  )}
                  {a.type === 'send_email' && (
                    <>
                      <div className="space-y-1.5">
                        <Label htmlFor={`esubj-${a.key}`}>Subject (optional)</Label>
                        <Input
                          id={`esubj-${a.key}`} value={a.subject}
                          onChange={(e) => setEditor((s) => ({ ...s, actions: s.actions.map((x) => x.key === a.key ? { ...x, subject: e.target.value } : x) }))}
                          placeholder="Update on {{invoice_number}} — {{business_name}}"
                          className="min-h-[44px]"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`ebody-${a.key}`}>Email body</Label>
                        <Textarea
                          id={`ebody-${a.key}`} rows={3} value={a.body}
                          onChange={(e) => setEditor((s) => ({ ...s, actions: s.actions.map((x) => x.key === a.key ? { ...x, body: e.target.value } : x) }))}
                          placeholder={'Hi {{customer_name}}, your booking for {{service_name}} at {{start_time}} is confirmed. — {{business_name}}'}
                        />
                        <p className="text-xs text-muted-foreground">Placeholders: {'{{customer_name}} {{business_name}} {{invoice_number}} {{amount_due}} {{due_date}} {{service_name}} {{start_time}}'}</p>
                      </div>
                    </>
                  )}
                  {a.type === 'send_sms' && (
                    <div className="space-y-1.5">
                      <Label htmlFor={`sbody-${a.key}`}>SMS text</Label>
                      <Textarea
                        id={`sbody-${a.key}`} rows={2} maxLength={160} value={a.body}
                        onChange={(e) => setEditor((s) => ({ ...s, actions: s.actions.map((x) => x.key === a.key ? { ...x, body: e.target.value } : x) }))}
                        placeholder={'Hi {{customer_name}} — reminder for {{service_name}} at {{start_time}}. — {{business_name}}'}
                      />
                      <p className="text-xs text-muted-foreground">{a.body.length}/160 characters — keep it to one SMS segment. Same placeholders as email.</p>
                    </div>
                  )}
                  {a.type === 'send_webhook' && (
                    <>
                      <div className="space-y-1.5">
                        <Label>Destination</Label>
                        <Select
                          value={a.destinationId || undefined}
                          onValueChange={(v) => setEditor((s) => ({ ...s, actions: s.actions.map((x) => x.key === a.key ? { ...x, destinationId: v } : x) }))}
                        >
                          <SelectTrigger aria-label="Webhook destination" className="min-h-[44px]">
                            <SelectValue placeholder="Choose a webhook destination…" />
                          </SelectTrigger>
                          <SelectContent>
                            {webhookDests.length === 0 ? (
                              <SelectItem value="__unavailable" disabled>No destinations configured — add one in Integrations</SelectItem>
                            ) : (
                              webhookDests.map((w) => (
                                <SelectItem key={w.id} value={w.id}>
                                  <span className="block max-w-[280px] truncate">{w.url}</span>
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                          Destinations live in Integrations → Webhooks. Posts carry an x-signature header when a signing secret is set.
                          {a.destinationId === '' && ' Without a destination the run is skipped (logged honestly).'}
                        </p>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`wbody-${a.key}`}>Payload message (optional)</Label>
                        <Textarea
                          id={`wbody-${a.key}`} rows={2} value={a.body}
                          onChange={(e) => setEditor((s) => ({ ...s, actions: s.actions.map((x) => x.key === a.key ? { ...x, body: e.target.value } : x) }))}
                          placeholder={'Optional template text stored with the event payload'}
                        />
                        <p className="text-xs text-muted-foreground">
                          The dispatcher POSTs the standard automation payload (event, automation name, trigger input) to the destination URL.
                        </p>
                      </div>
                    </>
                  )}
                  {a.type === 'flag_for_review' && (
                    <p className="text-xs text-muted-foreground">Marks the related record for a human to review. No message is sent.</p>
                  )}
                </div>
              ))}
              <Button
                type="button" variant="outline" size="sm" className="min-h-[44px]"
                onClick={() => setEditor((s) => ({ ...s, actions: [...s.actions, newAction()] }))}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden /> Add action
              </Button>
            </div>

            <div className="space-y-2 rounded-md border p-3">
              <label className="flex items-start gap-3 text-sm">
                <Switch checked={editor.testMode} onCheckedChange={(v) => setEditor((s) => ({ ...s, testMode: v }))} aria-label="Test mode" />
                <span>
                  <span className="font-medium">Test mode (recommended first)</span>
                  <span className="block text-xs text-muted-foreground">Logs what would happen without messaging customers.</span>
                </span>
              </label>
              <Separator />
              <label className="flex items-center gap-3 text-sm">
                <Switch checked={editor.enabled} onCheckedChange={(v) => setEditor((s) => ({ ...s, enabled: v }))} aria-label="Enabled" />
                Enabled — the worker checks this rule every minute.
              </label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)} className="min-h-[44px]">Cancel</Button>
            <Button onClick={() => void saveEditor()} disabled={saving || !editor.name.trim()} className="min-h-[44px]">
              {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {editor.id ? 'Save changes' : 'Create automation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* delete confirm */}
      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The rule and its run history are removed. Scheduled reminders that have not run yet are cancelled.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-[44px]">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void deleteAutomation() }}
              disabled={deleting}
              className="min-h-[44px] bg-rose-700 text-white hover:bg-rose-800"
            >
              {deleting && <Loader2 className="h-4 w-4 animate-spin mr-2" aria-hidden />}
              Delete automation
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
