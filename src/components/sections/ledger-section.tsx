'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/lib/client/store'
import { api, ApiClientError, formatMoney, formatDateTime, type LedgerEntryRow, type AuditRow } from '@/lib/client/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import {
  ArrowRight, BookOpen, Download, FileClock, Loader2, RefreshCw, Scale, Undo2,
} from 'lucide-react'

/* ---------------- badges & helpers ---------------- */

const ENTRY_TYPE_CLASS: Record<string, string> = {
  payment: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-900',
  charge: 'bg-neutral-700 text-white border-neutral-700',
  reversal: 'bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-900',
  adjustment: 'bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-900',
}

const ACTOR_CLASS: Record<string, string> = {
  user: 'bg-muted text-muted-foreground border-border',
  system: 'bg-neutral-700 text-white border-neutral-700',
  ai: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-900',
  webhook: 'bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-900',
}

const ACCOUNT_DESCRIPTIONS: Record<string, string> = {
  accounts_receivable: 'Money owed to you — invoices issued but not yet paid.',
  cash: 'Money actually received (verified payments only).',
  revenue: 'Invoiced value you have recognized. Credits mean value earned.',
}

function friendlyError(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError && err.message) return err.message
  if (err instanceof Error && err.message) return err.message
  return fallback
}

type LedgerRow = LedgerEntryRow & { invoiceNumber?: string | null; createdBy?: string }
type Balance = { account: string; debitCents: number; creditCents: number; netCents: number }
type AuditEvent = AuditRow

function prettyMeta(meta: string): string {
  if (!meta) return '—'
  try {
    return JSON.stringify(JSON.parse(meta), null, 2)
  } catch {
    return meta
  }
}

/* ---------------- reverse dialog ---------------- */

function ReverseEntryDialog({
  entry, onClose, onChanged,
}: { entry: LedgerRow | null; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast()
  const [memo, setMemo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { if (entry) { setMemo(''); setError('') } }, [entry])

  const submit = async () => {
    if (!entry) return
    setBusy(true)
    setError('')
    try {
      await api.post(`/api/ledger/${entry.id}/reverse`, { memo: memo.trim() || undefined })
      toast({ title: 'Entry reversed', description: `Mirror entry posted against ${entry.type} of ${formatMoney(entry.amountCents)}` })
      onChanged()
      onClose()
    } catch (err) {
      setError(friendlyError(err, 'Could not reverse entry'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open={!!entry} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reverse this ledger entry?</AlertDialogTitle>
          <AlertDialogDescription>
            {entry
              ? `Posts one mirror entry (${entry.creditAccount} → ${entry.debitAccount}, ${formatMoney(entry.amountCents)}) that exactly cancels it. The original is never edited or deleted — the audit trail stays intact.`
              : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="space-y-1.5">
          <Label htmlFor="reverse-memo">Memo (why is this being reversed?)</Label>
          <Input
            id="reverse-memo"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="e.g. Duplicate charge; payment bounced"
            className="min-h-[44px]"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-[44px]">Keep entry</AlertDialogCancel>
          <AlertDialogAction
            className="min-h-[44px] bg-destructive text-white hover:bg-destructive/90"
            disabled={busy}
            onClick={(e) => { e.preventDefault(); void submit() }}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Undo2 className="h-4 w-4" aria-hidden />}
            Post reversal
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/* ---------------- entries tab ---------------- */

function EntriesTab({ onChanged }: { onChanged: () => void }) {
  const session = useAppStore((s) => s.session)
  const setActiveSection = useAppStore((s) => s.setActiveSection)
  const isAdmin = session?.user?.role === 'owner' || session?.user?.role === 'admin'
  const [entries, setEntries] = useState<LedgerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reverseTarget, setReverseTarget] = useState<LedgerRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.get<{ entries: LedgerRow[] }>('/api/ledger?limit=200')
      setEntries(res.entries)
    } catch (err) {
      setError(friendlyError(err, 'Could not load ledger entries'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (loading) {
    return <div className="space-y-2" aria-busy="true"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
  }
  if (error) {
    return (
      <div className="space-y-3">
        <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>
        <Button className="min-h-[44px]" onClick={() => void load()}><RefreshCw className="h-4 w-4" aria-hidden /> Retry</Button>
      </div>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><BookOpen className="h-4 w-4" aria-hidden /> Double-entry ledger</CardTitle>
        <CardDescription>Every money movement as debit → credit. Entries are append-only; corrections are reversals, never edits.</CardDescription>
        <div className="flex flex-wrap gap-2 pt-2">
          <Button variant="outline" className="min-h-[44px]" onClick={() => window.open('/api/ledger/export', '_blank')}>
            <Download className="h-4 w-4" aria-hidden /> Export CSV
          </Button>
          <Button variant="outline" className="min-h-[44px]" onClick={() => { void load(); onChanged() }} aria-label="Refresh ledger">
            <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No ledger entries yet — they appear automatically when you issue invoices and payments are verified.
          </p>
        ) : (
          <div className="max-h-96 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="hidden md:table-cell">Debit → Credit</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="hidden lg:table-cell">Memo</TableHead>
                  <TableHead>Invoice</TableHead>
                  {isAdmin && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={e.id} className={cn(e.reversalOfId && 'opacity-80')}>
                    <TableCell className="whitespace-nowrap">{formatDateTime(e.ts)}</TableCell>
                    <TableCell>
                      <span className="flex flex-wrap gap-1">
                        <Badge variant="outline" className={cn(ENTRY_TYPE_CLASS[e.type] ?? 'bg-muted text-muted-foreground')}>{e.type}</Badge>
                        {e.reversalOfId && (
                          <Badge variant="outline" className="bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950/60 dark:text-rose-300">reversal</Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <span className="inline-flex items-center gap-1 text-sm">
                        {e.debitAccount} <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden /> {e.creditAccount}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-medium">{formatMoney(e.amountCents)}</TableCell>
                    <TableCell className="hidden lg:table-cell max-w-[240px]"><span className="block truncate" title={e.memo}>{e.memo || '—'}</span></TableCell>
                    <TableCell>
                      {e.invoiceNumber ? (
                        <button
                          type="button"
                          className="text-sm underline underline-offset-2 hover:no-underline min-h-[44px] sm:min-h-0"
                          onClick={() => setActiveSection('invoices')}
                          aria-label={`Open invoices section to see ${e.invoiceNumber}`} title={`Open invoices section to see ${e.invoiceNumber}`}
                        >
                          {e.invoiceNumber}
                        </button>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                    {isAdmin && (
                      <TableCell className="text-right">
                        {e.reversalOfId ? (
                          <span className="text-xs text-muted-foreground">already a reversal</span>
                        ) : (
                          <Button
                            variant="ghost" size="sm"
                            className="min-h-[44px]"
                            onClick={() => setReverseTarget(e)}
                            aria-label={`Reverse ${e.type} entry of ${formatMoney(e.amountCents)}`}
                          >
                            <Undo2 className="h-4 w-4" aria-hidden /><span className="sr-only sm:not-sr-only sm:inline">Reverse</span>
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <ReverseEntryDialog entry={reverseTarget} onClose={() => setReverseTarget(null)} onChanged={() => { void load(); onChanged() }} />
    </Card>
  )
}

/* ---------------- balances tab ---------------- */

function BalancesTab({ balances }: { balances: Balance[] }) {
  if (balances.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center">
          <p className="text-sm text-muted-foreground">No balances yet — issue an invoice to create the first ledger movement.</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        {balances.filter((b) => ACCOUNT_DESCRIPTIONS[b.account]).map((b) => (
          <Card key={b.account}>
            <CardHeader className="pb-1">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                <Scale className="h-4 w-4" aria-hidden /> {b.account.replaceAll('_', ' ')}
              </CardTitle>
              <CardDescription className="text-xs">{ACCOUNT_DESCRIPTIONS[b.account]}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold tracking-tight">{formatMoney(Math.abs(b.netCents))}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {b.account === 'revenue'
                  ? `${formatMoney(b.creditCents)} earned · ${formatMoney(b.debitCents)} reversed/adjusted`
                  : b.netCents >= 0
                    ? `${formatMoney(b.debitCents)} in · ${formatMoney(b.creditCents)} out`
                    : `${formatMoney(b.creditCents)} credited · ${formatMoney(b.debitCents)} debited`}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">All accounts</CardTitle>
          <CardDescription>Debits and credits per account, straight from the ledger.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-h-96 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {balances.map((b) => (
                  <TableRow key={b.account}>
                    <TableCell>
                      <p className="font-medium">{b.account.replaceAll('_', ' ')}</p>
                      {ACCOUNT_DESCRIPTIONS[b.account] && (
                        <p className="text-xs text-muted-foreground">{ACCOUNT_DESCRIPTIONS[b.account]}</p>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{formatMoney(b.debitCents)}</TableCell>
                    <TableCell className="text-right">{formatMoney(b.creditCents)}</TableCell>
                    <TableCell className="text-right font-medium">{formatMoney(b.netCents)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

/* ---------------- audit trail tab ---------------- */

function AuditTab() {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.get<{ events: AuditEvent[] }>('/api/audit?limit=100')
      setEvents(res.events)
    } catch (err) {
      setError(friendlyError(err, 'Could not load audit events'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (loading) {
    return <div className="space-y-2" aria-busy="true"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
  }
  if (error) {
    return (
      <div className="space-y-3">
        <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>
        <Button className="min-h-[44px]" onClick={() => void load()}><RefreshCw className="h-4 w-4" aria-hidden /> Retry</Button>
      </div>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><FileClock className="h-4 w-4" aria-hidden /> Audit trail</CardTitle>
        <CardDescription>Who did what, when — every consequential action is recorded and cannot be edited.</CardDescription>
        <Button variant="outline" className="min-h-[44px] mt-2 w-fit" onClick={() => void load()} aria-label="Refresh audit trail">
          <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No audit events yet.</p>
        ) : (
          <div className="max-h-96 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead className="hidden sm:table-cell">Entity</TableHead>
                  <TableHead className="hidden lg:table-cell">Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((ev) => (
                  <TableRow key={ev.id}>
                    <TableCell className="whitespace-nowrap">{formatDateTime(ev.ts)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn(ACTOR_CLASS[ev.actorType] ?? 'bg-muted text-muted-foreground')}>{ev.actorType}</Badge>
                    </TableCell>
                    <TableCell className="font-medium">{ev.action}</TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <span className="text-sm">{ev.entity}</span>
                      <span className="block text-xs text-muted-foreground max-w-[120px] truncate" title={ev.entityId}>{ev.entityId.slice(0, 12)}…</span>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell max-w-[320px]">
                      <pre className="text-xs whitespace-pre-wrap break-words text-muted-foreground">{prettyMeta(ev.meta)}</pre>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/* ---------------- main section ---------------- */

export function LedgerSection() {
  const [tab, setTab] = useState('entries')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [balances, setBalances] = useState<Balance[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.get<{ entries: LedgerRow[]; balances: Balance[] }>('/api/ledger?limit=200')
      setBalances(res.balances)
    } catch (err) {
      setError(friendlyError(err, 'Could not load the ledger'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading ledger">
        <Skeleton className="h-10 w-full max-w-md" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-4">
        <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>
        <Button className="min-h-[44px]" onClick={() => void load()}><RefreshCw className="h-4 w-4" aria-hidden /> Retry</Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Ledger</h2>
        <p className="text-sm text-muted-foreground">Append-only double-entry books, balances, and the full audit trail.</p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="entries" className="min-h-[44px]">Entries</TabsTrigger>
          <TabsTrigger value="balances" className="min-h-[44px]">Balances</TabsTrigger>
          <TabsTrigger value="audit" className="min-h-[44px]">Audit trail</TabsTrigger>
        </TabsList>

        <TabsContent value="entries" className="mt-4">
          <EntriesTab onChanged={() => { void load() }} />
        </TabsContent>

        <TabsContent value="balances" className="mt-4">
          <BalancesTab balances={balances} />
        </TabsContent>

        <TabsContent value="audit" className="mt-4">
          <AuditTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
