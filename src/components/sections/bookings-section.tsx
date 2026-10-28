'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { addDays, format, isToday, isTomorrow, startOfDay } from 'date-fns'
import { useAppStore } from '@/lib/client/store'
import {
  api, ApiClientError, formatMoney, formatDateTime, formatDate,
  type Booking, type Customer, type Service, type Staff,
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
  CalendarDays, CalendarPlus, Check, CheckCircle2, Clock, Loader2, RefreshCw,
  Repeat, Search, UserX, XCircle, Ban,
} from 'lucide-react'

/* API list rows carry a few fields beyond the shared type; keep local extension honest. */
type BookingRow = Booking & { createdAt?: string; cancelReason?: string }

/* ---------------- badges ---------------- */

const BOOKING_STATUS_CLASS: Record<string, string> = {
  confirmed: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-900',
  pending: 'bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-900',
  cancelled: 'bg-muted text-muted-foreground border-border',
  completed: 'bg-neutral-700 text-white border-neutral-700',
  no_show: 'bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-900',
}

const SOURCE_LABEL: Record<string, string> = {
  ai_chat: 'AI chat', ai_voice: 'AI voice', web: 'Web', manual: 'Manual',
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn(BOOKING_STATUS_CLASS[status] ?? 'bg-muted text-muted-foreground')}>
      {status === 'no_show' ? 'no-show' : status}
    </Badge>
  )
}

function SourceBadge({ source }: { source: string }) {
  return (
    <Badge variant="secondary" className="font-normal">
      {SOURCE_LABEL[source] ?? source}
    </Badge>
  )
}

function friendlyError(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError && err.message) return err.message
  if (err instanceof Error && err.message) return err.message
  return fallback
}

/* ---------------- shared bits ---------------- */

type BookingActionName = 'confirm' | 'complete' | 'no_show'

function dayKey(iso: string): string {
  return format(new Date(iso), 'yyyy-MM-dd')
}

function dayLabel(iso: string): string {
  const d = new Date(iso)
  if (isToday(d)) return `Today · ${format(d, 'EEEE, MMM d')}`
  if (isTomorrow(d)) return `Tomorrow · ${format(d, 'EEEE, MMM d')}`
  return format(d, 'EEEE, MMM d')
}

function localDateInputValue(iso: string): string {
  return format(new Date(iso), 'yyyy-MM-dd')
}

/** Fetches real open slots from /api/availability for a service + optional staff on one date. */
function SlotPicker({
  serviceId, staffId, date, value, onChange,
}: {
  serviceId: string
  staffId?: string
  date: string
  value: string
  onChange: (startAt: string | null) => void
}) {
  const [slots, setSlots] = useState<Array<{ startAt: string; endAt: string; staffId: string }>>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!serviceId || !date) return
    setLoading(true)
    setError('')
    try {
      const from = new Date(`${date}T00:00:00`)
      const to = new Date(`${date}T23:59:59.999`)
      const params = new URLSearchParams({ serviceId, from: from.toISOString(), to: to.toISOString() })
      if (staffId) params.set('staffId', staffId)
      const res = await api.get<{ slots: Array<{ startAt: string; endAt: string; staffId: string }> }>(`/api/availability?${params}`)
      setSlots(res.slots)
      onChange(null)
    } catch (err) {
      setError(friendlyError(err, 'Could not load availability'))
      setSlots([])
    } finally {
      setLoading(false)
    }
  }, [serviceId, staffId, date, onChange])

  useEffect(() => {
    if (serviceId && date) void load()
  }, [serviceId, date, load])

  if (!serviceId || !date) {
    return <p className="text-sm text-muted-foreground">Pick a service and a date to see open slots.</p>
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground min-h-[44px]">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading real open slots…
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-2">
        <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
        <Button type="button" variant="outline" size="sm" className="min-h-[44px]" onClick={() => void load()} title="Retry availability">
          <RefreshCw className="h-4 w-4" aria-hidden /> Retry availability
        </Button>
      </div>
    )
  }

  if (slots.length === 0) {
    return (
      <p className="text-sm text-amber-700 dark:text-amber-300 min-h-[44px] flex items-center">
        No open slots on this date for this service{staffId ? ' and staff member' : ''}. Try another date.
      </p>
    )
  }

  return (
    <div className="space-y-2" role="radiogroup" aria-label="Open time slots">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">{slots.length} open slot{slots.length === 1 ? '' : 's'} — pick one</p>
        <Button type="button" variant="ghost" size="sm" className="min-h-[44px]" onClick={() => void load()} aria-label="Refresh available slots" title="Refresh available slots">
          <RefreshCw className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {slots.map((s) => (
          <Button
            key={s.startAt}
            type="button"
            role="radio"
            aria-checked={value === s.startAt}
            variant={value === s.startAt ? 'default' : 'outline'}
            className="min-h-[44px] text-sm"
            onClick={() => onChange(s.startAt)}
            title={`Book ${format(new Date(s.startAt), 'h:mm a')}`}
          >
            {format(new Date(s.startAt), 'h:mm a')}
          </Button>
        ))}
      </div>
    </div>
  )
}

/** Inline status actions for one booking; owns its own reschedule + cancel dialogs. */
function BookingActions({ booking, onChanged }: { booking: Booking; onChanged: () => void }) {
  const { toast } = useToast()
  const [busy, setBusy] = useState<BookingActionName | null>(null)
  const [rescheduleOpen, setRescheduleOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)

  const canAct = booking.status === 'pending' || booking.status === 'confirmed'

  const run = async (action: BookingActionName, label: string) => {
    setBusy(action)
    try {
      await api.patch(`/api/bookings/${booking.id}`, { action })
      toast({ title: label, description: `${booking.customer?.name ?? 'Booking'} — ${booking.service?.name ?? ''}` })
      onChanged()
    } catch (err) {
      toast({ title: 'Action failed', description: friendlyError(err, `Could not ${label.toLowerCase()}`), variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label={`Actions for booking ${booking.service?.name ?? booking.id}`}>
      {booking.status === 'pending' && (
        <Button type="button" size="sm" className="min-h-[44px]" disabled={busy !== null} onClick={() => void run('confirm', 'Booking confirmed')} title="Confirm">
          {busy === 'confirm' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
          Confirm
        </Button>
      )}
      {booking.status === 'confirmed' && (
        <Button type="button" size="sm" className="min-h-[44px]" disabled={busy !== null} onClick={() => void run('complete', 'Booking completed')} title="Complete">
          {busy === 'complete' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}
          Complete
        </Button>
      )}
      {booking.status === 'confirmed' && (
        <Button type="button" size="sm" variant="outline" className="min-h-[44px]" disabled={busy !== null} onClick={() => void run('no_show', 'Marked as no-show')} title="No-show">
          {busy === 'no_show' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <UserX className="h-4 w-4" aria-hidden />}
          No-show
        </Button>
      )}
      {canAct && (
        <Button type="button" size="sm" variant="outline" className="min-h-[44px]" onClick={() => setRescheduleOpen(true)} title="Reschedule">
          <Repeat className="h-4 w-4" aria-hidden /> Reschedule
        </Button>
      )}
      {canAct && (
        <Button type="button" size="sm" variant="outline" className="min-h-[44px] text-destructive hover:text-destructive" onClick={() => setCancelOpen(true)} title="Cancel">
          <Ban className="h-4 w-4" aria-hidden /> Cancel
        </Button>
      )}

      <RescheduleDialog
        booking={rescheduleOpen ? booking : null}
        onClose={() => setRescheduleOpen(false)}
        onChanged={onChanged}
      />
      <CancelBookingDialog
        booking={cancelOpen ? booking : null}
        onClose={() => setCancelOpen(false)}
        onChanged={onChanged}
      />
    </div>
  )
}

function RescheduleDialog({
  booking, onClose, onChanged,
}: { booking: Booking | null; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast()
  const [date, setDate] = useState('')
  const [slot, setSlot] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (booking) {
      setDate(localDateInputValue(booking.startAt))
      setSlot(null)
      setError('')
    }
  }, [booking])

  const submit = async () => {
    if (!booking || !slot) return
    setBusy(true)
    setError('')
    try {
      await api.patch(`/api/bookings/${booking.id}`, { action: 'reschedule', startAt: slot })
      toast({ title: 'Booking rescheduled', description: `${booking.customer?.name ?? ''} moved to ${format(new Date(slot), 'EEE, MMM d · h:mm a')}` })
      onClose()
      onChanged()
    } catch (err) {
      setError(friendlyError(err, 'Could not reschedule'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!booking} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Reschedule booking</DialogTitle>
          <DialogDescription>
            {booking ? `${booking.customer?.name ?? 'Customer'} — ${booking.service?.name ?? ''}. Only real open slots are shown.` : ''}
          </DialogDescription>
        </DialogHeader>
        {booking && (
          <div className="space-y-4">
            {error && (
              <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="reschedule-date">New date</Label>
              <Input
                id="reschedule-date"
                type="date"
                value={date}
                min={format(new Date(), 'yyyy-MM-dd')}
                onChange={(e) => setDate(e.target.value)}
                className="min-h-[44px]"
              />
            </div>
            <SlotPicker
              serviceId={booking.serviceId}
              staffId={booking.staffId ?? undefined}
              date={date}
              value={slot ?? ''}
              onChange={setSlot}
            />
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" className="min-h-[44px]" onClick={onClose} title="Close">Close</Button>
          <Button type="button" className="min-h-[44px]" disabled={!slot || busy} onClick={() => void submit()} title="Move to selected slot">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
            Move to selected slot
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CancelBookingDialog({
  booking, onClose, onChanged,
}: { booking: Booking | null; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (booking) {
      setReason('')
      setError('')
    }
  }, [booking])

  const submit = async () => {
    if (!booking) return
    setBusy(true)
    setError('')
    try {
      await api.patch(`/api/bookings/${booking.id}`, { action: 'cancel', reason: reason.trim() || undefined })
      toast({ title: 'Booking cancelled', description: `${booking.customer?.name ?? 'Customer'} — ${booking.service?.name ?? ''}` })
      onClose()
      onChanged()
    } catch (err) {
      setError(friendlyError(err, 'Could not cancel booking'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open={!!booking} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this booking?</AlertDialogTitle>
          <AlertDialogDescription>
            {booking ? `This cancels ${booking.customer?.name ?? 'the customer'}'s ${booking.service?.name ?? 'appointment'} on ${formatDateTime(booking.startAt)}. The slot is released immediately.` : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="cancel-reason">Reason (optional, kept on the record)</Label>
          <Textarea
            id="cancel-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Customer asked to move it; staff sick"
            className="min-h-[44px]"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-[44px]">Keep booking</AlertDialogCancel>
          <AlertDialogAction
            className="min-h-[44px] bg-destructive text-white hover:bg-destructive/90"
            disabled={busy}
            onClick={(e) => { e.preventDefault(); void submit() }}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <XCircle className="h-4 w-4" aria-hidden />}
            Cancel booking
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function BookingLine({ booking, onChanged }: { booking: Booking; onChanged: () => void }) {
  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold min-h-[44px] sm:min-h-0">
          <Clock className="h-4 w-4 text-muted-foreground" aria-hidden />
          {format(new Date(booking.startAt), 'h:mm a')}
        </span>
        <span className="text-sm font-medium truncate">
          {booking.customer?.name ?? 'Customer'} — {booking.service?.name ?? 'Service'}
        </span>
        <StatusBadge status={booking.status} />
        <SourceBadge source={booking.source} />
        <span className="ml-auto text-sm text-muted-foreground">{formatMoney(booking.priceCents)}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {booking.staff?.name ? `with ${booking.staff.name}` : 'staff: any available'}
        {' · '}{format(new Date(booking.startAt), 'h:mm a')}–{format(new Date(booking.endAt), 'h:mm a')}
        {booking.notes ? ` · ${booking.notes}` : ''}
      </p>
      <div className="pt-1">
        <BookingActions booking={booking} onChanged={onChanged} />
      </div>
    </div>
  )
}

/* ---------------- upcoming tab ---------------- */

function UpcomingTab({
  bookings, onCreate, onChanged,
}: { bookings: Booking[]; onCreate: () => void; onChanged: () => void }) {
  const groups = useMemo(() => {
    const today = startOfDay(new Date())
    const upcoming = bookings
      .filter((b) => (b.status === 'pending' || b.status === 'confirmed') && new Date(b.startAt) >= today)
      .sort((a, b) => a.startAt.localeCompare(b.startAt))
    const map = new Map<string, Booking[]>()
    for (const b of upcoming) {
      const k = dayKey(b.startAt)
      const list = map.get(k) ?? []
      list.push(b)
      map.set(k, list)
    }
    return [...map.entries()]
  }, [bookings])

  if (groups.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center space-y-3">
          <CalendarDays className="h-10 w-10 mx-auto text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">No upcoming appointments. Booked slots (pending or confirmed) will appear here grouped by day.</p>
          <Button className="min-h-[44px]" onClick={onCreate} title="Create booking">
            <CalendarPlus className="h-4 w-4" aria-hidden /> Create booking
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {groups.map(([key, list]) => (
        <Card key={key}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              {dayLabel(list[0].startAt)}
              <Badge variant="secondary">{list.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {list.map((b) => (
              <div key={b.id} className="rounded-lg border p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                    <Clock className="h-4 w-4 text-muted-foreground" aria-hidden />
                    {format(new Date(b.startAt), 'h:mm a')}–{format(new Date(b.endAt), 'h:mm a')}
                  </span>
                  <span className="text-sm font-medium">{b.customer?.name ?? 'Customer'} — {b.service?.name ?? 'Service'}</span>
                  <StatusBadge status={b.status} />
                  <SourceBadge source={b.source} />
                  <span className="ml-auto text-sm text-muted-foreground">{formatMoney(b.priceCents)}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {b.staff?.name ? `with ${b.staff.name}` : 'staff: any available'}{b.notes ? ` · ${b.notes}` : ''}
                </p>
                <BookingActions booking={b} onChanged={onChanged} />
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

/* ---------------- calendar tab ---------------- */

function CalendarTab({ bookings, onChanged }: { bookings: Booking[]; onChanged: () => void }) {
  const [selected, setSelected] = useState<string>(format(new Date(), 'yyyy-MM-dd'))
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(startOfDay(new Date()), i)),
    []
  )
  const byDay = useMemo(() => {
    const map = new Map<string, Booking[]>()
    for (const b of bookings) {
      const k = dayKey(b.startAt)
      const list = map.get(k) ?? []
      list.push(b)
      map.set(k, list)
    }
    for (const list of map.values()) list.sort((a, b) => a.startAt.localeCompare(b.startAt))
    return map
  }, [bookings])

  const selectedList = byDay.get(selected) ?? []

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-7 gap-1.5" role="listbox" aria-label="Next 7 days">
        {days.map((d) => {
          const k = format(d, 'yyyy-MM-dd')
          const list = byDay.get(k) ?? []
          const active = k === selected
          return (
            <button
              key={k}
              type="button"
              role="option"
              aria-selected={active}
              onClick={() => setSelected(k)}
              title={isToday(d) ? 'Today, ' + format(d, 'MMMM d') : format(d, 'EEEE, MMMM d')}
              className={cn(
                'rounded-lg border p-2 min-h-[72px] text-left transition-colors hover:bg-muted/60',
                active ? 'border-primary bg-primary/5' : ''
              )}
            >
              <p className={cn('text-xs font-medium', isToday(d) && 'text-primary')}>{isToday(d) ? 'Today' : format(d, 'EEE')}</p>
              <p className="text-sm font-semibold">{format(d, 'MMM d')}</p>
              <p className="text-[11px] text-muted-foreground mt-1">{list.length > 0 ? `${list.length} booked` : 'free'}</p>
            </button>
          )
        })}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {format(new Date(`${selected}T12:00:00`), 'EEEE, MMM d')}
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {selectedList.length === 0 ? '— no bookings' : `— ${selectedList.length} booking${selectedList.length === 1 ? '' : 's'}`}
            </span>
          </CardTitle>
          <CardDescription>All statuses for this day. Click a day above to switch.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {selectedList.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">Nothing booked on this day — slots are open.</p>
          ) : (
            selectedList.map((b) => <BookingLine key={b.id} booking={b} onChanged={onChanged} />)
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/* ---------------- new booking tab ---------------- */

function NewBookingForm({
  services, staff, customers, onCreated,
}: {
  services: Service[]
  staff: Staff[]
  customers: Customer[]
  onCreated: () => void
}) {
  const { toast } = useToast()
  const [customerId, setCustomerId] = useState('')
  const [newName, setNewName] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [serviceId, setServiceId] = useState('')
  const [staffId, setStaffId] = useState('any')
  const [date, setDate] = useState('')
  const [slot, setSlot] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const service = services.find((s) => s.id === serviceId)
  const staffOptions = useMemo(() => {
    if (!serviceId) return staff
    const linked = staff.filter((st) => (st.serviceIds ?? []).includes(serviceId))
    return linked.length > 0 ? linked : staff
  }, [staff, serviceId])

  const canSubmit = serviceId && date && slot && (customerId === '__new' ? newName.trim().length > 0 : customerId)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit || !slot) return
    setBusy(true)
    setError('')
    try {
      let cid = customerId
      if (customerId === '__new') {
        const created = await api.post<Customer>('/api/customers', {
          name: newName.trim(),
          phone: newPhone.trim() || undefined,
        })
        cid = created.id
      }
      await api.post<Booking>('/api/bookings', {
        customerId: cid,
        serviceId,
        staffId: staffId !== 'any' ? staffId : undefined,
        startAt: slot,
        notes: notes.trim() || undefined,
      })
      toast({ title: 'Booking created', description: format(new Date(slot), 'EEE, MMM d · h:mm a') })
      setCustomerId(''); setNewName(''); setNewPhone(''); setServiceId('')
      setStaffId('any'); setDate(''); setSlot(null); setNotes('')
      onCreated()
    } catch (err) {
      setError(friendlyError(err, 'Could not create booking'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New booking</CardTitle>
        <CardDescription>Only real open slots can be booked — the availability engine guards against double-booking.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4 max-w-2xl" aria-label="New booking form">
          {error && (
            <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="nb-customer">Customer</Label>
              <Select value={customerId} onValueChange={setCustomerId} required>
                <SelectTrigger id="nb-customer" className="min-h-[44px] w-full" aria-label="Select customer">
                  <SelectValue placeholder="Choose customer…" />
                </SelectTrigger>
                <SelectContent>
                  {customers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ''}</SelectItem>
                  ))}
                  <SelectItem value="__new">+ New customer…</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nb-service">Service</Label>
              <Select value={serviceId} onValueChange={(v) => { setServiceId(v); setSlot(null) }} required>
                <SelectTrigger id="nb-service" className="min-h-[44px] w-full" aria-label="Select service">
                  <SelectValue placeholder="Choose service…" />
                </SelectTrigger>
                <SelectContent>
                  {services.filter((s) => s.active).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name} · {s.durationMin} min · {formatMoney(s.priceCents)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {customerId === '__new' && (
            <div className="rounded-lg border bg-muted/40 p-3 grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="nb-new-name">New customer name</Label>
                <Input id="nb-new-name" value={newName} onChange={(e) => setNewName(e.target.value)} required placeholder="Jordan Lee" className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nb-new-phone">Phone (optional)</Label>
                <Input id="nb-new-phone" type="tel" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="+1 555 000 1234" className="min-h-[44px]" />
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-2">The customer record is created first, then the booking uses it.</p>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="nb-staff">Staff (optional)</Label>
              <Select value={staffId} onValueChange={(v) => { setStaffId(v); setSlot(null) }}>
                <SelectTrigger id="nb-staff" className="min-h-[44px] w-full" aria-label="Select staff member">
                  <SelectValue placeholder="Any available" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any available</SelectItem>
                  {staffOptions.map((st) => (
                    <SelectItem key={st.id} value={st.id}>{st.name}{st.role ? ` · ${st.role}` : ''}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {serviceId && (
                <p className="text-xs text-muted-foreground">
                  {staffOptions.length === staff.length && !staff.some((st) => (st.serviceIds ?? []).includes(serviceId))
                    ? 'No staff are linked to this service yet — showing everyone.'
                    : `Showing staff linked to ${service?.name ?? 'this service'}.`}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nb-date">Date</Label>
              <Input
                id="nb-date" type="date" value={date}
                min={format(new Date(), 'yyyy-MM-dd')}
                onChange={(e) => { setDate(e.target.value); setSlot(null) }}
                className="min-h-[44px]"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Time slot (from real availability)</Label>
            <SlotPicker
              serviceId={serviceId}
              staffId={staffId !== 'any' ? staffId : undefined}
              date={date}
              value={slot ?? ''}
              onChange={setSlot}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="nb-notes">Notes (optional)</Label>
            <Textarea id="nb-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything the staff should know…" className="min-h-[44px]" />
          </div>

          <Button type="submit" className="min-h-[44px]" disabled={!canSubmit || busy} title="Create booking">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CalendarPlus className="h-4 w-4" aria-hidden />}
            Create booking
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

/* ---------------- all bookings tab ---------------- */

function AllBookingsTab({
  bookings, onChanged,
}: { bookings: Booking[]; onChanged: () => void }) {
  const [status, setStatus] = useState('all')
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState<BookingRow | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return bookings
      .filter((b) => status === 'all' || b.status === status)
      .filter((b) => !q || (b.customer?.name ?? '').toLowerCase().includes(q) || (b.service?.name ?? '').toLowerCase().includes(q))
      .sort((a, b) => b.startAt.localeCompare(a.startAt))
  }, [bookings, status, query])

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">All bookings</CardTitle>
        <CardDescription>Every booking in every status. Click a row for details and actions.</CardDescription>
        <div className="flex flex-col sm:flex-row gap-2 pt-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search customer or service…"
              aria-label="Search bookings by customer or service"
              className="pl-9 min-h-[44px]"
            />
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="min-h-[44px] sm:w-48" aria-label="Filter by status">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="confirmed">Confirmed</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
              <SelectItem value="no_show">No-show</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No bookings match these filters.</p>
        ) : (
          <div className="max-h-96 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="hidden md:table-cell">Service</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden sm:table-cell">Source</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((b) => (
                  <TableRow
                    key={b.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    aria-label={`Booking ${b.customer?.name ?? ''} ${b.service?.name ?? ''} — open details`}
                    onClick={() => setDetail(b)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetail(b) } }}
                  >
                    <TableCell className="whitespace-nowrap">{formatDateTime(b.startAt)}</TableCell>
                    <TableCell className="font-medium">{b.customer?.name ?? '—'}</TableCell>
                    <TableCell className="hidden md:table-cell">{b.service?.name ?? '—'}</TableCell>
                    <TableCell><StatusBadge status={b.status} /></TableCell>
                    <TableCell className="hidden sm:table-cell"><SourceBadge source={b.source} /></TableCell>
                    <TableCell className="text-right">{formatMoney(b.priceCents)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <Dialog open={!!detail} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Booking details</DialogTitle>
            <DialogDescription>
              {detail ? `${detail.customer?.name ?? 'Customer'} — ${detail.service?.name ?? 'Service'}` : ''}
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-muted-foreground">When:</span> {formatDateTime(detail.startAt)}</div>
                <div><span className="text-muted-foreground">Until:</span> {format(new Date(detail.endAt), 'h:mm a')}</div>
                <div><span className="text-muted-foreground">Staff:</span> {detail.staff?.name ?? 'any available'}</div>
                <div><span className="text-muted-foreground">Price:</span> {formatMoney(detail.priceCents)}</div>
                <div><span className="text-muted-foreground">Status:</span> <StatusBadge status={detail.status} /></div>
                <div><span className="text-muted-foreground">Source:</span> <SourceBadge source={detail.source} /></div>
                <div><span className="text-muted-foreground">Created:</span> {detail.createdAt ? formatDate(detail.createdAt) : '—'}</div>
                {detail.cancelReason && <div className="col-span-2"><span className="text-muted-foreground">Cancel reason:</span> {detail.cancelReason}</div>}
              </div>
              {detail.notes && (
                <div className="text-sm">
                  <Separator className="my-2" />
                  <span className="text-muted-foreground">Notes:</span> {detail.notes}
                </div>
              )}
              {detail.status === 'cancelled' && (
                <p className="text-sm text-rose-700 dark:text-rose-300">This booking was cancelled.</p>
              )}
              <Separator />
              <BookingActions booking={detail} onChanged={() => { setDetail(null); onChanged() }} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/* ---------------- main section ---------------- */

export function BookingsSection() {
  const [tab, setTab] = useState('upcoming')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [bookings, setBookings] = useState<Booking[]>([])
  const [services, setServices] = useState<Service[]>([])
  const [staff, setStaff] = useState<Staff[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [b, s, st, c] = await Promise.all([
        api.get<{ bookings: Booking[] }>('/api/bookings'),
        api.get<{ services: Service[] }>('/api/services'),
        api.get<{ staff: Staff[] }>('/api/staff'),
        api.get<{ customers: Customer[] }>('/api/customers'),
      ])
      setBookings(b.bookings)
      setServices(s.services)
      setStaff(st.staff)
      setCustomers(c.customers)
    } catch (err) {
      setError(friendlyError(err, 'Could not load bookings'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const refresh = () => { void load() }

  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading bookings">
        <Skeleton className="h-10 w-full max-w-md" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-4">
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <Button className="min-h-[44px]" onClick={() => void load()} title="Retry">
          <RefreshCw className="h-4 w-4" aria-hidden /> Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Bookings</h2>
          <p className="text-sm text-muted-foreground">Confirm, complete, reschedule or cancel — all actions hit the real booking engine.</p>
        </div>
        <Button variant="outline" className="min-h-[44px]" onClick={refresh} aria-label="Refresh bookings" title="Refresh bookings">
          <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
        </Button>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="upcoming" className="min-h-[44px]">Upcoming</TabsTrigger>
          <TabsTrigger value="calendar" className="min-h-[44px]">Calendar</TabsTrigger>
          <TabsTrigger value="new" className="min-h-[44px]">New booking</TabsTrigger>
          <TabsTrigger value="all" className="min-h-[44px]">All</TabsTrigger>
        </TabsList>

        <TabsContent value="upcoming" className="mt-4 space-y-4">
          <UpcomingTab bookings={bookings} onCreate={() => setTab('new')} onChanged={refresh} />
        </TabsContent>

        <TabsContent value="calendar" className="mt-4">
          <CalendarTab bookings={bookings} onChanged={refresh} />
        </TabsContent>

        <TabsContent value="new" className="mt-4">
          <NewBookingForm
            services={services}
            staff={staff}
            customers={customers}
            onCreated={() => { refresh(); setTab('upcoming') }}
          />
        </TabsContent>

        <TabsContent value="all" className="mt-4">
          <AllBookingsTab bookings={bookings} onChanged={refresh} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
