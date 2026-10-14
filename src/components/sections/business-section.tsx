'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/lib/client/store'
import { api, type SessionInfo } from '@/lib/client/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { useToast } from '@/hooks/use-toast'
import { Loader2, RefreshCw, TriangleAlert, Eye } from 'lucide-react'

type OrgProfile = {
  name?: string
  businessType?: string
  timezone?: string
  locale?: string
  currency?: string
  address?: string
  phone?: string
  email?: string
  openingHours?: string | null
  holidays?: string | null
  policies?: string | null
  aiIdentity?: string | null
  collectionsCfg?: string | null
}

type HoursState = Record<string, { open: boolean; start: string; end: string }>

const BUSINESS_TYPES = [
  { value: 'apartment_rental', label: 'Apartment rental' },
  { value: 'car_rental', label: 'Car rental' },
  { value: 'salon', label: 'Salon' },
  { value: 'clinic', label: 'Clinic' },
  { value: 'contractor', label: 'Contractor' },
  { value: 'generic', label: 'Generic' },
]

const TIMEZONES = [
  'UTC-08:00', 'UTC-07:00', 'UTC-06:00', 'UTC-05:00', 'UTC-04:00', 'UTC-03:00',
  'UTC+00:00', 'UTC+01:00', 'UTC+02:00', 'UTC+03:00', 'UTC+03:30', 'UTC+04:00',
  'UTC+05:00', 'UTC+05:30', 'UTC+06:00', 'UTC+07:00', 'UTC+08:00', 'UTC+09:00',
  'UTC+09:30', 'UTC+10:00', 'UTC+12:00',
]

const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'AED', 'SGD']

const TONES = [
  { value: 'professional', label: 'Professional' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'concise', label: 'Concise' },
]

const WEEKDAYS = [
  { dow: '0', label: 'Sunday' },
  { dow: '1', label: 'Monday' },
  { dow: '2', label: 'Tuesday' },
  { dow: '3', label: 'Wednesday' },
  { dow: '4', label: 'Thursday' },
  { dow: '5', label: 'Friday' },
  { dow: '6', label: 'Saturday' },
]

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function parseJsonSafe<T extends object>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    const v = JSON.parse(raw)
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as T
    return fallback
  } catch {
    return fallback
  }
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function defaultHours(): HoursState {
  const h: HoursState = {}
  for (const d of WEEKDAYS) h[d.dow] = { open: false, start: '09:00', end: '17:00' }
  return h
}

function EditableHint({ canEdit }: { canEdit: boolean }) {
  return (
    <p className="text-xs text-muted-foreground">
      {canEdit ? 'Changes apply when you press Save for this group.' : 'View only — sign in as owner or admin to edit.'}
    </p>
  )
}

export function BusinessSection() {
  const session = useAppStore((s) => s.session)
  const setSession = useAppStore((s) => s.setSession)
  const { toast } = useToast()

  const role = session?.user?.role ?? ''
  const canEdit = role === 'owner' || role === 'admin'

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  // Group 1: business profile
  const [biz, setBiz] = useState({
    name: '', businessType: 'generic', timezone: 'UTC+00:00', locale: 'en',
    currency: 'USD', address: '', phone: '', email: '',
  })
  const initialName = useRef('')

  // Group 2: opening hours + holidays
  const [hours, setHours] = useState<HoursState>(defaultHours)
  const [holidaysText, setHolidaysText] = useState('')

  // Group 3: policies
  const [policies, setPolicies] = useState({
    autoConfirmBookings: false, minHoursBefore: 24, depositRequired: false,
    quietStart: '21:00', quietEnd: '08:00',
  })

  // Group 4: AI identity
  const [identity, setIdentity] = useState({
    businessTone: 'friendly', greeting: '', closing: '', escalationNote: '',
  })

  // Group 5: collections
  const [collections, setCollections] = useState({
    reminderDays: '1, 3, 7', maxTouches: 3, quietStart: '21:00', quietEnd: '08:00',
    tplFirst: '', tplSecond: '', tplFinal: '',
  })

  const hydrate = useCallback((org: OrgProfile) => {
    const tz = org.timezone || 'UTC+00:00'
    initialName.current = org.name ?? ''
    setBiz({
      name: org.name ?? '',
      businessType: org.businessType || 'generic',
      timezone: tz,
      locale: org.locale || 'en',
      currency: CURRENCIES.includes(org.currency ?? '') ? (org.currency as string) : 'USD',
      address: org.address ?? '',
      phone: org.phone ?? '',
      email: org.email ?? '',
    })

    const rawHours = parseJsonSafe<Record<string, unknown>>(org.openingHours, {})
    const nextHours = defaultHours()
    for (const d of WEEKDAYS) {
      const win = Array.isArray(rawHours[d.dow]) ? (rawHours[d.dow] as unknown[]) : []
      const first = Array.isArray(win[0]) ? (win[0] as unknown[]) : []
      nextHours[d.dow] = {
        open: win.length > 0,
        start: typeof first[0] === 'string' ? first[0] : '09:00',
        end: typeof first[1] === 'string' ? first[1] : '17:00',
      }
    }
    setHours(nextHours)
    setHolidaysText(parseStringArray(org.holidays).join(', '))

    const pol = parseJsonSafe<{
      autoConfirmBookings?: boolean
      cancellation?: { minHoursBefore?: number }
      deposit?: { requiredForBooking?: boolean }
      quietHours?: { start?: string; end?: string }
    }>(org.policies, {})
    setPolicies({
      autoConfirmBookings: Boolean(pol.autoConfirmBookings),
      minHoursBefore: typeof pol.cancellation?.minHoursBefore === 'number' ? pol.cancellation.minHoursBefore : 24,
      depositRequired: Boolean(pol.deposit?.requiredForBooking),
      quietStart: pol.quietHours?.start || '21:00',
      quietEnd: pol.quietHours?.end || '08:00',
    })

    const ident = parseJsonSafe<{ businessTone?: string; greeting?: string; closing?: string; escalationNote?: string }>(
      org.aiIdentity, {}
    )
    setIdentity({
      businessTone: TONES.some((t) => t.value === ident.businessTone) ? (ident.businessTone as string) : 'friendly',
      greeting: ident.greeting ?? '',
      closing: ident.closing ?? '',
      escalationNote: ident.escalationNote ?? '',
    })

    const col = parseJsonSafe<{
      reminderDays?: number[]
      maxTouchesPerInvoice?: number
      quietStart?: string
      quietEnd?: string
      templates?: { first?: string; second?: string; final?: string }
    }>(org.collectionsCfg, {})
    setCollections({
      reminderDays: Array.isArray(col.reminderDays) ? col.reminderDays.join(', ') : '1, 3, 7',
      maxTouches: typeof col.maxTouchesPerInvoice === 'number' ? col.maxTouchesPerInvoice : 3,
      quietStart: col.quietStart || '21:00',
      quietEnd: col.quietEnd || '08:00',
      tplFirst: col.templates?.first ?? '',
      tplSecond: col.templates?.second ?? '',
      tplFinal: col.templates?.final ?? '',
    })
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const s = await api.get<{ state: Record<string, unknown>; org: OrgProfile }>('/api/setup')
      hydrate(s.org)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load business settings')
    } finally {
      setLoading(false)
    }
  }, [hydrate])

  useEffect(() => {
    void load()
  }, [load])

  const failToast = (err: unknown, what: string) => {
    toast({
      title: `Could not save ${what}`,
      description: err instanceof Error ? err.message : 'Unexpected error',
      variant: 'destructive',
    })
  }

  const saveGroup = async (key: string, data: Record<string, unknown>, label: string) => {
    setSaving(key)
    try {
      await api.put('/api/setup', { step: key === 'hours' ? 'business' : key, data })
      if (key === 'business' && biz.name !== initialName.current) {
        // Organization name is shown in the sidebar — refresh the session copy.
        const sess = await api.get<SessionInfo>('/api/session')
        setSession(sess)
        initialName.current = biz.name
      }
      toast({ title: `${label} saved`, description: 'Your changes are live.' })
    } catch (err) {
      failToast(err, label)
    } finally {
      setSaving(null)
    }
  }

  const saveBusiness = () => void saveGroup('business', { ...biz }, 'Business profile')

  const saveHours = () => {
    for (const d of WEEKDAYS) {
      const h = hours[d.dow]
      if (h.open && (!h.start || !h.end || h.start >= h.end)) {
        toast({
          title: 'Check opening hours',
          description: `${d.label}: the end time must be after the start time.`,
          variant: 'destructive',
        })
        return
      }
    }
    const holidaysList = holidaysText
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    const invalid = holidaysList.filter((s) => !DATE_RE.test(s))
    if (invalid.length > 0) {
      toast({
        title: 'Invalid holiday dates',
        description: `Use YYYY-MM-DD dates, comma separated. Problem: ${invalid.join(', ')}`,
        variant: 'destructive',
      })
      return
    }
    const openingHours: Record<string, string[][]> = {}
    for (const d of WEEKDAYS) {
      const h = hours[d.dow]
      openingHours[d.dow] = h.open ? [[h.start, h.end]] : []
    }
    void saveGroup('hours', { openingHours, holidays: holidaysList }, 'Opening hours & holidays')
  }

  const savePolicies = () => {
    if (!Number.isFinite(policies.minHoursBefore) || policies.minHoursBefore < 0) {
      toast({
        title: 'Check cancellation policy',
        description: 'Minimum hours before must be zero or more.',
        variant: 'destructive',
      })
      return
    }
    void saveGroup(
      'policies',
      {
        policies: {
          autoConfirmBookings: policies.autoConfirmBookings,
          cancellation: { minHoursBefore: Math.round(policies.minHoursBefore) },
          deposit: { requiredForBooking: policies.depositRequired },
          quietHours: { start: policies.quietStart, end: policies.quietEnd },
        },
      },
      'Policies'
    )
  }

  const saveIdentity = () =>
    void saveGroup(
      'ai_identity',
      {
        aiIdentity: {
          businessTone: identity.businessTone,
          greeting: identity.greeting,
          closing: identity.closing,
          escalationNote: identity.escalationNote,
        },
      },
      'AI identity'
    )

  const saveCollections = () => {
    const days = collections.reminderDays
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n >= 0)
    if (collections.reminderDays.trim() && days.length === 0) {
      toast({
        title: 'Check reminder days',
        description: 'Enter day offsets as numbers, comma separated — e.g. 1, 3, 7.',
        variant: 'destructive',
      })
      return
    }
    if (!Number.isFinite(collections.maxTouches) || collections.maxTouches < 0) {
      toast({
        title: 'Check max touches',
        description: 'Max touches per invoice must be zero or more.',
        variant: 'destructive',
      })
      return
    }
    void saveGroup(
      'collections',
      {
        collectionsCfg: {
          reminderDays: [...new Set(days)].sort((a, b) => a - b),
          maxTouchesPerInvoice: Math.round(collections.maxTouches),
          quietStart: collections.quietStart,
          quietEnd: collections.quietEnd,
          templates: {
            first: collections.tplFirst,
            second: collections.tplSecond,
            final: collections.tplFinal,
          },
        },
      },
      'Collections settings'
    )
  }

  if (loading) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading business profile">
        <Skeleton className="h-8 w-64" />
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-64" />
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {Array.from({ length: 4 }).map((_, j) => (
                <Skeleton key={j} className="h-16" />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-4">
        <Alert variant="destructive" role="alert">
          <TriangleAlert className="h-4 w-4" aria-hidden />
          <AlertTitle>Business settings unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <Button onClick={() => void load()} className="min-h-[44px]">
          <RefreshCw className="h-4 w-4" aria-hidden />
          Retry
        </Button>
      </div>
    )
  }

  const timezoneOptions = TIMEZONES.includes(biz.timezone) ? TIMEZONES : [biz.timezone, ...TIMEZONES]

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Business Profile</h1>
          <p className="text-sm text-muted-foreground">
            How your business appears to customers and what the AI receptionist may say or promise.
          </p>
        </div>
      </div>

      {!canEdit && (
        <Alert role="status">
          <Eye className="h-4 w-4" aria-hidden />
          <AlertTitle>Read-only view</AlertTitle>
          <AlertDescription>
            You are signed in as <strong>{role || 'a limited user'}</strong>. Only owners and admins can edit business
            settings — the forms below are disabled.
          </AlertDescription>
        </Alert>
      )}

      {/* ---------------- Group 1: Business profile ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Business profile</CardTitle>
          <CardDescription>Identity, contact details, timezone and currency used across the app.</CardDescription>
          <EditableHint canEdit={canEdit} />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="biz-name">Business name</Label>
              <Input
                id="biz-name"
                value={biz.name}
                disabled={!canEdit}
                onChange={(e) => setBiz({ ...biz, name: e.target.value })}
                placeholder="Harborview Salon"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="biz-type">Business type</Label>
              <Select value={biz.businessType} onValueChange={(v) => setBiz({ ...biz, businessType: v })} disabled={!canEdit}>
                <SelectTrigger id="biz-type" className="w-full min-h-[44px]" aria-label="Business type">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {BUSINESS_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="biz-tz">Timezone</Label>
              <Select value={biz.timezone} onValueChange={(v) => setBiz({ ...biz, timezone: v })} disabled={!canEdit}>
                <SelectTrigger id="biz-tz" className="w-full min-h-[44px]" aria-label="Timezone">
                  <SelectValue placeholder="Select timezone" />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {timezoneOptions.map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Fixed offset (no DST) — bookings are computed against this.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="biz-locale">Locale</Label>
              <Input
                id="biz-locale"
                value={biz.locale}
                disabled={!canEdit}
                onChange={(e) => setBiz({ ...biz, locale: e.target.value })}
                placeholder="en"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="biz-currency">Currency</Label>
              <Select value={biz.currency} onValueChange={(v) => setBiz({ ...biz, currency: v })} disabled={!canEdit}>
                <SelectTrigger id="biz-currency" className="w-full min-h-[44px]" aria-label="Currency">
                  <SelectValue placeholder="Select currency" />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="biz-phone">Phone</Label>
              <Input
                id="biz-phone"
                type="tel"
                value={biz.phone}
                disabled={!canEdit}
                onChange={(e) => setBiz({ ...biz, phone: e.target.value })}
                placeholder="+1 555 010 2233"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-1 lg:col-span-2">
              <Label htmlFor="biz-email">Email</Label>
              <Input
                id="biz-email"
                type="email"
                value={biz.email}
                disabled={!canEdit}
                onChange={(e) => setBiz({ ...biz, email: e.target.value })}
                placeholder="hello@business.example"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
              <Label htmlFor="biz-address">Address</Label>
              <Input
                id="biz-address"
                value={biz.address}
                disabled={!canEdit}
                onChange={(e) => setBiz({ ...biz, address: e.target.value })}
                placeholder="12 Marina Boulevard, Suite 200"
              />
            </div>
          </div>
          {canEdit && (
            <div className="flex justify-end">
              <Button onClick={saveBusiness} disabled={saving !== null} className="min-h-[44px]">
                {saving === 'business' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Save business profile
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------------- Group 2: Opening hours & holidays ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Opening hours &amp; holidays</CardTitle>
          <CardDescription>
            One window per weekday. Closed days are excluded from availability; holidays are skipped entirely.
          </CardDescription>
          <EditableHint canEdit={canEdit} />
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-2">
            {WEEKDAYS.map((d) => {
              const h = hours[d.dow]
              return (
                <li
                  key={d.dow}
                  className="flex flex-wrap items-center gap-3 rounded-lg border p-3 sm:flex-nowrap"
                >
                  <div className="flex w-44 min-w-36 items-center gap-2">
                    <Switch
                      checked={h.open}
                      disabled={!canEdit}
                      onCheckedChange={(v) => setHours({ ...hours, [d.dow]: { ...h, open: v } })}
                      aria-label={`${d.label} open`}
                      id={`hours-open-${d.dow}`}
                    />
                    <Label htmlFor={`hours-open-${d.dow}`} className="cursor-pointer text-sm font-normal">
                      {d.label}
                    </Label>
                  </div>
                  {h.open ? (
                    <div className="flex flex-1 flex-wrap items-center gap-2">
                      <Label htmlFor={`hours-start-${d.dow}`} className="sr-only">
                        {d.label} opening time
                      </Label>
                      <Input
                        id={`hours-start-${d.dow}`}
                        type="time"
                        value={h.start}
                        disabled={!canEdit}
                        onChange={(e) => setHours({ ...hours, [d.dow]: { ...h, start: e.target.value } })}
                        className="w-32"
                      />
                      <span className="text-sm text-muted-foreground" aria-hidden>
                        →
                      </span>
                      <Label htmlFor={`hours-end-${d.dow}`} className="sr-only">
                        {d.label} closing time
                      </Label>
                      <Input
                        id={`hours-end-${d.dow}`}
                        type="time"
                        value={h.end}
                        disabled={!canEdit}
                        onChange={(e) => setHours({ ...hours, [d.dow]: { ...h, end: e.target.value } })}
                        className="w-32"
                      />
                    </div>
                  ) : (
                    <p className="flex-1 text-sm text-muted-foreground">Closed</p>
                  )}
                </li>
              )
            })}
          </ul>
          <div className="space-y-1.5">
            <Label htmlFor="biz-holidays">Holidays (comma-separated dates)</Label>
            <Input
              id="biz-holidays"
              value={holidaysText}
              disabled={!canEdit}
              onChange={(e) => setHolidaysText(e.target.value)}
              placeholder="2026-01-01, 2026-12-25"
            />
            <p className="text-xs text-muted-foreground">Format YYYY-MM-DD. No bookings can start on these dates.</p>
          </div>
          {canEdit && (
            <div className="flex justify-end">
              <Button onClick={saveHours} disabled={saving !== null} className="min-h-[44px]">
                {saving === 'hours' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Save hours &amp; holidays
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------------- Group 3: Policies ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Booking policies</CardTitle>
          <CardDescription>What the booking engine and AI receptionist may promise customers.</CardDescription>
          <EditableHint canEdit={canEdit} />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div>
                <Label htmlFor="pol-autoconfirm" className="text-sm font-medium">
                  Auto-confirm bookings
                </Label>
                <p className="text-xs text-muted-foreground">New bookings are confirmed without manual review.</p>
              </div>
              <Switch
                id="pol-autoconfirm"
                checked={policies.autoConfirmBookings}
                disabled={!canEdit}
                onCheckedChange={(v) => setPolicies({ ...policies, autoConfirmBookings: v })}
              />
            </div>
            <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div>
                <Label htmlFor="pol-deposit" className="text-sm font-medium">
                  Deposit required for booking
                </Label>
                <p className="text-xs text-muted-foreground">Services may require a deposit before confirming.</p>
              </div>
              <Switch
                id="pol-deposit"
                checked={policies.depositRequired}
                disabled={!canEdit}
                onCheckedChange={(v) => setPolicies({ ...policies, depositRequired: v })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pol-cancel-hours">Cancellation cutoff (hours before)</Label>
              <Input
                id="pol-cancel-hours"
                type="number"
                min={0}
                value={String(policies.minHoursBefore)}
                disabled={!canEdit}
                onChange={(e) => setPolicies({ ...policies, minHoursBefore: Number(e.target.value) })}
              />
              <p className="text-xs text-muted-foreground">Customers must cancel at least this long before the start.</p>
            </div>
            <div className="space-y-1.5">
              <Label>Quiet hours (no messages sent)</Label>
              <div className="flex items-center gap-2">
                <Label htmlFor="pol-quiet-start" className="sr-only">
                  Quiet hours start
                </Label>
                <Input
                  id="pol-quiet-start"
                  type="time"
                  value={policies.quietStart}
                  disabled={!canEdit}
                  onChange={(e) => setPolicies({ ...policies, quietStart: e.target.value })}
                  className="w-32"
                />
                <span className="text-sm text-muted-foreground" aria-hidden>
                  →
                </span>
                <Label htmlFor="pol-quiet-end" className="sr-only">
                  Quiet hours end
                </Label>
                <Input
                  id="pol-quiet-end"
                  type="time"
                  value={policies.quietEnd}
                  disabled={!canEdit}
                  onChange={(e) => setPolicies({ ...policies, quietEnd: e.target.value })}
                  className="w-32"
                />
              </div>
            </div>
          </div>
          {canEdit && (
            <div className="flex justify-end">
              <Button onClick={savePolicies} disabled={saving !== null} className="min-h-[44px]">
                {saving === 'policies' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Save policies
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------------- Group 4: AI identity ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">AI identity</CardTitle>
          <CardDescription>Voice and boundaries for the AI receptionist. It only answers from your approved knowledge.</CardDescription>
          <EditableHint canEdit={canEdit} />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ai-tone">Business tone</Label>
              <Select value={identity.businessTone} onValueChange={(v) => setIdentity({ ...identity, businessTone: v })} disabled={!canEdit}>
                <SelectTrigger id="ai-tone" className="w-full min-h-[44px]" aria-label="Business tone">
                  <SelectValue placeholder="Select tone" />
                </SelectTrigger>
                <SelectContent>
                  {TONES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai-escalation">Escalation note</Label>
              <Input
                id="ai-escalation"
                value={identity.escalationNote}
                disabled={!canEdit}
                onChange={(e) => setIdentity({ ...identity, escalationNote: e.target.value })}
                placeholder="a team member will follow up shortly"
              />
              <p className="text-xs text-muted-foreground">Said when the conversation is handed to a human.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai-greeting">Greeting</Label>
              <Textarea
                id="ai-greeting"
                rows={3}
                value={identity.greeting}
                disabled={!canEdit}
                onChange={(e) => setIdentity({ ...identity, greeting: e.target.value })}
                placeholder="Hi! Welcome to Acme. How can I help you today?"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai-closing">Closing</Label>
              <Textarea
                id="ai-closing"
                rows={3}
                value={identity.closing}
                disabled={!canEdit}
                onChange={(e) => setIdentity({ ...identity, closing: e.target.value })}
                placeholder="Thank you for choosing Acme!"
              />
            </div>
          </div>
          {canEdit && (
            <div className="flex justify-end">
              <Button onClick={saveIdentity} disabled={saving !== null} className="min-h-[44px]">
                {saving === 'ai_identity' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Save AI identity
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------------- Group 5: Collections ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Collections</CardTitle>
          <CardDescription>Automated invoice reminders — schedule, limits and message templates.</CardDescription>
          <EditableHint canEdit={canEdit} />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="col-remind-days">Reminder days</Label>
              <Input
                id="col-remind-days"
                value={collections.reminderDays}
                disabled={!canEdit}
                onChange={(e) => setCollections({ ...collections, reminderDays: e.target.value })}
                placeholder="1, 3, 7"
              />
              <p className="text-xs text-muted-foreground">Days after due date, comma separated.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="col-max-touches">Max touches per invoice</Label>
              <Input
                id="col-max-touches"
                type="number"
                min={0}
                value={String(collections.maxTouches)}
                disabled={!canEdit}
                onChange={(e) => setCollections({ ...collections, maxTouches: Number(e.target.value) })}
              />
              <p className="text-xs text-muted-foreground">Hard cap so customers are never spammed.</p>
            </div>
            <div className="space-y-1.5">
              <Label>Reminder quiet hours</Label>
              <div className="flex items-center gap-2">
                <Label htmlFor="col-quiet-start" className="sr-only">
                  Reminder quiet hours start
                </Label>
                <Input
                  id="col-quiet-start"
                  type="time"
                  value={collections.quietStart}
                  disabled={!canEdit}
                  onChange={(e) => setCollections({ ...collections, quietStart: e.target.value })}
                  className="w-32"
                />
                <span className="text-sm text-muted-foreground" aria-hidden>
                  →
                </span>
                <Label htmlFor="col-quiet-end" className="sr-only">
                  Reminder quiet hours end
                </Label>
                <Input
                  id="col-quiet-end"
                  type="time"
                  value={collections.quietEnd}
                  disabled={!canEdit}
                  onChange={(e) => setCollections({ ...collections, quietEnd: e.target.value })}
                  className="w-32"
                />
              </div>
            </div>
          </div>

          <Separator />

          <div className="space-y-3">
            <div>
              <Label>Reminder templates</Label>
              <p className="text-xs text-muted-foreground">
                Placeholders: <code className="font-mono">{'{{customer_name}}'}</code>,{' '}
                <code className="font-mono">{'{{invoice_number}}'}</code>,{' '}
                <code className="font-mono">{'{{amount_due}}'}</code>,{' '}
                <code className="font-mono">{'{{due_date}}'}</code>,{' '}
                <code className="font-mono">{'{{business_name}}'}</code>
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="col-tpl-first">First reminder</Label>
              <Textarea
                id="col-tpl-first"
                rows={2}
                value={collections.tplFirst}
                disabled={!canEdit}
                onChange={(e) => setCollections({ ...collections, tplFirst: e.target.value })}
                placeholder="Hi {{customer_name}}, a friendly reminder that invoice {{invoice_number}} ({{amount_due}}) was due on {{due_date}}. — {{business_name}}"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="col-tpl-second">Second reminder</Label>
              <Textarea
                id="col-tpl-second"
                rows={2}
                value={collections.tplSecond}
                disabled={!canEdit}
                onChange={(e) => setCollections({ ...collections, tplSecond: e.target.value })}
                placeholder="Hi {{customer_name}}, invoice {{invoice_number}} ({{amount_due}}) is still outstanding. — {{business_name}}"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="col-tpl-final">Final reminder</Label>
              <Textarea
                id="col-tpl-final"
                rows={2}
                value={collections.tplFinal}
                disabled={!canEdit}
                onChange={(e) => setCollections({ ...collections, tplFinal: e.target.value })}
                placeholder="Final notice: invoice {{invoice_number}} ({{amount_due}}) was due on {{due_date}}. Please settle it soon. — {{business_name}}"
              />
            </div>
          </div>

          {canEdit && (
            <div className="flex justify-end">
              <Button onClick={saveCollections} disabled={saving !== null} className="min-h-[44px]">
                {saving === 'collections' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Save collections settings
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
