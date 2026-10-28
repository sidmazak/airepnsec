'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, formatDateTime, type DataSourceKindInfo, type DataSourceRow, type DataSourceTestResult } from '@/lib/client/api'
import { useAppStore } from '@/lib/client/store'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Database, Plus, RefreshCw, Loader2, Pencil, Trash2, PlugZap, ShieldAlert, CheckCircle2, XCircle, Table2,
} from 'lucide-react'

type FormState = {
  id: string | null
  name: string
  kind: string
  connection: Record<string, string>
  query: string
  table: string
  itemsPath: string
  idColumn: string
  titleColumn: string
  textColumns: string
  template: string
  contentPrefix: string
  limit: string
  approved: boolean
  allowPrivate: boolean
}

const EMPTY_FORM: FormState = {
  id: null, name: '', kind: 'postgres', connection: {},
  query: '', table: '', itemsPath: '', idColumn: 'id', titleColumn: '', textColumns: '',
  template: '', contentPrefix: '', limit: '500', approved: true, allowPrivate: false,
}

export function DataSourcesSection() {
  const { toast } = useToast()
  const role = useAppStore((s) => s.session?.user?.role)
  const canManage = role === 'owner' || role === 'admin'

  const [sources, setSources] = useState<DataSourceRow[]>([])
  const [kinds, setKinds] = useState<DataSourceKindInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DataSourceRow | null>(null)
  const [deleting, setDeleting] = useState(false)

  const [busyId, setBusyId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, DataSourceTestResult>>({})

  const load = useCallback(async (showSkeleton = true) => {
    if (showSkeleton) setLoading(true)
    try {
      const d = await api.get<{ sources: DataSourceRow[]; kinds: DataSourceKindInfo[] }>('/api/datasources')
      setSources(d.sources)
      setKinds(d.kinds)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load data sources')
    } finally {
      if (showSkeleton) setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const kindInfo = (kind: string) => kinds.find((k) => k.kind === kind)

  const openNew = () => {
    setForm({ ...EMPTY_FORM, kind: kinds[0]?.kind ?? 'postgres', connection: {} })
    setFormOpen(true)
  }

  const openEdit = (s: DataSourceRow) => {
    const cfg = s.config as Record<string, unknown>
    const get = (k: string) => (typeof cfg[k] === 'string' ? (cfg[k] as string) : '')
    setForm({
      id: s.id,
      name: s.name,
      kind: s.kind,
      connection: {},
      query: get('query'),
      table: get('table'),
      itemsPath: get('itemsPath'),
      idColumn: get('idColumn') || 'id',
      titleColumn: get('titleColumn'),
      textColumns: Array.isArray(cfg.textColumns) ? (cfg.textColumns as string[]).join(', ') : '',
      template: get('template'),
      contentPrefix: get('contentPrefix'),
      limit: typeof cfg.limit === 'number' ? String(cfg.limit) : '500',
      approved: cfg.approved !== false,
      allowPrivate: Boolean(cfg.allowPrivate),
    })
    setFormOpen(true)
  }

  const buildConfig = () => {
    const cfg: Record<string, unknown> = {
      idColumn: form.idColumn.trim() || undefined,
      titleColumn: form.titleColumn.trim() || undefined,
      textColumns: form.textColumns.split(',').map((t) => t.trim()).filter(Boolean),
      template: form.template.trim() || undefined,
      contentPrefix: form.contentPrefix.trim() || undefined,
      limit: Number(form.limit) || 500,
      approved: form.approved,
      allowPrivate: form.allowPrivate,
    }
    if (form.kind === 'http_json') cfg.itemsPath = form.itemsPath.trim() || undefined
    else {
      cfg.query = form.query.trim() || undefined
      cfg.table = form.table.trim() || undefined
    }
    return cfg
  }

  const save = async () => {
    setSaving(true)
    try {
      const config = buildConfig()
      if (form.id) {
        const patch: Record<string, unknown> = { name: form.name.trim(), config }
        const typedConnection = Object.fromEntries(Object.entries(form.connection).filter(([, v]) => v.trim() !== ''))
        if (Object.keys(typedConnection).length > 0) patch.connection = typedConnection
        await api.patch(`/api/datasources/${form.id}`, patch)
        toast({ title: 'Data source updated' })
      } else {
        await api.post('/api/datasources', {
          name: form.name.trim(),
          kind: form.kind,
          connection: form.connection,
          config,
        })
        toast({ title: 'Data source added', description: 'Test the connection, then run a sync to index its rows.' })
      }
      setFormOpen(false)
      await load(false)
    } catch (err) {
      toast({ title: 'Save failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const toggleEnabled = async (s: DataSourceRow, enabled: boolean) => {
    setBusyId(s.id)
    try {
      await api.patch(`/api/datasources/${s.id}`, { enabled })
      await load(false)
    } catch (err) {
      toast({ title: 'Could not update', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setBusyId(null)
    }
  }

  const test = async (s: DataSourceRow) => {
    setBusyId(s.id)
    try {
      const d = await api.post<{ result: DataSourceTestResult }>(`/api/datasources/${s.id}/test`)
      setTestResults((t) => ({ ...t, [s.id]: d.result }))
      toast({
        title: d.result.ok ? 'Connection OK' : 'Connection failed',
        description: d.result.message,
        variant: d.result.ok ? 'default' : 'destructive',
      })
      await load(false)
    } catch (err) {
      toast({ title: 'Test failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setBusyId(null)
    }
  }

  const sync = async (s: DataSourceRow) => {
    setBusyId(s.id)
    try {
      const d = await api.post<{ message: string }>(`/api/datasources/${s.id}/sync`)
      toast({ title: 'Sync complete', description: d.message })
      await load(false)
    } catch (err) {
      toast({ title: 'Sync failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setBusyId(null)
    }
  }

  const remove = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api.delete(`/api/datasources/${deleteTarget.id}`)
      toast({ title: 'Data source deleted', description: 'Its ingested documents were removed from the index.' })
      setDeleteTarget(null)
      await load(false)
    } catch (err) {
      toast({ title: 'Delete failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setDeleting(false)
    }
  }

  const activeKind = kindInfo(form.kind)

  return (
    <div className="space-y-4" aria-label="External data sources for RAG">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <h2 className="text-lg font-semibold tracking-tight">Data Sources</h2>
          <p className="text-sm text-muted-foreground">
            Connect your own database or JSON API. Rows are extracted, chunked and embedded into the same RAG pipeline the assistant answers from.
          </p>
        </div>
        {canManage && (
          <Button onClick={openNew} className="min-h-[44px]" aria-label="Add a data source" title="Add a data source">
            <Plus className="h-4 w-4" aria-hidden /> Add data source
          </Button>
        )}
      </div>

      {!canManage && (
        <Alert>
          <ShieldAlert className="h-4 w-4" aria-hidden />
          <AlertDescription>Viewing only. Ask an owner or admin to add or change data sources.</AlertDescription>
        </Alert>
      )}

      {loading ? (
        <div className="space-y-3" aria-label="Loading data sources">
          {[0, 1].map((i) => <Skeleton key={i} className="h-32 w-full" />)}
        </div>
      ) : error ? (
        <Alert variant="destructive" role="alert">
          <ShieldAlert className="h-4 w-4" aria-hidden />
          <AlertDescription className="space-y-2">
            <p>{error}</p>
            <Button size="sm" variant="outline" onClick={() => void load()} className="min-h-[44px]" title="Retry">Retry</Button>
          </AlertDescription>
        </Alert>
      ) : sources.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center space-y-3">
            <Database className="h-8 w-8 mx-auto text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              No external data sources yet. Add a PostgreSQL, MySQL or SQLite database, or a JSON HTTP endpoint,
              and the assistant will answer from its rows — using your existing embedding model.
            </p>
            {canManage && <Button onClick={openNew} className="min-h-[44px]" title="Add your first data source"><Plus className="h-4 w-4" aria-hidden /> Add your first data source</Button>}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {sources.map((s) => {
            const tr = testResults[s.id]
            const busy = busyId === s.id
            return (
              <Card key={s.id} className="flex flex-col">
                <CardHeader className="pb-2">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <CardTitle className="text-base truncate">{s.name}</CardTitle>
                      <CardDescription className="flex items-center gap-1.5 mt-0.5">
                        <Badge variant="secondary" className="font-mono text-[11px]">{s.kind}</Badge>
                        {s.enabled ? (
                          <Badge className="bg-emerald-100 text-emerald-900">Enabled</Badge>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground">Disabled</Badge>
                        )}
                        {s.autoSync && <Badge variant="outline">auto {s.syncIntervalMin}m</Badge>}
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 flex-1 flex flex-col">
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    <p>{s.documentCount} document{s.documentCount === 1 ? '' : 's'} · {s.chunkCount} chunk{s.chunkCount === 1 ? '' : 's'} indexed</p>
                    {s.lastSyncAt && (
                      <p>
                        Last sync {formatDateTime(s.lastSyncAt)} ·{' '}
                        {s.lastSyncOk ? 'succeeded' : <span className="text-rose-700">failed</span>}
                        {s.lastSyncStats?.fetched != null && ` · ${s.lastSyncStats.fetched} rows`}
                      </p>
                    )}
                    {!s.lastSyncAt && <p>Never synced yet.</p>}
                    {s.lastSyncError && <p className="text-rose-700 line-clamp-2">{s.lastSyncError}</p>}
                  </div>

                  {s.lastTestAt && !tr && (
                    <p className="text-xs flex items-center gap-1.5">
                      {s.lastTestOk
                        ? <><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden /> <span className="text-muted-foreground">Last test passed {formatDateTime(s.lastTestAt)}</span></>
                        : <><XCircle className="h-3.5 w-3.5 text-rose-600" aria-hidden /> <span className="text-rose-700">Last test failed: {s.lastTestError}</span></>}
                    </p>
                  )}

                  {tr && (
                    <Alert className={tr.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'} role="status">
                      <AlertDescription className="text-xs space-y-1">
                        <p className="font-medium">{tr.ok ? 'Connection verified' : 'Connection failed'}</p>
                        <p>{tr.message}</p>
                        {tr.ok && tr.columns && tr.columns.length > 0 && (
                          <p className="flex items-center gap-1"><Table2 className="h-3 w-3" aria-hidden /> Columns: {tr.columns.slice(0, 8).join(', ')}{tr.columns.length > 8 ? '…' : ''}</p>
                        )}
                        {tr.ok && tr.preview && tr.preview.length > 0 && (
                          <details className="mt-1">
                            <summary className="cursor-pointer">Preview first {tr.preview.length} row(s)</summary>
                            <pre className="mt-1 max-h-40 overflow-auto rounded bg-background/60 p-2 text-[10px] whitespace-pre-wrap break-words">
                              {JSON.stringify(tr.preview, null, 2)}
                            </pre>
                          </details>
                        )}
                      </AlertDescription>
                    </Alert>
                  )}

                  <div className="mt-auto pt-1 space-y-2">
                    {canManage && (
                      <div className="flex items-center gap-2">
                        <Switch
                          id={`enable-${s.id}`}
                          checked={s.enabled}
                          disabled={busy || !s.configured}
                          onCheckedChange={(v) => void toggleEnabled(s, v)}
                          aria-label={s.enabled ? `Disable ${s.name}` : `Enable ${s.name}`}
                        />
                        <Label htmlFor={`enable-${s.id}`} className="text-xs cursor-pointer">
                          {s.configured ? 'Enabled for retrieval' : 'Add a connection to enable'}
                        </Label>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => void test(s)} disabled={busy} className="min-h-[44px]" aria-label={`Test connection for ${s.name}`} title={`Test connection for ${s.name}`}>
                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <PlugZap className="h-3.5 w-3.5" aria-hidden />} Test
                      </Button>
                      <Button size="sm" onClick={() => void sync(s)} disabled={!canManage || busy} className="min-h-[44px]" aria-label={`Sync ${s.name} now`} title={`Sync ${s.name} now`}>
                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />} Sync now
                      </Button>
                      {canManage && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => openEdit(s)} className="min-h-[44px]" aria-label={`Edit ${s.name}`} title={`Edit ${s.name}`}>
                            <Pencil className="h-3.5 w-3.5" aria-hidden />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(s)} className="min-h-[44px] text-rose-700 hover:text-rose-800" aria-label={`Delete ${s.name}`} title={`Delete ${s.name}`}>
                            <Trash2 className="h-3.5 w-3.5" aria-hidden />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">How this works</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground space-y-1.5">
          <p>Rows are extracted with a <strong>read-only</strong> query you provide (only SELECT/WITH, capped result set) or a JSON endpoint, then each row becomes a knowledge document.</p>
          <p>Documents are chunked and embedded with your <strong>current embedding provider</strong> (local neural by default) — no separate configuration needed. Changing the embedding model later requires a knowledge reindex.</p>
          <p>Connection strings and credentials are encrypted at rest (AES-256-GCM) and never returned to the browser. Retrieved text is treated as untrusted content, never as instructions.</p>
          <p>Re-syncing is idempotent: unchanged rows are skipped and rows removed from the source are deleted from the index.</p>
        </CardContent>
      </Card>

      {/* create / edit dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{form.id ? 'Edit data source' : 'New data source'}</DialogTitle>
            <DialogDescription>
              Point the assistant at your own database. Credentials are encrypted and never leave this server in plaintext.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="dsName">Name</Label>
                <Input id="dsName" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Product catalog" className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dsKind">Type</Label>
                <select
                  id="dsKind"
                  value={form.kind}
                  disabled={Boolean(form.id)}
                  onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value, connection: {} }))}
                  className="w-full min-h-[44px] rounded-md border bg-background px-3 text-sm disabled:opacity-60"
                >
                  {kinds.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                </select>
              </div>
            </div>

            {activeKind && (
              <p className="text-xs text-muted-foreground">{activeKind.connectionSummary}. {activeKind.notes}</p>
            )}

            <Separator />

            <div className="space-y-3">
              <p className="text-sm font-medium">{form.id ? 'Connection (leave blank to keep current credentials)' : 'Connection'}</p>
              {activeKind?.secretFields.map((fld) => (
                <div key={fld.key} className="space-y-1.5">
                  <Label htmlFor={`dsConn-${fld.key}`}>{fld.label}{fld.required && !form.id ? '' : ' (optional)'}</Label>
                  <Input
                    id={`dsConn-${fld.key}`}
                    type={fld.key.toLowerCase().includes('password') || fld.key === 'authHeader' ? 'password' : 'text'}
                    value={form.connection[fld.key] ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, connection: { ...f.connection, [fld.key]: e.target.value } }))}
                    placeholder={fld.placeholder}
                    className="min-h-[44px]"
                    autoComplete="off"
                  />
                </div>
              ))}
            </div>

            <Separator />

            <div className="space-y-3">
              {form.kind === 'http_json' ? (
                <div className="space-y-1.5">
                  <Label htmlFor="dsItemsPath">Items path (optional)</Label>
                  <Input id="dsItemsPath" value={form.itemsPath} onChange={(e) => setForm((f) => ({ ...f, itemsPath: e.target.value }))} placeholder={activeKind?.configHints.queryHint} className="min-h-[44px]" />
                </div>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="dsQuery">{activeKind?.configHints.queryLabel ?? 'Query'}</Label>
                    <Textarea id="dsQuery" rows={3} value={form.query} onChange={(e) => setForm((f) => ({ ...f, query: e.target.value }))} placeholder={activeKind?.configHints.queryHint} className="font-mono text-xs" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="dsTable">…or table name (used if the query is empty)</Label>
                    <Input id="dsTable" value={form.table} onChange={(e) => setForm((f) => ({ ...f, table: e.target.value }))} placeholder="articles" className="min-h-[44px]" />
                  </div>
                </>
              )}

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="dsIdCol">ID column</Label>
                  <Input id="dsIdCol" value={form.idColumn} onChange={(e) => setForm((f) => ({ ...f, idColumn: e.target.value }))} placeholder={activeKind?.configHints.idColumnHint} className="min-h-[44px]" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="dsTitleCol">Title column</Label>
                  <Input id="dsTitleCol" value={form.titleColumn} onChange={(e) => setForm((f) => ({ ...f, titleColumn: e.target.value }))} placeholder="title" className="min-h-[44px]" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="dsLimit">Max rows</Label>
                  <Input id="dsLimit" type="number" min="1" max="5000" value={form.limit} onChange={(e) => setForm((f) => ({ ...f, limit: e.target.value }))} className="min-h-[44px]" />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="dsTextCols">Text columns (comma separated — blank = all columns)</Label>
                <Input id="dsTextCols" value={form.textColumns} onChange={(e) => setForm((f) => ({ ...f, textColumns: e.target.value }))} placeholder="title, description, body" className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dsTemplate">Template (optional — {'{{column}}'} placeholders)</Label>
                <Textarea id="dsTemplate" rows={2} value={form.template} onChange={(e) => setForm((f) => ({ ...f, template: e.target.value }))} placeholder="{{title}}\n{{body}}" className="font-mono text-xs" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dsPrefix">Content prefix (optional)</Label>
                <Input id="dsPrefix" value={form.contentPrefix} onChange={(e) => setForm((f) => ({ ...f, contentPrefix: e.target.value }))} placeholder="Returns policy" className="min-h-[44px]" />
              </div>

              <div className="flex flex-wrap gap-4 pt-1">
                <div className="flex items-center gap-2">
                  <Switch id="dsApproved" checked={form.approved} onCheckedChange={(v) => setForm((f) => ({ ...f, approved: v }))} aria-label="Approve for AI use" />
                  <Label htmlFor="dsApproved" className="text-sm cursor-pointer">Approved for AI use</Label>
                </div>
                {form.kind === 'http_json' && (
                  <div className="flex items-center gap-2">
                    <Switch id="dsPrivate" checked={form.allowPrivate} onCheckedChange={(v) => setForm((f) => ({ ...f, allowPrivate: v }))} aria-label="Allow private addresses" />
                    <Label htmlFor="dsPrivate" className="text-sm cursor-pointer">Allow private/local addresses</Label>
                  </div>
                )}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} className="min-h-[44px]" title="Cancel">Cancel</Button>
            <Button onClick={() => void save()} disabled={saving || !form.name.trim()} className="min-h-[44px]" title={form.id ? 'Save data source changes' : 'Add data source'}>
              {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" aria-hidden />}
              {form.id ? 'Save changes' : 'Add source'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The connection is removed and all {deleteTarget?.documentCount ?? 0} ingested document(s) are deleted from the search index.
              Your external database is not modified.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-[44px]">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void remove() }}
              disabled={deleting}
              className="min-h-[44px] bg-rose-700 text-white hover:bg-rose-800"
            >
              {deleting && <Loader2 className="h-4 w-4 animate-spin mr-2" aria-hidden />}
              Delete source
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
