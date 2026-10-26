'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/lib/client/store'
import {
  api, ApiClientError, formatMoney, formatDateTime, formatDate,
  type Customer, type CustomerCommPrefs, type Booking, type Invoice, type LedgerEntryRow,
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { formatFileSize, readFileAsText } from '@/lib/client/files'
import {
  Download, FileDown, Loader2, Plus, RefreshCw, Search, ShieldOff,
  Trash2, Upload, UserRound, Eye, Pencil, Users,
} from 'lucide-react'

const DEFAULT_COMM_PREFS: CustomerCommPrefs = {
  email: true, sms: true, whatsapp: true,
  service: true, booking: true, invoice: true, reminder: true, marketing: false,
}

const PREF_LABELS: Array<{ key: keyof CustomerCommPrefs; label: string; detail: string }> = [
  { key: 'email', label: 'Email', detail: 'Allow email delivery' },
  { key: 'sms', label: 'SMS', detail: 'Allow text messages' },
  { key: 'whatsapp', label: 'WhatsApp', detail: 'Allow WhatsApp messages' },
  { key: 'service', label: 'Conversation replies', detail: 'Replies to this customer’s enquiries' },
  { key: 'booking', label: 'Bookings', detail: 'Confirmations, reschedules and cancellations' },
  { key: 'invoice', label: 'Invoices', detail: 'Invoices and payment receipts' },
  { key: 'reminder', label: 'Reminders', detail: 'Appointment and payment reminders' },
  { key: 'marketing', label: 'Marketing', detail: 'Offers and announcements (needs consent)' },
]

/* ---------------- badges ---------------- */

const STATUS_CLASS: Record<string, string> = {
  confirmed: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-900',
  pending: 'bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-900',
  cancelled: 'bg-muted text-muted-foreground border-border',
  completed: 'bg-neutral-700 text-white border-neutral-700',
  no_show: 'bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-900',
  paid: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-900',
  partial: 'bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-900',
  sent: 'bg-muted text-muted-foreground border-border',
  void: 'bg-muted text-muted-foreground border-border line-through',
  overdue: 'bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-900',
  uncollectible: 'bg-muted text-muted-foreground border-border',
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn(STATUS_CLASS[status] ?? 'bg-muted text-muted-foreground')}>
      {status === 'no_show' ? 'no-show' : status}
    </Badge>
  )
}

function friendlyError(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError && err.message) return err.message
  if (err instanceof Error && err.message) return err.message
  return fallback
}

type ImportResult = { created: number; errors: Array<{ row: number; message: string }> }

/* ---------------- view dialog (details + bookings + invoices + statement) ---------------- */

type CustomerDetail = {
  customer: Customer
  bookings: Booking[]
  invoices: Invoice[]
  summary?: { bookings?: number; invoices?: number }
}
type Statement = {
  customer: Customer
  invoices: Array<{ id: string; number: string; status: string; currency: string; totalCents: number; paidCents: number; issueDate: string; dueDate: string; outstandingCents: number }>
  totalOutstandingCents: number
  ledgerRows?: LedgerEntryRow[]
}

function ViewCustomerDialog({
  customer, onClose, onChanged,
}: { customer: Customer | null; onClose: () => void; onChanged: () => void }) {
  const [tab, setTab] = useState('details')
  const [detail, setDetail] = useState<CustomerDetail | null>(null)
  const [statement, setStatement] = useState<Statement | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (id: string) => {
    setLoading(true)
    setError('')
    try {
      const [d, s] = await Promise.all([
        api.get<CustomerDetail>(`/api/customers/${id}`),
        api.get<Statement>(`/api/customers/${id}/statement`),
      ])
      setDetail(d)
      setStatement(s)
    } catch (err) {
      setError(friendlyError(err, 'Could not load customer details'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (customer) {
      setTab('details')
      setDetail(null)
      setStatement(null)
      void load(customer.id)
    }
  }, [customer, load])

  return (
    <Dialog open={!!customer} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{customer?.name ?? 'Customer'}</DialogTitle>
          <DialogDescription>Full record: bookings, invoices and account statement.</DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}
        {error && (
          <div className="space-y-3">
            <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>
            {customer && <Button variant="outline" className="min-h-[44px]" onClick={() => void load(customer.id)}><RefreshCw className="h-4 w-4" aria-hidden /> Retry</Button>}
          </div>
        )}

        {detail && !loading && (
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="flex-wrap h-auto">
              <TabsTrigger value="details" className="min-h-[44px]">Details</TabsTrigger>
              <TabsTrigger value="bookings" className="min-h-[44px]">Bookings ({detail.bookings.length})</TabsTrigger>
              <TabsTrigger value="invoices" className="min-h-[44px]">Invoices ({detail.invoices.length})</TabsTrigger>
              <TabsTrigger value="statement" className="min-h-[44px]">Statement</TabsTrigger>
            </TabsList>

            <TabsContent value="details" className="mt-3 space-y-2 text-sm">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <p><span className="text-muted-foreground">Email:</span> {detail.customer.email || '—'}</p>
                <p><span className="text-muted-foreground">Phone:</span> {detail.customer.phone || '—'}</p>
                <p><span className="text-muted-foreground">Created:</span> {formatDate(detail.customer.createdAt)}</p>
                <p className="flex items-center gap-2">
                  <span className="text-muted-foreground">Marketing consent:</span>
                  {detail.customer.consentContact
                    ? <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300">consented</Badge>
                    : <Badge variant="outline" className="bg-muted text-muted-foreground">not given</Badge>}
                </p>
                <p className="flex items-center gap-2">
                  <span className="text-muted-foreground">Opt out:</span>
                  {detail.customer.optOut
                    ? <Badge variant="outline" className="bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300"><ShieldOff className="h-3 w-3" aria-hidden /> opted out</Badge>
                    : <Badge variant="outline" className="bg-muted text-muted-foreground">no</Badge>}
                </p>
              </div>
              <p className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted-foreground">Channels:</span>
                {(['email', 'sms', 'whatsapp'] as const).map((key) => {
                  const enabled = detail.customer.commPrefs?.[key] !== false
                  return (
                    <Badge key={key} variant="outline" className={enabled ? 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300' : 'bg-muted text-muted-foreground'}>
                      {enabled ? `${key} on` : `${key} off`}
                    </Badge>
                  )
                })}
              </p>
              {detail.customer.tags.length > 0 && (
                <p className="flex flex-wrap items-center gap-1.5">
                  <span className="text-muted-foreground">Tags:</span>
                  {detail.customer.tags.map((t) => <Badge key={t} variant="secondary">{t}</Badge>)}
                </p>
              )}
              {detail.customer.notes && (
                <><Separator />
                  <p><span className="text-muted-foreground">Notes:</span> {detail.customer.notes}</p>
                </>
              )}
            </TabsContent>

            <TabsContent value="bookings" className="mt-3">
              {detail.bookings.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No bookings for this customer yet.</p>
              ) : (
                <div className="max-h-72 overflow-y-auto rounded-md border">
                  <Table>
                    <TableHeader className="sticky top-0 bg-background">
                      <TableRow><TableHead>When</TableHead><TableHead>Service</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Price</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.bookings.map((b) => (
                        <TableRow key={b.id}>
                          <TableCell className="whitespace-nowrap">{formatDateTime(b.startAt)}</TableCell>
                          <TableCell>{b.service?.name ?? '—'}</TableCell>
                          <TableCell><StatusBadge status={b.status} /></TableCell>
                          <TableCell className="text-right">{formatMoney(b.priceCents)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </TabsContent>

            <TabsContent value="invoices" className="mt-3">
              {detail.invoices.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No invoices for this customer yet.</p>
              ) : (
                <div className="max-h-72 overflow-y-auto rounded-md border">
                  <Table>
                    <TableHeader className="sticky top-0 bg-background">
                      <TableRow><TableHead>Number</TableHead><TableHead>Due</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Outstanding</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.invoices.map((inv) => (
                        <TableRow key={inv.id}>
                          <TableCell className="font-medium">{inv.number}</TableCell>
                          <TableCell className="whitespace-nowrap">{formatDate(inv.dueDate)}</TableCell>
                          <TableCell><StatusBadge status={inv.status} /></TableCell>
                          <TableCell className="text-right">{formatMoney(inv.outstandingCents ?? 0)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </TabsContent>

            <TabsContent value="statement" className="mt-3 space-y-3">
              {!statement ? (
                <p className="text-sm text-muted-foreground">Statement unavailable.</p>
              ) : (
                <>
                  <div className="rounded-lg border p-3">
                    <p className="text-xs text-muted-foreground">Total outstanding (money this customer owes)</p>
                    <p className={cn('text-2xl font-semibold', statement.totalOutstandingCents > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300')}>
                      {formatMoney(statement.totalOutstandingCents)}
                    </p>
                  </div>
                  {statement.invoices.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No invoices on this statement.</p>
                  ) : (
                    <div className="max-h-56 overflow-y-auto rounded-md border">
                      <Table>
                        <TableHeader className="sticky top-0 bg-background">
                          <TableRow><TableHead>Number</TableHead><TableHead>Total</TableHead><TableHead>Paid</TableHead><TableHead className="text-right">Outstanding</TableHead></TableRow>
                        </TableHeader>
                        <TableBody>
                          {statement.invoices.map((inv) => (
                            <TableRow key={inv.id}>
                              <TableCell className="font-medium">{inv.number}</TableCell>
                              <TableCell>{formatMoney(inv.totalCents)}</TableCell>
                              <TableCell>{formatMoney(inv.paidCents)}</TableCell>
                              <TableCell className="text-right">{formatMoney(inv.outstandingCents)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                  {statement.ledgerRows && statement.ledgerRows.length > 0 && (
                    <>
                      <Separator />
                      <p className="text-xs text-muted-foreground">Ledger rows linked to this customer ({statement.ledgerRows.length})</p>
                      <div className="max-h-40 overflow-y-auto space-y-1 text-xs">
                        {statement.ledgerRows.map((r) => (
                          <p key={r.id} className="text-muted-foreground">
                            {formatDate(r.ts)} · {r.type} · {formatMoney(r.amountCents)} · {r.debitAccount} → {r.creditAccount}
                          </p>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </TabsContent>
          </Tabs>
        )}

        <DialogFooter>
          <Button variant="outline" className="min-h-[44px]" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ---------------- edit dialog ---------------- */

function EditCustomerDialog({
  customer, onClose, onChanged,
}: { customer: Customer | null; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [notes, setNotes] = useState('')
  const [tags, setTags] = useState('')
  const [consentContact, setConsentContact] = useState(true)
  const [optOut, setOptOut] = useState(false)
  const [commPrefs, setCommPrefs] = useState<CustomerCommPrefs>(DEFAULT_COMM_PREFS)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (customer) {
      setName(customer.name)
      setEmail(customer.email)
      setPhone(customer.phone)
      setNotes(customer.notes)
      setTags(customer.tags.join(', '))
      setConsentContact(customer.consentContact)
      setOptOut(customer.optOut)
      setCommPrefs({ ...DEFAULT_COMM_PREFS, ...customer.commPrefs })
      setError('')
    }
  }, [customer])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!customer) return
    setBusy(true)
    setError('')
    try {
      await api.patch(`/api/customers/${customer.id}`, {
        name: name.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        notes: notes.trim() || undefined,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        consentContact,
        optOut,
        commPrefs,
      })
      toast({ title: 'Customer updated', description: name })
      onChanged()
      onClose()
    } catch (err) {
      setError(friendlyError(err, 'Could not update customer'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!customer} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit customer</DialogTitle>
          <DialogDescription>Changes apply immediately and are audited.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3" aria-label="Edit customer form">
          {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
          <div className="space-y-1.5">
            <Label htmlFor="ec-name">Name</Label>
            <Input id="ec-name" required value={name} onChange={(e) => setName(e.target.value)} className="min-h-[44px]" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ec-email">Email</Label>
              <Input id="ec-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="min-h-[44px]" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ec-phone">Phone</Label>
              <Input id="ec-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="min-h-[44px]" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ec-tags">Tags (comma separated)</Label>
            <Input id="ec-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="vip, wholesale" className="min-h-[44px]" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ec-notes">Notes</Label>
            <Textarea id="ec-notes" value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-[44px]" />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="pr-3">
              <Label htmlFor="ec-consent" className="text-sm">Contact consent</Label>
              <p className="text-xs text-muted-foreground">The customer agreed to receive booking and invoice messages.</p>
            </div>
            <Switch id="ec-consent" checked={consentContact} onCheckedChange={setConsentContact} aria-label="Toggle contact consent" />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
            <div className="pr-3">
              <Label htmlFor="ec-optout" className="text-sm">Opt out of ALL messages</Label>
              <p className="text-xs text-muted-foreground">Opt out stops ALL automated reminders and messages — including booking reminders and invoice notices. You can still contact them yourself.</p>
            </div>
            <Switch id="ec-optout" checked={optOut} onCheckedChange={setOptOut} aria-label="Toggle opt out of all messages" />
          </div>

          <fieldset className={cn('space-y-2 rounded-lg border p-3', optOut && 'opacity-60')} disabled={optOut}>
            <legend className="px-1 text-sm font-medium">Message preferences</legend>
            <p className="text-xs text-muted-foreground">Org routing rules are applied first; these preferences apply on top. Opt-out above always wins.</p>
            <div className="max-h-64 overflow-y-auto divide-y rounded-md border">
              {PREF_LABELS.map((pref) => (
                <div key={pref.key} className="flex items-center justify-between gap-3 p-2.5">
                  <div className="min-w-0">
                    <Label htmlFor={`ec-pref-${pref.key}`} className="text-sm">{pref.label}</Label>
                    <p className="text-xs text-muted-foreground">{pref.detail}</p>
                  </div>
                  <Switch
                    id={`ec-pref-${pref.key}`}
                    checked={commPrefs[pref.key]}
                    onCheckedChange={(checked) => setCommPrefs((p) => ({ ...p, [pref.key]: checked }))}
                    aria-label={`Toggle ${pref.label} messages`}
                  />
                </div>
              ))}
            </div>
            {commPrefs.marketing && !consentContact && (
              <p className="text-xs text-amber-800 dark:text-amber-300">Marketing stays blocked until contact consent is given.</p>
            )}
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" className="min-h-[44px]" onClick={onClose}>Cancel</Button>
            <Button type="submit" className="min-h-[44px]" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Pencil className="h-4 w-4" aria-hidden />}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ---------------- delete dialog ---------------- */

function DeleteCustomerDialog({
  customer, onClose, onChanged,
}: { customer: Customer | null; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { if (customer) setError('') }, [customer])

  const submit = async () => {
    if (!customer) return
    setBusy(true)
    setError('')
    try {
      await api.delete(`/api/customers/${customer.id}`)
      toast({ title: 'Customer deleted', description: customer.name })
      onChanged()
      onClose()
    } catch (err) {
      setError(friendlyError(err, 'Could not delete customer'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open={!!customer} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {customer?.name ?? 'this customer'}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes the customer record. If they still have invoices with an outstanding balance, the server will refuse — settle those first.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-[44px]">Keep customer</AlertDialogCancel>
          <AlertDialogAction
            className="min-h-[44px] bg-destructive text-white hover:bg-destructive/90"
            disabled={busy}
            onClick={(e) => { e.preventDefault(); void submit() }}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
            Delete permanently
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/* ---------------- new customer dialog ---------------- */

function NewCustomerDialog({
  open, onClose, onChanged,
}: { open: boolean; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { if (open) { setName(''); setEmail(''); setPhone(''); setNotes(''); setError('') } }, [open])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const created = await api.post<Customer>('/api/customers', {
        name: name.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        notes: notes.trim() || undefined,
      })
      toast({ title: 'Customer created', description: created.name })
      onChanged()
      onClose()
    } catch (err) {
      setError(friendlyError(err, 'Could not create customer'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New customer</DialogTitle>
          <DialogDescription>Add a person you serve. Email and phone power reminders and invoices.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3" aria-label="New customer form">
          {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
          <div className="space-y-1.5">
            <Label htmlFor="nc-name">Name</Label>
            <Input id="nc-name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Jordan Lee" className="min-h-[44px]" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="nc-email">Email (optional)</Label>
              <Input id="nc-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="min-h-[44px]" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nc-phone">Phone (optional)</Label>
              <Input id="nc-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="min-h-[44px]" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nc-notes">Notes (optional)</Label>
            <Textarea id="nc-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Preferences, allergies, anything useful." className="min-h-[44px]" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" className="min-h-[44px]" onClick={onClose}>Cancel</Button>
            <Button type="submit" className="min-h-[44px]" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
              Create customer
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ---------------- import tab ---------------- */

const CSV_TEMPLATE = [
  'name,email,phone,notes,tags',
  'Dana Fox,dana@example.com,+1 555 010 2233,Prefers mornings,vip',
  'Marco Diaz,marco@example.com,+1 555 018 9910,,walk-in',
].join('\n')

function ImportTab({ onImported }: { onImported: () => void }) {
  const { toast } = useToast()
  const [csv, setCsv] = useState('')
  const [csvFile, setCsvFile] = useState<{ name: string; size: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState('')

  const pickCsvFile = async (file: File | null) => {
    if (!file) { setCsvFile(null); return }
    if (file.size > 5 * 1024 * 1024) {
      setError('The CSV file is larger than 5 MB. Split it into smaller files.')
      return
    }
    try {
      const text = await readFileAsText(file)
      setCsv(text)
      setCsvFile({ name: file.name, size: file.size })
      setResult(null)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The CSV file could not be read')
    }
  }

  const downloadTemplate = () => {
    const blob = new Blob([CSV_TEMPLATE], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'customers-template.csv'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    toast({ title: 'Template downloaded', description: 'customers-template.csv' })
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!csv.trim()) return
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const res = await api.post<ImportResult>('/api/customers/import', { csv })
      setResult(res)
      onImported()
      toast({ title: `Import finished — ${res.created} created`, description: res.errors.length > 0 ? `${res.errors.length} row(s) had errors; see the report below.` : 'Every row imported cleanly.' })
    } catch (err) {
      // import failures still carry a partial result (created + errors) — show it honestly
      if (err instanceof ApiClientError && err.extra && typeof err.extra === 'object' && 'created' in err.extra) {
        const extra = err.extra as unknown as ImportResult
        setResult({ created: extra.created ?? 0, errors: extra.errors ?? [{ row: 0, message: err.message }] })
      } else {
        setError(friendlyError(err, 'Import failed'))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Upload className="h-4 w-4" aria-hidden /> Import customers from CSV</CardTitle>
          <CardDescription>
            Paste CSV with header <code className="text-xs">name,email,phone,notes,tags</code>. Only <strong>name</strong> is required per row. Rows with problems are skipped and reported — the rest still import.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-3" aria-label="CSV import form">
            {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
            <div className="space-y-1.5">
              <Label htmlFor="csv-file">Upload a CSV file (optional)</Label>
              <Input
                id="csv-file"
                type="file"
                accept=".csv,text/csv,text/plain"
                onChange={(e) => void pickCsvFile(e.target.files?.[0] ?? null)}
                disabled={busy}
                className="min-h-[44px]"
                aria-describedby="csv-file-help"
              />
              <p id="csv-file-help" className="text-xs text-muted-foreground">
                {csvFile ? `${csvFile.name} · ${formatFileSize(csvFile.size)} loaded — review below, then import.` : 'Or paste the CSV directly. Files stay in this browser until you import.'}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="csv-input">CSV content</Label>
              <Textarea
                id="csv-input"
                value={csv}
                onChange={(e) => { setCsv(e.target.value); setResult(null) }}
                placeholder={'name,email,phone,notes,tags\nDana Fox,dana@example.com,+1 555 010 2233,Prefers mornings,vip'}
                className="min-h-[160px] font-mono text-xs"
                aria-describedby="csv-help"
              />
              <p id="csv-help" className="text-xs text-muted-foreground">One customer per line. Extra columns are ignored.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" className="min-h-[44px]" disabled={busy || !csv.trim()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
                Import customers
              </Button>
              <Button type="button" variant="outline" className="min-h-[44px]" onClick={downloadTemplate}>
                <FileDown className="h-4 w-4" aria-hidden /> Download template
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Import report</CardTitle>
          <CardDescription>Exactly what the server accepted and rejected.</CardDescription>
        </CardHeader>
        <CardContent>
          {!result ? (
            <p className="text-sm text-muted-foreground py-4 text-center">Run an import to see its result here.</p>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300">
                  {result.created} created
                </Badge>
                {result.errors.length > 0 && (
                  <Badge variant="outline" className="bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300">
                    {result.errors.length} rejected
                  </Badge>
                )}
              </div>
              {result.errors.length === 0 ? (
                <p className="text-sm text-emerald-700 dark:text-emerald-300">All rows imported successfully.</p>
              ) : (
                <div className="max-h-64 overflow-y-auto rounded-md border">
                  <Table>
                    <TableHeader className="sticky top-0 bg-background">
                      <TableRow><TableHead className="w-16">Row</TableHead><TableHead>Reason</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.errors.map((e, i) => (
                        <TableRow key={`${e.row}-${i}`}>
                          <TableCell>{e.row}</TableCell>
                          <TableCell className="text-rose-700 dark:text-rose-300">{e.message}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/* ---------------- main section ---------------- */

export function CustomersSection() {
  const { toast } = useToast()
  const [tab, setTab] = useState('directory')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [customers, setCustomers] = useState<Customer[]>([])
  const [query, setQuery] = useState('')
  const [viewTarget, setViewTarget] = useState<Customer | null>(null)
  const [editTarget, setEditTarget] = useState<Customer | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Customer | null>(null)
  const [newOpen, setNewOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.get<{ customers: Customer[] }>('/api/customers')
      setCustomers(res.customers)
    } catch (err) {
      setError(friendlyError(err, 'Could not load customers'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const refresh = () => { void load() }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return customers
    return customers.filter((c) =>
      c.name.toLowerCase().includes(q) ||
      (c.email ?? '').toLowerCase().includes(q) ||
      (c.phone ?? '').toLowerCase().includes(q)
    )
  }, [customers, query])

  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading customers">
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
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Customers</h2>
          <p className="text-sm text-muted-foreground">{customers.length} record{customers.length === 1 ? '' : 's'} · consent and opt-out are respected by every automated message.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="min-h-[44px]" onClick={refresh} aria-label="Refresh customers">
            <RefreshCw className="h-4 w-4" aria-hidden /><span className="hidden sm:inline">Refresh</span>
          </Button>
          <Button className="min-h-[44px]" onClick={() => setNewOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden /> New customer
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="directory" className="min-h-[44px]">Directory</TabsTrigger>
          <TabsTrigger value="import" className="min-h-[44px]">Import</TabsTrigger>
        </TabsList>

        <TabsContent value="directory" className="mt-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2"><Users className="h-4 w-4" aria-hidden /> Directory</CardTitle>
              <div className="relative pt-2">
                <Search className="absolute left-3 top-1/2 translate-y-[-30%] h-4 w-4 text-muted-foreground" aria-hidden />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name, email or phone…"
                  aria-label="Search customers"
                  className="pl-9 min-h-[44px]"
                />
              </div>
            </CardHeader>
            <CardContent>
              {filtered.length === 0 ? (
                <div className="py-8 text-center space-y-3">
                  <UserRound className="h-10 w-10 mx-auto text-muted-foreground" aria-hidden />
                  <p className="text-sm text-muted-foreground">
                    {customers.length === 0 ? 'No customers yet — add your first one or import a CSV.' : 'No customers match that search.'}
                  </p>
                  {customers.length === 0 && (
                    <Button className="min-h-[44px]" onClick={() => setNewOpen(true)}>
                      <Plus className="h-4 w-4" aria-hidden /> New customer
                    </Button>
                  )}
                </div>
              ) : (
                <div className="max-h-96 overflow-y-auto rounded-md border">
                  <Table>
                    <TableHeader className="sticky top-0 bg-background">
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead className="hidden md:table-cell">Phone</TableHead>
                        <TableHead className="hidden lg:table-cell">Email</TableHead>
                        <TableHead className="hidden sm:table-cell">Tags</TableHead>
                        <TableHead>Opt-out</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filtered.map((c) => (
                        <TableRow key={c.id}>
                          <TableCell className="font-medium">{c.name}</TableCell>
                          <TableCell className="hidden md:table-cell">{c.phone || '—'}</TableCell>
                          <TableCell className="hidden lg:table-cell max-w-[220px] truncate">{c.email || '—'}</TableCell>
                          <TableCell className="hidden sm:table-cell">
                            <span className="flex flex-wrap gap-1">
                              {c.tags.length === 0 ? <span className="text-muted-foreground text-xs">—</span> : c.tags.map((t) => <Badge key={t} variant="secondary">{t}</Badge>)}
                            </span>
                          </TableCell>
                          <TableCell>
                            {c.optOut
                              ? <ShieldOff className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-label="Opted out of all messages" />
                              : <span className="text-muted-foreground text-xs">no</span>}
                          </TableCell>
                          <TableCell className="text-right">
                            <span className="inline-flex justify-end gap-1">
                              <Button variant="ghost" size="sm" className="min-h-[44px]" onClick={() => setViewTarget(c)} aria-label={`View ${c.name}`}>
                                <Eye className="h-4 w-4" aria-hidden /><span className="sr-only sm:not-sr-only sm:inline">View</span>
                              </Button>
                              <Button variant="ghost" size="sm" className="min-h-[44px]" onClick={() => setEditTarget(c)} aria-label={`Edit ${c.name}`}>
                                <Pencil className="h-4 w-4" aria-hidden /><span className="sr-only sm:not-sr-only sm:inline">Edit</span>
                              </Button>
                              <Button variant="ghost" size="sm" className="min-h-[44px] text-destructive hover:text-destructive" onClick={() => setDeleteTarget(c)} aria-label={`Delete ${c.name}`}>
                                <Trash2 className="h-4 w-4" aria-hidden /><span className="sr-only">Delete</span>
                              </Button>
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="import" className="mt-4">
          <ImportTab onImported={refresh} />
        </TabsContent>
      </Tabs>

      <ViewCustomerDialog customer={viewTarget} onClose={() => setViewTarget(null)} onChanged={refresh} />
      <EditCustomerDialog customer={editTarget} onClose={() => setEditTarget(null)} onChanged={refresh} />
      <DeleteCustomerDialog customer={deleteTarget} onClose={() => setDeleteTarget(null)} onChanged={refresh} />
      <NewCustomerDialog open={newOpen} onClose={() => setNewOpen(false)} onChanged={() => { refresh(); toast({ title: 'Directory updated' }) }} />
    </div>
  )
}
