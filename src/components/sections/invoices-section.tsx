'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/lib/client/store'
import {
  api, ApiClientError, formatMoney, formatDateTime, formatDate,
  type Invoice, type Customer, type Payment,
} from '@/lib/client/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import {
  BadgeCheck, Ban, CheckCircle2, Copy, ExternalLink, FlaskConical, Link2, Loader2, Mail, Plus, RefreshCw,
  Receipt, ShieldAlert, Trash2, Wallet,
} from 'lucide-react'

/* ---------------- badges ---------------- */

const INVOICE_STATUS_CLASS: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground border-border',
  sent: 'bg-muted text-muted-foreground border-border',
  paid: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-900',
  partial: 'bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-900',
  overdue: 'bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-900',
  void: 'bg-muted text-muted-foreground border-border line-through',
  uncollectible: 'bg-muted text-muted-foreground border-border',
}

const PAYMENT_STATUS_CLASS: Record<string, string> = {
  verified: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-900',
  pending_verification: 'bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-900',
  rejected: 'bg-muted text-muted-foreground border-border',
}

function InvoiceStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn(INVOICE_STATUS_CLASS[status] ?? 'bg-muted text-muted-foreground')}>{status}</Badge>
  )
}

function PaymentStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn(PAYMENT_STATUS_CLASS[status] ?? 'bg-muted text-muted-foreground')}>
      {status === 'pending_verification' ? 'pending verification' : status}
    </Badge>
  )
}

function SourceTag({ source }: { source: string }) {
  return <Badge variant="secondary" className="font-normal text-[11px]">{source.replaceAll('_', ' ')}</Badge>
}

function friendlyError(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError && err.message) return err.message
  if (err instanceof Error && err.message) return err.message
  return fallback
}

function dollarsToCents(v: string): number {
  const n = Number.parseFloat(v)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : -1
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

type QueuePayment = Payment & {
  invoiceNumber?: string
  customerName?: string
  invoiceTotalCents?: number
  invoicePaidCents?: number
}

/* ---------------- invoice detail dialog ---------------- */

function RecordPaymentDialog({
  invoice, onClose, onChanged,
}: { invoice: Invoice | null; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast()
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('card')
  const [reference, setReference] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (invoice) {
      setAmount(((invoice.outstandingCents ?? 0) / 100).toFixed(2))
      setMethod('card')
      setReference('')
      setError('')
    }
  }, [invoice])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!invoice) return
    const cents = dollarsToCents(amount)
    if (cents < 0) { setError('Enter a valid amount in dollars, e.g. 42.50'); return }
    setBusy(true)
    setError('')
    try {
      await api.post(`/api/invoices/${invoice.id}/payments`, {
        amountCents: cents,
        method,
        reference: reference.trim() || undefined,
      })
      toast({ title: 'Payment recorded', description: `${formatMoney(cents)} verified against ${invoice.number}` })
      onChanged()
      onClose()
    } catch (err) {
      setError(friendlyError(err, 'Could not record payment'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!invoice} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record verified payment</DialogTitle>
          <DialogDescription>
            {invoice ? `Money you received yourself and can vouch for. Books against ${invoice.number} immediately.` : ''}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3" aria-label="Record payment form">
          {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
          <div className="space-y-1.5">
            <Label htmlFor="rp-amount">Amount (USD)</Label>
            <Input id="rp-amount" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} className="min-h-[44px]" />
            {invoice && <p className="text-xs text-muted-foreground">Outstanding: {formatMoney(invoice.outstandingCents ?? 0)}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rp-method">Method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger id="rp-method" className="min-h-[44px] w-full" aria-label="Payment method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="card">Card</SelectItem>
                <SelectItem value="bank">Bank transfer</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rp-reference">Reference (optional)</Label>
            <Input id="rp-reference" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Receipt #, transfer ID…" className="min-h-[44px]" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" className="min-h-[44px]" onClick={onClose}>Cancel</Button>
            <Button type="submit" className="min-h-[44px]" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Wallet className="h-4 w-4" aria-hidden />}
              Record payment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function SimulateWebhookDialog({
  invoice, onClose, onChanged,
}: { invoice: Invoice | null; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast()
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<string>('')

  useEffect(() => {
    if (invoice) {
      setAmount(((invoice.outstandingCents ?? 0) / 100).toFixed(2))
      setError('')
      setResult('')
    }
  }, [invoice])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!invoice) return
    const cents = dollarsToCents(amount)
    if (cents < 0) { setError('Enter a valid amount in dollars, e.g. 42.50'); return }
    setBusy(true)
    setError('')
    setResult('')
    try {
      const res = await api.post<{ result: string }>('/api/payments/simulate-webhook', {
        invoiceNumber: invoice.number,
        amountCents: cents,
      })
      setResult(res.result)
      if (res.result === 'processed') {
        toast({ title: 'Webhook processed', description: `${formatMoney(cents)} applied to ${invoice.number}` })
        onChanged()
      } else {
        toast({ title: `Webhook result: ${res.result}`, description: 'Nothing was booked — see the explanation in the dialog.', variant: res.result === 'rejected' ? 'destructive' : 'default' })
      }
    } catch (err) {
      setError(friendlyError(err, 'Simulation failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!invoice} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4" aria-hidden /> TEST HARNESS — simulates a signed provider webhook
          </DialogTitle>
          <DialogDescription>
            Sends a real signed webhook event through the exact same processing path a payment provider uses. Not a fake balance: the result is whatever the engine honestly decides.
          </DialogDescription>
        </DialogHeader>
        {invoice && (
          <form onSubmit={submit} className="space-y-3" aria-label="Simulate webhook payment form">
            {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
            {result && (
              <Alert role="status">
                <AlertDescription>
                  Result: <strong>{result}</strong>
                  {result === 'processed' && ' — payment applied and ledger posted.'}
                  {result === 'duplicate' && ' — this event was already processed (idempotency). Nothing double-booked.'}
                  {result === 'rejected' && ' — the engine refused it (unknown invoice or invalid amount).'}
                </AlertDescription>
              </Alert>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="sw-amount">Amount (USD) for {invoice.number}</Label>
              <Input id="sw-amount" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} className="min-h-[44px]" />
            </div>
            <p className="text-xs text-muted-foreground">
              Real payment providers POST to <code>/api/payments/webhook</code> with an HMAC signature header (<code>x-signature</code>). This button builds and signs the same payload locally so you can test end-to-end without a provider account.
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" className="min-h-[44px]" onClick={onClose}>Close</Button>
              <Button type="submit" className="min-h-[44px]" disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <FlaskConical className="h-4 w-4" aria-hidden />}
                Send signed test event
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function InvoiceDetailDialog({
  invoiceId, onClose, onChanged,
}: { invoiceId: string | null; onClose: () => void; onChanged: () => void }) {
  const session = useAppStore((s) => s.session)
  const { toast } = useToast()
  const isAdmin = session?.user?.role === 'owner' || session?.user?.role === 'admin'
  const [invoice, setInvoice] = useState<Invoice | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [recordOpen, setRecordOpen] = useState(false)
  const [simulateOpen, setSimulateOpen] = useState(false)
  const [voidOpen, setVoidOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sendBusy, setSendBusy] = useState(false)
  const [sendLink, setSendLink] = useState('')
  const [sendLinkError, setSendLinkError] = useState('')
  const [linkBusy, setLinkBusy] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkResult, setLinkResult] = useState<{ url: string; id: string } | null>(null)

  const load = useCallback(async (id: string) => {
    setLoading(true)
    setError('')
    try {
      const res = await api.get<Invoice>(`/api/invoices/${id}`)
      setInvoice(res)
    } catch (err) {
      setError(friendlyError(err, 'Could not load invoice'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (invoiceId) {
      setInvoice(null); setRecordOpen(false); setSimulateOpen(false); setVoidOpen(false); void load(invoiceId)
      setSendLink(''); setSendLinkError(''); setLinkOpen(false); setLinkResult(null)
    }
  }, [invoiceId, load])

  const refreshDetail = () => {
    if (invoiceId) void load(invoiceId)
    onChanged()
  }

  const doVoid = async () => {
    if (!invoice) return
    setBusy(true)
    try {
      await api.patch(`/api/invoices/${invoice.id}`, { action: 'void' })
      toast({ title: 'Invoice voided', description: `${invoice.number} will not be collected.` })
      setVoidOpen(false)
      refreshDetail()
    } catch (err) {
      toast({ title: 'Could not void invoice', description: friendlyError(err, 'Void failed'), variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  /** Queue the invoice email — the outbox owns real delivery; nothing here claims "sent". */
  const doSend = async () => {
    if (!invoice) return
    setSendBusy(true)
    try {
      const r = await api.post<{ queued: boolean; outboxId: string; paymentLink?: string; paymentLinkError?: string; channel: string; recipient: string }>(`/api/invoices/${invoice.id}/send`)
      setSendLink(r.paymentLink ?? '')
      setSendLinkError(r.paymentLinkError ?? '')
      toast({ title: 'Queued for delivery', description: `Email to ${r.recipient} is queued in the outbox — it is not confirmed sent until the dispatcher delivers it.` })
    } catch (err) {
      toast({ title: 'Could not send invoice', description: friendlyError(err, 'Send failed'), variant: 'destructive' })
    } finally {
      setSendBusy(false)
    }
  }

  const createLink = async () => {
    if (!invoice) return
    setLinkBusy(true)
    try {
      const r = await api.post<{ url: string; id: string }>(`/api/invoices/${invoice.id}/payment-link`)
      setLinkResult(r)
      setLinkOpen(true)
    } catch (err) {
      toast({ title: 'Payment link failed', description: friendlyError(err, 'Could not create payment link'), variant: 'destructive' })
    } finally {
      setLinkBusy(false)
    }
  }

  return (
    <>
      <Dialog open={!!invoiceId} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{invoice ? `Invoice ${invoice.number}` : 'Invoice'}</DialogTitle>
            <DialogDescription>{invoice?.customer?.name ?? ''}</DialogDescription>
          </DialogHeader>

          {loading && (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-8 w-full" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" />
            </div>
          )}
          {error && (
            <div className="space-y-3">
              <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>
              {invoiceId && <Button variant="outline" className="min-h-[44px]" onClick={() => void load(invoiceId)}><RefreshCw className="h-4 w-4" aria-hidden /> Retry</Button>}
            </div>
          )}

          {invoice && !loading && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div><p className="text-xs text-muted-foreground">Status</p><InvoiceStatusBadge status={invoice.status} /></div>
                <div><p className="text-xs text-muted-foreground">Issued</p><p>{formatDate(invoice.issueDate)}</p></div>
                <div><p className="text-xs text-muted-foreground">Due</p><p>{formatDate(invoice.dueDate)}</p></div>
                <div><p className="text-xs text-muted-foreground">Outstanding</p>
                  <p className={cn('font-semibold', (invoice.outstandingCents ?? 0) > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300')}>
                    {formatMoney(invoice.outstandingCents ?? 0)}
                  </p>
                </div>
              </div>

              <div>
                <p className="text-sm font-medium mb-1">Line items</p>
                <div className="rounded-md border max-h-40 overflow-y-auto">
                  <Table>
                    <TableHeader><TableRow><TableHead>Description</TableHead><TableHead className="text-right">Qty</TableHead><TableHead className="text-right">Unit</TableHead><TableHead className="text-right">Total</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {(invoice.items ?? []).map((it) => (
                        <TableRow key={it.id}>
                          <TableCell>{it.description}</TableCell>
                          <TableCell className="text-right">{it.qty}</TableCell>
                          <TableCell className="text-right">{formatMoney(it.unitPriceCents)}</TableCell>
                          <TableCell className="text-right">{formatMoney(it.totalCents)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <div className="mt-2 text-sm space-y-0.5 text-right">
                  <p className="text-muted-foreground">Subtotal {formatMoney(invoice.subtotalCents)} · Tax {formatMoney(invoice.taxCents)}</p>
                  <p className="font-semibold">Total {formatMoney(invoice.totalCents)} · Paid {formatMoney(invoice.paidCents)}</p>
                </div>
              </div>

              <div>
                <p className="text-sm font-medium mb-1">Payment history</p>
                {(invoice.payments ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2">No payments recorded or claimed yet.</p>
                ) : (
                  <div className="rounded-md border max-h-40 overflow-y-auto">
                    <Table>
                      <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Method</TableHead><TableHead>Reference</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {(invoice.payments ?? []).map((p) => (
                          <TableRow key={p.id}>
                            <TableCell className="whitespace-nowrap">{formatDateTime(p.createdAt)}</TableCell>
                            <TableCell>{p.method || '—'}</TableCell>
                            <TableCell className="max-w-[140px] truncate" title={p.reference}>{p.reference || '—'}</TableCell>
                            <TableCell><span className="flex flex-col gap-1"><PaymentStatusBadge status={p.status} /><SourceTag source={p.source} /></span></TableCell>
                            <TableCell className="text-right">{formatMoney(p.amountCents)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>

              {invoice.notes && (
                <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Notes:</span> {invoice.notes}</p>
              )}

              {sendLink && (
                <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900" role="status">
                  <CheckCircle2 className="h-4 w-4" aria-hidden />
                  <AlertDescription className="space-y-2">
                    <p className="font-medium">Payment link attached</p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <code className="text-xs break-all flex-1 min-w-0">{sendLink}</code>
                      <Button
                        size="sm" variant="outline" className="min-h-[44px]"
                        onClick={async () => {
                          const ok = await copyText(sendLink)
                          toast(ok ? { title: 'Copied to clipboard' } : { title: 'Copy failed', description: 'Select the text and copy it manually.', variant: 'destructive' })
                        }}
                        aria-label="Copy payment link"
                      >
                        <Copy className="h-4 w-4" aria-hidden /> Copy
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              )}
              {sendLinkError && (
                <Alert className="border-amber-200 bg-amber-50 text-amber-900" role="status">
                  <ShieldAlert className="h-4 w-4" aria-hidden />
                  <AlertDescription>Payment link not attached — {sendLinkError}</AlertDescription>
                </Alert>
              )}

              <Separator />
              <div className="flex flex-wrap gap-2">
                <Button
                  className="min-h-[44px]"
                  disabled={!isAdmin || invoice.status === 'void'}
                  onClick={() => setRecordOpen(true)}
                  title={isAdmin ? undefined : 'Owner or admin only'}
                >
                  <Wallet className="h-4 w-4" aria-hidden /> Record verified payment
                </Button>
                <Button
                  variant="outline"
                  className="min-h-[44px]"
                  disabled={!isAdmin || invoice.status === 'void'}
                  onClick={() => setSimulateOpen(true)}
                  title={isAdmin ? 'Test harness' : 'Owner or admin only'}
                >
                  <FlaskConical className="h-4 w-4" aria-hidden /> Simulate webhook payment
                </Button>
                <Button
                  variant="outline"
                  className="min-h-[44px] text-destructive hover:text-destructive"
                  disabled={!isAdmin || invoice.status === 'void'}
                  onClick={() => setVoidOpen(true)}
                  title={isAdmin ? undefined : 'Owner or admin only'}
                >
                  <Ban className="h-4 w-4" aria-hidden /> Void invoice
                </Button>
                <Button
                  variant="outline"
                  className="min-h-[44px]"
                  disabled={!isAdmin || sendBusy || invoice.status === 'void'}
                  onClick={() => void doSend()}
                  title={isAdmin ? 'Queue the invoice email — the dispatcher owns real delivery' : 'Owner or admin only'}
                >
                  {sendBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Mail className="h-4 w-4" aria-hidden />} Send to customer
                </Button>
                <Button
                  variant="outline"
                  className="min-h-[44px]"
                  disabled={!isAdmin || linkBusy || invoice.status === 'void'}
                  onClick={() => void createLink()}
                  title={isAdmin ? 'Create a Stripe payment link for the outstanding balance' : 'Owner or admin only'}
                >
                  {linkBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Link2 className="h-4 w-4" aria-hidden />} Payment link
                </Button>
                {!isAdmin && (
                  <p className="text-xs text-muted-foreground w-full">Payment recording, sending, payment links, webhook simulation and voiding are restricted to owner/admin accounts.</p>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {invoice && (
        <>
          <RecordPaymentDialog invoice={recordOpen ? invoice : null} onClose={() => setRecordOpen(false)} onChanged={refreshDetail} />
          <SimulateWebhookDialog invoice={simulateOpen ? invoice : null} onClose={() => setSimulateOpen(false)} onChanged={refreshDetail} />

          <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Stripe payment link</DialogTitle>
                <DialogDescription>
                  {invoice
                    ? `Share this link — it charges the outstanding balance of ${invoice.number} (${formatMoney(invoice.outstandingCents ?? 0)}). Payments arrive through the verified Stripe webhook.`
                    : ''}
                </DialogDescription>
              </DialogHeader>
              {linkResult && (
                <div className="space-y-3">
                  <div className="rounded-md border p-3">
                    <code className="text-xs break-all" aria-label="Payment link URL">{linkResult.url}</code>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline" className="min-h-[44px]"
                      onClick={async () => {
                        const ok = await copyText(linkResult.url)
                        toast(ok ? { title: 'Copied to clipboard' } : { title: 'Copy failed', description: 'Select the text and copy it manually.', variant: 'destructive' })
                      }}
                      aria-label="Copy payment link"
                    >
                      <Copy className="h-4 w-4" aria-hidden /> Copy link
                    </Button>
                    <Button
                      variant="outline" className="min-h-[44px]"
                      onClick={() => window.open(linkResult.url, '_blank', 'noopener')}
                      aria-label="Open payment link in a new tab"
                    >
                      <ExternalLink className="h-4 w-4" aria-hidden /> Open
                    </Button>
                  </div>
                </div>
              )}
              <DialogFooter>
                <Button variant="outline" className="min-h-[44px]" onClick={() => setLinkOpen(false)}>Close</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <AlertDialog open={voidOpen} onOpenChange={(open) => !open && setVoidOpen(false)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Void invoice {invoice.number}?</AlertDialogTitle>
                <AlertDialogDescription>
                  A voided invoice is permanently un-collectible. Existing ledger charge entries are reversed automatically. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="min-h-[44px]">Keep invoice</AlertDialogCancel>
                <AlertDialogAction
                  className="min-h-[44px] bg-destructive text-white hover:bg-destructive/90"
                  disabled={busy}
                  onClick={(e) => { e.preventDefault(); void doVoid() }}
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
                  Void it
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </>
  )
}

/* ---------------- verification queue tab ---------------- */

function VerifyQueueTab({ onChanged }: { onChanged: () => void }) {
  const session = useAppStore((s) => s.session)
  const { toast } = useToast()
  const isAdmin = session?.user?.role === 'owner' || session?.user?.role === 'admin'
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [queue, setQueue] = useState<QueuePayment[]>([])
  const [rejectTarget, setRejectTarget] = useState<QueuePayment | null>(null)
  const [reason, setReason] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.get<{ payments: QueuePayment[] }>('/api/payments?status=pending_verification')
      setQueue(res.payments)
    } catch (err) {
      setError(friendlyError(err, 'Could not load the verification queue'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const verify = async (p: QueuePayment) => {
    setBusyId(p.id)
    try {
      await api.post(`/api/payments/${p.id}/verify`)
      toast({ title: 'Payment verified', description: `${formatMoney(p.amountCents)} booked against ${p.invoiceNumber ?? 'invoice'}` })
      await load()
      onChanged()
    } catch (err) {
      toast({ title: 'Verification failed', description: friendlyError(err, 'Could not verify payment'), variant: 'destructive' })
    } finally {
      setBusyId(null)
    }
  }

  const reject = async () => {
    if (!rejectTarget) return
    setBusyId(rejectTarget.id)
    try {
      await api.post(`/api/payments/${rejectTarget.id}/reject`, { reason: reason.trim() || undefined })
      toast({ title: 'Payment rejected', description: 'The claim stays on record with your reason.' })
      setRejectTarget(null)
      setReason('')
      await load()
      onChanged()
    } catch (err) {
      toast({ title: 'Rejection failed', description: friendlyError(err, 'Could not reject payment'), variant: 'destructive' })
    } finally {
      setBusyId(null)
      setRejectTarget(null)
    }
  }

  return (
    <div className="space-y-4">
      <Alert role="status">
        <ShieldAlert className="h-4 w-4" aria-hidden />
        <AlertDescription>
          A customer claim is never auto-settled. Verification = trusted webhook, authorized human, or reconciliation.
          {isAdmin ? ' As owner/admin you settle these below.' : ' Only owner/admin accounts can settle them.'}
        </AlertDescription>
      </Alert>

      {loading ? (
        <div className="space-y-2" aria-busy="true"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
      ) : error ? (
        <div className="space-y-3">
          <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>
          <Button className="min-h-[44px]" onClick={() => void load()}><RefreshCw className="h-4 w-4" aria-hidden /> Retry</Button>
        </div>
      ) : queue.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center space-y-2">
            <BadgeCheck className="h-10 w-10 mx-auto text-emerald-600 dark:text-emerald-400" aria-hidden />
            <p className="text-sm text-muted-foreground">Nothing to verify — the queue is empty. Customer payment claims will appear here until a human settles them.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Claims waiting for a human decision ({queue.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="max-h-96 overflow-y-auto rounded-md border">
              <Table>
                <TableHeader className="sticky top-0 bg-background">
                  <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="hidden md:table-cell">Method</TableHead>
                    <TableHead className="hidden lg:table-cell">Reference</TableHead>
                    <TableHead>Claimed via</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queue.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.invoiceNumber ?? '—'}</TableCell>
                      <TableCell>{p.customerName ?? '—'}</TableCell>
                      <TableCell className="text-right">{formatMoney(p.amountCents)}</TableCell>
                      <TableCell className="hidden md:table-cell">{p.method || '—'}</TableCell>
                      <TableCell className="hidden lg:table-cell max-w-[160px] truncate" title={p.reference}>{p.reference || '—'}</TableCell>
                      <TableCell><SourceTag source={p.source} /></TableCell>
                      <TableCell className="text-right">
                        {isAdmin ? (
                          <span className="inline-flex justify-end gap-1.5">
                            <Button size="sm" className="min-h-[44px]" disabled={busyId === p.id} onClick={() => void verify(p)}>
                              {busyId === p.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}
                              Verify
                            </Button>
                            <Button
                              size="sm" variant="outline"
                              className="min-h-[44px] text-destructive hover:text-destructive"
                              disabled={busyId === p.id}
                              onClick={() => { setRejectTarget(p); setReason('') }}
                              aria-label={`Reject claimed payment for ${p.invoiceNumber ?? 'invoice'}`}
                            >
                              Reject
                            </Button>
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">owner/admin only</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={!!rejectTarget} onOpenChange={(open) => !open && setRejectTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject this claimed payment?</AlertDialogTitle>
            <AlertDialogDescription>
              {rejectTarget ? `${rejectTarget.customerName ?? 'The customer'} claimed ${formatMoney(rejectTarget.amountCents)} for ${rejectTarget.invoiceNumber ?? 'an invoice'}. Rejection records your reason and leaves the invoice balance untouched.` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="reject-reason">Reason (stored on the payment record)</Label>
            <Textarea id="reject-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. No matching transfer found on the statement" className="min-h-[44px]" />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-[44px]">Back</AlertDialogCancel>
            <AlertDialogAction
              className="min-h-[44px] bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => { e.preventDefault(); void reject() }}
            >
              Reject claim
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/* ---------------- new invoice tab ---------------- */

type ItemDraft = { description: string; qty: string; unitPrice: string }

function NewInvoiceForm({
  customers, onCreated,
}: { customers: Customer[]; onCreated: () => void }) {
  const { toast } = useToast()
  const [customerId, setCustomerId] = useState('')
  const [items, setItems] = useState<ItemDraft[]>([{ description: '', qty: '1', unitPrice: '' }])
  const [tax, setTax] = useState('')
  const [dueInDays, setDueInDays] = useState('14')
  const [notes, setNotes] = useState('')
  const [rentalStart, setRentalStart] = useState('')
  const [rentalEnd, setRentalEnd] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const parsed = useMemo(() => items.map((it) => ({
    description: it.description.trim(),
    qty: Number.parseInt(it.qty, 10),
    unitPriceCents: dollarsToCents(it.unitPrice),
  })), [items])

  const subtotalCents = useMemo(
    () => parsed.reduce((acc, it) => acc + (Number.isFinite(it.qty) && it.qty > 0 && it.unitPriceCents >= 0 ? it.qty * it.unitPriceCents : 0), 0),
    [parsed]
  )
  const taxCents = tax.trim() === '' ? 0 : dollarsToCents(tax)
  const validItems = parsed.filter((it) => it.description.length > 0 && Number.isFinite(it.qty) && it.qty > 0 && it.unitPriceCents >= 0)
  const canSubmit = customerId && validItems.length > 0 && (tax.trim() === '' || taxCents >= 0)

  const updateItem = (idx: number, patch: Partial<ItemDraft>) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)))
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError('')
    try {
      const body: Record<string, unknown> = {
        customerId,
        items: validItems.map((it) => ({ description: it.description, qty: it.qty, unitPriceCents: it.unitPriceCents })),
        taxCents: taxCents >= 0 ? taxCents : 0,
        dueInDays: Number.isFinite(Number.parseInt(dueInDays, 10)) ? Number.parseInt(dueInDays, 10) : undefined,
        notes: notes.trim() || undefined,
      }
      if (rentalStart && rentalEnd) body.rentalPeriod = { start: rentalStart, end: rentalEnd }
      const created = await api.post<Invoice>('/api/invoices', body)
      toast({ title: `Invoice ${created.number} created`, description: `${formatMoney(created.totalCents)} for ${created.customer?.name ?? 'customer'}` })
      setCustomerId(''); setItems([{ description: '', qty: '1', unitPrice: '' }]); setTax('')
      setDueInDays('14'); setNotes(''); setRentalStart(''); setRentalEnd('')
      onCreated()
    } catch (err) {
      setError(friendlyError(err, 'Could not create invoice'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New invoice</CardTitle>
        <CardDescription>Line items post a real ledger charge (receivables → revenue) the moment the invoice is issued.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4 max-w-3xl" aria-label="New invoice form">
          {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ni-customer">Customer</Label>
              <Select value={customerId} onValueChange={setCustomerId} required>
                <SelectTrigger id="ni-customer" className="min-h-[44px] w-full" aria-label="Select invoice customer">
                  <SelectValue placeholder="Choose customer…" />
                </SelectTrigger>
                <SelectContent>
                  {customers.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}{c.email ? ` · ${c.email}` : ''}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ni-due">Due in (days)</Label>
              <Input id="ni-due" type="number" min={0} max={365} value={dueInDays} onChange={(e) => setDueInDays(e.target.value)} className="min-h-[44px]" />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Line items</Label>
            {items.map((it, idx) => (
              <div key={idx} className="grid grid-cols-12 gap-2 items-end rounded-lg border p-3">
                <div className="col-span-12 sm:col-span-6 space-y-1">
                  <Label htmlFor={`ni-desc-${idx}`} className="text-xs text-muted-foreground">Description</Label>
                  <Input
                    id={`ni-desc-${idx}`}
                    value={it.description}
                    onChange={(e) => updateItem(idx, { description: e.target.value })}
                    placeholder="e.g. Deep-cleansing facial"
                    className="min-h-[44px]"
                  />
                </div>
                <div className="col-span-4 sm:col-span-2 space-y-1">
                  <Label htmlFor={`ni-qty-${idx}`} className="text-xs text-muted-foreground">Qty</Label>
                  <Input id={`ni-qty-${idx}`} inputMode="numeric" value={it.qty} onChange={(e) => updateItem(idx, { qty: e.target.value })} className="min-h-[44px]" />
                </div>
                <div className="col-span-6 sm:col-span-3 space-y-1">
                  <Label htmlFor={`ni-price-${idx}`} className="text-xs text-muted-foreground">Unit price (USD)</Label>
                  <Input id={`ni-price-${idx}`} inputMode="decimal" value={it.unitPrice} onChange={(e) => updateItem(idx, { unitPrice: e.target.value })} placeholder="120.00" className="min-h-[44px]" />
                </div>
                <div className="col-span-2 sm:col-span-1 flex justify-end">
                  <Button
                    type="button" variant="ghost" size="icon"
                    className="min-h-[44px] min-w-[44px] text-destructive hover:text-destructive"
                    disabled={items.length === 1}
                    onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))}
                    aria-label={`Remove line item ${idx + 1}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              </div>
            ))}
            <Button type="button" variant="outline" className="min-h-[44px]" onClick={() => setItems((prev) => [...prev, { description: '', qty: '1', unitPrice: '' }])}>
              <Plus className="h-4 w-4" aria-hidden /> Add line item
            </Button>
            <p className="text-sm text-right text-muted-foreground">
              Subtotal <span className="font-semibold text-foreground">{formatMoney(subtotalCents)}</span>
              {tax.trim() !== '' && taxCents >= 0 && <> + tax {formatMoney(taxCents)} = <span className="font-semibold text-foreground">{formatMoney(subtotalCents + taxCents)}</span></>}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="ni-tax">Tax (USD, optional)</Label>
              <Input id="ni-tax" inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} placeholder="0.00" className="min-h-[44px]" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ni-rental-start">Rental start (optional)</Label>
              <Input id="ni-rental-start" type="date" value={rentalStart} onChange={(e) => setRentalStart(e.target.value)} className="min-h-[44px]" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ni-rental-end">Rental end (optional)</Label>
              <Input id="ni-rental-end" type="date" value={rentalEnd} onChange={(e) => setRentalEnd(e.target.value)} className="min-h-[44px]" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ni-notes">Notes (optional)</Label>
            <Textarea id="ni-notes" value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-[44px]" />
          </div>

          <Button type="submit" className="min-h-[44px]" disabled={!canSubmit || busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Receipt className="h-4 w-4" aria-hidden />}
            Create invoice
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

/* ---------------- main section ---------------- */

export function InvoicesSection() {
  const [tab, setTab] = useState('invoices')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [status, setStatus] = useState('all')
  const [detailId, setDetailId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [inv, cus] = await Promise.all([
        api.get<{ invoices: Invoice[] }>('/api/invoices'),
        api.get<{ customers: Customer[] }>('/api/customers'),
      ])
      setInvoices(inv.invoices)
      setCustomers(cus.customers)
    } catch (err) {
      setError(friendlyError(err, 'Could not load invoices'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const refresh = () => { void load() }

  const filtered = useMemo(() => {
    return invoices
      .filter((inv) => status === 'all' || inv.status === status)
      .sort((a, b) => b.issueDate.localeCompare(a.issueDate))
  }, [invoices, status])

  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading invoices">
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

  const outstandingTotal = invoices.reduce((acc, inv) => acc + (inv.status === 'void' ? 0 : (inv.outstandingCents ?? 0)), 0)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Invoices &amp; Payments</h2>
          <p className="text-sm text-muted-foreground">
            {invoices.length} invoice{invoices.length === 1 ? '' : 's'} · outstanding {formatMoney(outstandingTotal)} · claims are never auto-settled.
          </p>
        </div>
        <Button variant="outline" className="min-h-[44px]" onClick={refresh} aria-label="Refresh invoices">
          <RefreshCw className="h-4 w-4" aria-hidden /><span className="hidden sm:inline">Refresh</span>
        </Button>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="invoices" className="min-h-[44px]">Invoices</TabsTrigger>
          <TabsTrigger value="verify" className="min-h-[44px]">Payments to verify</TabsTrigger>
          <TabsTrigger value="new" className="min-h-[44px]">New invoice</TabsTrigger>
        </TabsList>

        <TabsContent value="invoices" className="mt-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">All invoices</CardTitle>
              <CardDescription>Click a row for line items, payment history and actions.</CardDescription>
              <div className="pt-2">
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger className="min-h-[44px] sm:w-56" aria-label="Filter invoices by status">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="sent">Sent</SelectItem>
                    <SelectItem value="partial">Partially paid</SelectItem>
                    <SelectItem value="paid">Paid</SelectItem>
                    <SelectItem value="overdue">Overdue</SelectItem>
                    <SelectItem value="void">Void</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              {filtered.length === 0 ? (
                <div className="py-8 text-center space-y-3">
                  <Receipt className="h-10 w-10 mx-auto text-muted-foreground" aria-hidden />
                  <p className="text-sm text-muted-foreground">
                    {invoices.length === 0 ? 'No invoices yet — create your first one to bill a customer.' : 'No invoices match this status filter.'}
                  </p>
                  {invoices.length === 0 && (
                    <Button className="min-h-[44px]" onClick={() => setTab('new')}>
                      <Plus className="h-4 w-4" aria-hidden /> New invoice
                    </Button>
                  )}
                </div>
              ) : (
                <div className="max-h-96 overflow-y-auto rounded-md border">
                  <Table>
                    <TableHeader className="sticky top-0 bg-background">
                      <TableRow>
                        <TableHead>Number</TableHead>
                        <TableHead>Customer</TableHead>
                        <TableHead className="hidden md:table-cell">Issued</TableHead>
                        <TableHead className="hidden md:table-cell">Due</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                        <TableHead className="text-right hidden sm:table-cell">Paid</TableHead>
                        <TableHead className="text-right">Outstanding</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filtered.map((inv) => (
                        <TableRow
                          key={inv.id}
                          className="cursor-pointer"
                          tabIndex={0}
                          aria-label={`Open invoice ${inv.number}`}
                          onClick={() => setDetailId(inv.id)}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailId(inv.id) } }}
                        >
                          <TableCell className="font-medium">{inv.number}</TableCell>
                          <TableCell>{inv.customer?.name ?? '—'}</TableCell>
                          <TableCell className="hidden md:table-cell whitespace-nowrap">{formatDate(inv.issueDate)}</TableCell>
                          <TableCell className="hidden md:table-cell whitespace-nowrap">{formatDate(inv.dueDate)}</TableCell>
                          <TableCell className="text-right">{formatMoney(inv.totalCents)}</TableCell>
                          <TableCell className="text-right hidden sm:table-cell">{formatMoney(inv.paidCents)}</TableCell>
                          <TableCell className={cn('text-right', (inv.outstandingCents ?? 0) > 0 && inv.status !== 'void' ? 'font-semibold text-amber-700 dark:text-amber-300' : '')}>
                            {formatMoney(inv.outstandingCents ?? 0)}
                          </TableCell>
                          <TableCell><InvoiceStatusBadge status={inv.status} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="verify" className="mt-4">
          <VerifyQueueTab onChanged={refresh} />
        </TabsContent>

        <TabsContent value="new" className="mt-4">
          <NewInvoiceForm customers={customers} onCreated={() => { refresh(); setTab('invoices') }} />
        </TabsContent>
      </Tabs>

      <InvoiceDetailDialog invoiceId={detailId} onClose={() => setDetailId(null)} onChanged={refresh} />
    </div>
  )
}
