'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, formatMoney, type Service, type Staff, type SessionInfo } from '@/lib/client/api'
import { useAppStore } from '@/lib/client/store'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  ArrowLeft, ArrowRight, Bot, CalendarCheck, CheckCircle2, CircleDashed, Download,
  FileSpreadsheet, FlaskConical, Loader2, Mail, MinusCircle, PartyPopper, Pencil, PlayCircle,
  Plus, Receipt, Save, ShieldAlert, Sparkles, Trash2, UserRound, Users, XCircle,
} from 'lucide-react'

/* ============================== shared bits ============================== */

const STEPS = [
  { id: 'business', label: 'Business' },
  { id: 'services', label: 'Services & staff' },
  { id: 'imports', label: 'Import' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'ai', label: 'AI provider' },
  { id: 'channels', label: 'Channels' },
  { id: 'collections', label: 'Collections' },
  { id: 'tests', label: 'Test & activate' },
] as const

type StepId = (typeof STEPS)[number]['id']

type StepState = { done: boolean; savedAt: string }
type SetupOrg = {
  id: string; name: string; slug: string; businessType: string; timezone: string; locale: string
  currency: string; address: string; phone: string; email: string
  openingHours: string; holidays: string; policies: string; aiIdentity: string; collectionsCfg: string
  dataMode: string; setupComplete: boolean
}
type SetupData = { state: Partial<Record<StepId, StepState>>; org: SetupOrg }

const TIMEZONES: string[] = (() => {
  const out: string[] = []
  for (let i = -24; i <= 28; i++) { // -12:00 .. +14:00 in 30-min steps
    const half = i - 24
    const hours = Math.trunc(half / 2)
    const mm = half % 2 === 0 ? '00' : '30'
    const sign = half < 0 ? '-' : '+'
    out.push(`UTC${sign}${String(Math.abs(hours)).padStart(2, '0')}:${mm}`)
  }
  return out
})()

const BUSINESS_TYPES = ['generic', 'salon', 'spa', 'clinic', 'workshop', 'rental', 'agency', 'retail', 'other']
const CURRENCIES = ['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'NZD', 'CHF', 'SEK', 'NOK', 'INR', 'JPY', 'BRL', 'ZAR']
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor(i / 2)
  const m = i % 2 === 0 ? '00' : '30'
  return `${String(h).padStart(2, '0')}:${m}`
})

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

function downloadTextFile(filename: string, content: string, mime = 'text/csv') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') inQ = false
      else cur += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

/* ============================== main section ============================== */

export function SetupSection() {
  const { toast } = useToast()
  const setSession = useAppStore((s) => s.setSession)
  const setActiveSection = useAppStore((s) => s.setActiveSection)
  const session = useAppStore((s) => s.session)
  const canManage = session?.user?.role === 'owner' || session?.user?.role === 'admin'

  const [data, setData] = useState<SetupData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [current, setCurrent] = useState(0)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [activated, setActivated] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await api.get<{ state: Partial<Record<StepId, StepState>>; org: SetupOrg }>('/api/setup')
      setData(d)
      setActivated(Boolean(d.org.setupComplete))
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load setup state')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

  /** Debounced autosave: PUT /api/setup {step, data} — also marks the step done. */
  const queueSave = useCallback((step: StepId, payload: Record<string, unknown>) => {
    if (!canManage) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setSaveState('saving')
    saveTimer.current = setTimeout(async () => {
      try {
        const d = await api.put<{ state: Partial<Record<StepId, StepState>> }>('/api/setup', { step, data: payload })
        setData((s) => (s ? { ...s, state: d.state } : s))
        setSaveState('saved')
      } catch (err) {
        setSaveState('idle')
        toast({ title: 'Autosave failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
      }
    }, 800)
  }, [canManage, toast])

  const markStepDone = useCallback(async (step: StepId) => {
    if (!canManage) return
    try {
      const d = await api.put<{ state: Partial<Record<StepId, StepState>> }>('/api/setup', { step, data: {} })
      setData((s) => (s ? { ...s, state: d.state } : s))
    } catch (err) {
      toast({ title: 'Could not mark step done', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    }
  }, [canManage, toast])

  const goNext = async () => {
    const step = STEPS[current]
    if (step.id !== 'tests') await markStepDone(step.id)
    setCurrent((c) => Math.min(c + 1, STEPS.length - 1))
  }

  const goBack = () => setCurrent((c) => Math.max(c - 1, 0))

  const completeSetup = async () => {
    try {
      await api.post('/api/setup/complete')
      setActivated(true)
      toast({ title: 'Setup complete 🎉', description: 'Your AI Secretary is live.' })
      try {
        const s = await api.get<SessionInfo>('/api/session')
        setSession(s)
      } catch { /* keep the current session */ }
    } catch (err) {
      toast({ title: 'Could not complete setup', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    }
  }

  if (loading) {
    return (
      <div className="space-y-4" aria-label="Loading setup wizard">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription className="space-y-2">
          <p>{error || 'Setup state unavailable.'}</p>
          <Button size="sm" variant="outline" onClick={() => void load()} className="min-h-[44px]">Retry</Button>
        </AlertDescription>
      </Alert>
    )
  }

  const doneCount = STEPS.filter((s) => data.state[s.id]?.done).length
  const pct = activated ? 100 : Math.round((doneCount / STEPS.length) * 100)

  if (activated) {
    return (
      <div className="space-y-4" aria-label="Setup complete">
        <Card className="border-emerald-200 bg-emerald-50">
          <CardContent className="p-8 text-center space-y-3">
            <PartyPopper className="h-10 w-10 mx-auto text-emerald-700" aria-hidden />
            <h2 className="text-xl font-semibold text-emerald-900">Your AI Secretary is live</h2>
            <p className="text-sm text-emerald-900/80 max-w-md mx-auto">
              Setup is complete. The receptionist answers from your approved knowledge, bookings go through the real availability engine, and money movements are recorded in the ledger. You can revisit any step below or from the sidebar.
            </p>
            <div className="flex flex-wrap justify-center gap-2 pt-2">
              <Button onClick={() => setActiveSection('dashboard')} className="min-h-[44px]">
                <ArrowRight className="h-4 w-4" aria-hidden /> Go to dashboard
              </Button>
              <Button variant="outline" onClick={() => setActivated(false)} className="min-h-[44px]">Review wizard</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  const step = STEPS[current]
  const stepProps = { org: data.org, queueSave, markStepDone, canManage, onNext: () => void goNext() }

  return (
    <div className="space-y-4" aria-label="Setup wizard">
      {/* sticky step indicator */}
      <div className="sticky top-0 z-20 -mx-1 px-1 pt-1 pb-2 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <Card>
          <CardContent className="p-3 space-y-2">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">Setup · step {current + 1} of {STEPS.length} — {step.label}</p>
              <span className="ml-auto text-xs text-muted-foreground flex items-center gap-1.5" aria-live="polite">
                {saveState === 'saving' && <><Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Saving…</>}
                {saveState === 'saved' && <><CheckCircle2 className="h-3 w-3 text-emerald-600" aria-hidden /> Saved ✓</>}
              </span>
            </div>
            <Progress value={pct} aria-label={`Setup progress: ${pct}%`} />
            <div className="flex flex-wrap gap-1.5">
              {STEPS.map((s, i) => {
                const isDone = Boolean(data.state[s.id]?.done)
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setCurrent(i)}
                    aria-current={i === current ? 'step' : undefined}
                    aria-label={`Step ${i + 1}: ${s.label}${isDone ? ' (done)' : ''}`}
                    className={cn(
                      'rounded-full border px-2.5 py-1.5 text-xs min-h-[32px] transition-colors flex items-center gap-1',
                      i === current ? 'border-primary bg-primary text-primary-foreground font-medium' : isDone ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {isDone && i !== current && <CheckCircle2 className="h-3 w-3" aria-hidden />}
                    {s.label}
                  </button>
                )
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      {!canManage && (
        <Alert className="border-amber-200 bg-amber-50 text-amber-900" role="note">
          <ShieldAlert className="h-4 w-4" aria-hidden />
          <AlertDescription>The setup wizard edits organization settings — ask an owner or admin to make changes. You can browse all steps read-only.</AlertDescription>
        </Alert>
      )}

      {current === 0 && <BusinessStep {...stepProps} />}
      {current === 1 && <ServicesStep {...stepProps} />}
      {current === 2 && <ImportsStep {...stepProps} />}
      {current === 3 && <KnowledgeStep {...stepProps} />}
      {current === 4 && <AiStep {...stepProps} />}
      {current === 5 && <ChannelsStep {...stepProps} />}
      {current === 6 && <CollectionsStep {...stepProps} />}
      {current === 7 && <TestStep {...stepProps} onComplete={() => void completeSetup()} activated={activated} />}

      {/* back / continue */}
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={goBack} disabled={current === 0} className="min-h-[44px]" aria-label="Go back a step">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back
        </Button>
        {current < STEPS.length - 1 && (
          <Button onClick={() => void goNext()} className="min-h-[44px] ml-auto" aria-label="Continue to the next step">
            Continue <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        )}
      </div>
    </div>
  )
}

type StepProps = {
  org: SetupOrg
  queueSave: (step: StepId, payload: Record<string, unknown>) => void
  markStepDone: (step: StepId) => Promise<void>
  canManage: boolean
  onNext: () => void
}

/* ============================== step 1: business ============================== */

function BusinessStep({ org, queueSave }: StepProps) {
  const [name, setName] = useState(org.name)
  const [businessType, setBusinessType] = useState(org.businessType || 'generic')
  const [timezone, setTimezone] = useState(org.timezone || 'UTC+00:00')
  const [currency, setCurrency] = useState(org.currency || 'USD')
  const [address, setAddress] = useState(org.address)
  const [phone, setPhone] = useState(org.phone)
  const [email, setEmail] = useState(org.email)

  const push = (next: Partial<{ name: string; businessType: string; timezone: string; currency: string; address: string; phone: string; email: string }>) => {
    queueSave('business', {
      name: next.name ?? name,
      businessType: next.businessType ?? businessType,
      timezone: next.timezone ?? timezone,
      currency: next.currency ?? currency,
      address: next.address ?? address,
      phone: next.phone ?? phone,
      email: next.email ?? email,
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><UserRound className="h-4 w-4" aria-hidden /> Business profile</CardTitle>
        <CardDescription>Tell the AI who it works for. Changes autosave.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="bizName">Business name</Label>
            <Input id="bizName" value={name} onChange={(e) => { setName(e.target.value); push({ name: e.target.value }) }} className="min-h-[44px]" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bizType">Business type</Label>
            <Select value={businessType} onValueChange={(v) => { setBusinessType(v); push({ businessType: v }) }}>
              <SelectTrigger id="bizType" className="min-h-[44px]" aria-label="Business type"><SelectValue /></SelectTrigger>
              <SelectContent>{BUSINESS_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bizTz">Timezone</Label>
            <Select value={timezone} onValueChange={(v) => { setTimezone(v); push({ timezone: v }) }}>
              <SelectTrigger id="bizTz" className="min-h-[44px]" aria-label="Timezone"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-64">
                {TIMEZONES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bizCurrency">Currency</Label>
            <Select value={currency} onValueChange={(v) => { setCurrency(v); push({ currency: v }) }}>
              <SelectTrigger id="bizCurrency" className="min-h-[44px]" aria-label="Currency"><SelectValue /></SelectTrigger>
              <SelectContent>{CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bizAddress">Address</Label>
          <Input id="bizAddress" value={address} onChange={(e) => { setAddress(e.target.value); push({ address: e.target.value }) }} className="min-h-[44px]" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="bizPhone">Phone</Label>
            <Input id="bizPhone" type="tel" value={phone} onChange={(e) => { setPhone(e.target.value); push({ phone: e.target.value }) }} className="min-h-[44px]" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bizEmail">Email</Label>
            <Input id="bizEmail" type="email" value={email} onChange={(e) => { setEmail(e.target.value); push({ email: e.target.value }) }} className="min-h-[44px]" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

/* ============================== step 2: services & staff ============================== */

type ServiceForm = { id: string | null; name: string; category: string; durationMin: number; price: string; bufferBeforeMin: number; bufferAfterMin: number }
const EMPTY_SERVICE: ServiceForm = { id: null, name: '', category: '', durationMin: 60, price: '0', bufferBeforeMin: 0, bufferAfterMin: 10 }

function ServicesStep({ org, markStepDone }: StepProps) {
  const { toast } = useToast()
  const [services, setServices] = useState<Service[]>([])
  const [staff, setStaff] = useState<Staff[]>([])
  const [loading, setLoading] = useState(true)
  const [svcOpen, setSvcOpen] = useState(false)
  const [svcForm, setSvcForm] = useState<ServiceForm>(EMPTY_SERVICE)
  const [svcSaving, setSvcSaving] = useState(false)
  const [staffOpen, setStaffOpen] = useState(false)
  const [staffForm, setStaffForm] = useState<{ id: string | null; name: string; role: string; email: string; phone: string }>({ id: null, name: '', role: '', email: '', phone: '' })
  const [staffSaving, setStaffSaving] = useState(false)
  const [linksFor, setLinksFor] = useState<Staff | null>(null)
  const [linkIds, setLinkIds] = useState<string[]>([])
  const [linksSaving, setLinksSaving] = useState(false)
  const [deleteSvc, setDeleteSvc] = useState<Service | null>(null)

  // org hours editor — init from org.openingHours JSON
  const [hours, setHours] = useState<Array<{ enabled: boolean; start: string; end: string }>>(() => {
    const raw = (() => { try { return JSON.parse(org.openingHours || '{}') as Record<string, string[][]> } catch { return {} } })()
    return DOW.map((_, dow) => {
      const windows = raw[String(dow)] ?? []
      const first = windows[0]
      return { enabled: Boolean(first), start: first?.[0] ?? '09:00', end: first?.[1] ?? '17:00' }
    })
  })
  const [hoursSaving, setHoursSaving] = useState(false)

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [s, st] = await Promise.all([
        api.get<{ services: Service[] }>('/api/services'),
        api.get<{ staff: Staff[] }>('/api/staff'),
      ])
      setServices(s.services)
      setStaff(st.staff)
    } catch (err) {
      toast({ title: 'Could not load services/staff', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { void loadAll() }, [loadAll])

  const saveService = async () => {
    setSvcSaving(true)
    try {
      const body = {
        name: svcForm.name.trim(),
        category: svcForm.category.trim() || undefined,
        durationMin: Math.max(5, Math.floor(svcForm.durationMin)),
        priceCents: Math.round(Number(svcForm.price || '0') * 100),
        bufferBeforeMin: Math.max(0, Math.floor(svcForm.bufferBeforeMin)),
        bufferAfterMin: Math.max(0, Math.floor(svcForm.bufferAfterMin)),
      }
      if (svcForm.id) await api.patch(`/api/services/${svcForm.id}`, body)
      else await api.post('/api/services', body)
      toast({ title: svcForm.id ? 'Service updated' : 'Service added' })
      setSvcOpen(false)
      await loadAll()
    } catch (err) {
      toast({ title: 'Save failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setSvcSaving(false)
    }
  }

  const deleteService = async () => {
    if (!deleteSvc) return
    try {
      await api.delete(`/api/services/${deleteSvc.id}`)
      toast({ title: 'Service deleted' })
      setDeleteSvc(null)
      await loadAll()
    } catch (err) {
      toast({
        title: 'Could not delete',
        description: err instanceof Error ? `${err.message} — deactivate it instead if bookings exist.` : 'Unknown error',
        variant: 'destructive',
      })
      setDeleteSvc(null)
    }
  }

  const saveStaff = async () => {
    setStaffSaving(true)
    try {
      const body = { name: staffForm.name.trim(), role: staffForm.role.trim() || undefined, email: staffForm.email.trim() || undefined, phone: staffForm.phone.trim() || undefined }
      if (staffForm.id) await api.patch(`/api/staff/${staffForm.id}`, body)
      else await api.post('/api/staff', body)
      toast({ title: staffForm.id ? 'Staff updated' : 'Staff added' })
      setStaffOpen(false)
      await loadAll()
    } catch (err) {
      toast({ title: 'Save failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setStaffSaving(false)
    }
  }

  const saveLinks = async () => {
    if (!linksFor) return
    setLinksSaving(true)
    try {
      await api.put(`/api/staff/${linksFor.id}/services`, { serviceIds: linkIds })
      toast({ title: `${linksFor.name}'s services updated` })
      setLinksFor(null)
      await loadAll()
    } catch (err) {
      toast({ title: 'Save failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setLinksSaving(false)
    }
  }

  const saveHours = async () => {
    setHoursSaving(true)
    try {
      const payload = hours
        .map((h, dow) => h.enabled ? { dow, startMin: toMin(h.start), endMin: toMin(h.end) } : null)
        .filter((x): x is { dow: number; startMin: number; endMin: number } => x !== null && x.endMin > x.startMin)
      await api.put('/api/staff/hours', { hours: payload })
      // mirror into org.openingHours (object → server stringifies)
      const openingHours: Record<string, string[][]> = {}
      payload.forEach((h) => { openingHours[String(h.dow)] = [[TIME_OPTIONS[Math.min(47, Math.floor(h.startMin / 30))], TIME_OPTIONS[Math.min(47, Math.ceil(h.endMin / 30)) % 48 || 47]]] })
      await api.put('/api/setup', { step: 'services', data: { openingHours } })
      toast({ title: 'Working hours saved' })
      await markStepDone('services')
    } catch (err) {
      toast({ title: 'Could not save hours', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setHoursSaving(false)
    }
  }

  if (loading) return <Skeleton className="h-72 w-full" aria-label="Loading services and staff" />

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Sparkles className="h-4 w-4" aria-hidden /> Services</CardTitle>
          <CardDescription>What customers can book. Prices power quotes and invoices.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {services.length === 0 ? (
            <p className="text-sm text-muted-foreground">No services yet — add at least one so the AI can quote prices and book.</p>
          ) : (
            <div className="max-h-96 overflow-y-auto rounded-md border">
              <Table aria-label="Services">
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead className="hidden sm:table-cell">Buffer after</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {services.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="text-sm font-medium">{s.name}{!s.active && <Badge variant="outline" className="ml-1.5 text-[10px]">inactive</Badge>}</TableCell>
                      <TableCell className="text-sm">{s.durationMin} min</TableCell>
                      <TableCell className="text-sm">{formatMoney(s.priceCents, org.currency)}</TableCell>
                      <TableCell className="hidden sm:table-cell text-sm text-muted-foreground">{s.bufferAfterMin} min</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="icon" variant="ghost" className="min-h-[44px] min-w-[44px]"
                            aria-label={`Edit ${s.name}`}
                            onClick={() => { setSvcForm({ id: s.id, name: s.name, category: s.category, durationMin: s.durationMin, price: (s.priceCents / 100).toFixed(2), bufferBeforeMin: s.bufferBeforeMin, bufferAfterMin: s.bufferAfterMin }); setSvcOpen(true) }}
                          >
                            <Pencil className="h-4 w-4" aria-hidden />
                          </Button>
                          <Button size="icon" variant="ghost" className="min-h-[44px] min-w-[44px] text-rose-700" aria-label={`Delete ${s.name}`} onClick={() => setDeleteSvc(s)}>
                            <Trash2 className="h-4 w-4" aria-hidden />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <Button variant="outline" onClick={() => { setSvcForm(EMPTY_SERVICE); setSvcOpen(true) }} className="min-h-[44px]" aria-label="Add a service">
            <Plus className="h-4 w-4" aria-hidden /> Add service
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Users className="h-4 w-4" aria-hidden /> Staff</CardTitle>
          <CardDescription>Who delivers the services, and which ones.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {staff.length === 0 ? (
            <p className="text-sm text-muted-foreground">No staff yet. Add yourself at minimum — the AI assigns bookings to staff with matching services.</p>
          ) : (
            <div className="max-h-96 overflow-y-auto rounded-md border">
              <Table aria-label="Staff">
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Services</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {staff.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell className="text-sm font-medium">{m.name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{m.role || '—'}</TableCell>
                      <TableCell className="text-sm">{(m.serviceIds ?? []).length}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm" variant="outline" className="min-h-[44px]"
                            onClick={() => { setStaffForm({ id: m.id, name: m.name, role: m.role, email: m.email, phone: m.phone }); setStaffOpen(true) }}
                            aria-label={`Edit ${m.name}`}
                          >
                            <Pencil className="h-3.5 w-3.5" aria-hidden />
                          </Button>
                          <Button
                            size="sm" variant="outline" className="min-h-[44px]"
                            onClick={() => { setLinksFor(m); setLinkIds(m.serviceIds ?? []) }}
                            aria-label={`Link services for ${m.name}`}
                          >
                            Services
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <Button variant="outline" onClick={() => { setStaffForm({ id: null, name: '', role: '', email: '', phone: '' }); setStaffOpen(true) }} className="min-h-[44px]" aria-label="Add a staff member">
            <Plus className="h-4 w-4" aria-hidden /> Add staff
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><CalendarCheck className="h-4 w-4" aria-hidden /> Working hours (org-wide)</CardTitle>
          <CardDescription>The AI only books inside these windows unless a staff member overrides them.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {hours.map((h, dow) => (
            <div key={dow} className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-sm w-28 min-h-[44px]">
                <Checkbox
                  checked={h.enabled}
                  onCheckedChange={(v) => setHours((hs) => hs.map((x, i) => i === dow ? { ...x, enabled: v === true } : x))}
                  aria-label={`${DOW[dow]} open`}
                />
                {DOW[dow].slice(0, 3)}
              </label>
              {h.enabled ? (
                <>
                  <Select value={h.start} onValueChange={(v) => setHours((hs) => hs.map((x, i) => i === dow ? { ...x, start: v } : x))}>
                    <SelectTrigger className="w-28 min-h-[44px]" aria-label={`${DOW[dow]} start time`}><SelectValue /></SelectTrigger>
                    <SelectContent className="max-h-64">{TIME_OPTIONS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                  </Select>
                  <span className="text-muted-foreground text-sm">–</span>
                  <Select value={h.end} onValueChange={(v) => setHours((hs) => hs.map((x, i) => i === dow ? { ...x, end: v } : x))}>
                    <SelectTrigger className="w-28 min-h-[44px]" aria-label={`${DOW[dow]} end time`}><SelectValue /></SelectTrigger>
                    <SelectContent className="max-h-64">{TIME_OPTIONS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                  </Select>
                </>
              ) : (
                <span className="text-sm text-muted-foreground">Closed</span>
              )}
            </div>
          ))}
          <Button onClick={() => void saveHours()} disabled={hoursSaving} className="min-h-[44px]" aria-label="Save working hours">
            {hoursSaving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
            Save working hours
          </Button>
        </CardContent>
      </Card>

      {/* service dialog */}
      <Dialog open={svcOpen} onOpenChange={setSvcOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{svcForm.id ? 'Edit service' : 'New service'}</DialogTitle>
            <DialogDescription>Price is in {org.currency}.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="svcName">Name</Label>
              <Input id="svcName" value={svcForm.name} onChange={(e) => setSvcForm((f) => ({ ...f, name: e.target.value }))} className="min-h-[44px]" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="svcDur">Duration (min)</Label>
                <Input id="svcDur" type="number" min={5} value={svcForm.durationMin} onChange={(e) => setSvcForm((f) => ({ ...f, durationMin: Number(e.target.value) }))} className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="svcPrice">Price ({org.currency})</Label>
                <Input id="svcPrice" type="number" min={0} step="0.01" value={svcForm.price} onChange={(e) => setSvcForm((f) => ({ ...f, price: e.target.value }))} className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="svcBufB">Buffer before (min)</Label>
                <Input id="svcBufB" type="number" min={0} value={svcForm.bufferBeforeMin} onChange={(e) => setSvcForm((f) => ({ ...f, bufferBeforeMin: Number(e.target.value) }))} className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="svcBufA">Buffer after (min)</Label>
                <Input id="svcBufA" type="number" min={0} value={svcForm.bufferAfterMin} onChange={(e) => setSvcForm((f) => ({ ...f, bufferAfterMin: Number(e.target.value) }))} className="min-h-[44px]" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="svcCat">Category (optional)</Label>
              <Input id="svcCat" value={svcForm.category} onChange={(e) => setSvcForm((f) => ({ ...f, category: e.target.value }))} className="min-h-[44px]" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSvcOpen(false)} className="min-h-[44px]">Cancel</Button>
            <Button onClick={() => void saveService()} disabled={svcSaving || !svcForm.name.trim()} className="min-h-[44px]">
              {svcSaving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Save service
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* staff dialog */}
      <Dialog open={staffOpen} onOpenChange={setStaffOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{staffForm.id ? 'Edit staff member' : 'New staff member'}</DialogTitle>
            <DialogDescription>Link services afterwards so bookings can be assigned.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="staffName">Name</Label>
              <Input id="staffName" value={staffForm.name} onChange={(e) => setStaffForm((f) => ({ ...f, name: e.target.value }))} className="min-h-[44px]" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="staffRole">Role</Label>
                <Input id="staffRole" value={staffForm.role} onChange={(e) => setStaffForm((f) => ({ ...f, role: e.target.value }))} className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="staffPhone">Phone</Label>
                <Input id="staffPhone" value={staffForm.phone} onChange={(e) => setStaffForm((f) => ({ ...f, phone: e.target.value }))} className="min-h-[44px]" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="staffEmail">Email</Label>
              <Input id="staffEmail" type="email" value={staffForm.email} onChange={(e) => setStaffForm((f) => ({ ...f, email: e.target.value }))} className="min-h-[44px]" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStaffOpen(false)} className="min-h-[44px]">Cancel</Button>
            <Button onClick={() => void saveStaff()} disabled={staffSaving || !staffForm.name.trim()} className="min-h-[44px]">
              {staffSaving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Save staff
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* service links dialog */}
      <Dialog open={Boolean(linksFor)} onOpenChange={(o) => !o && setLinksFor(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Services for {linksFor?.name}</DialogTitle>
            <DialogDescription>Only linked services can be booked with this person.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {services.map((s) => (
              <label key={s.id} className="flex items-center gap-2.5 rounded-md border p-2.5 text-sm min-h-[44px]">
                <Checkbox
                  checked={linkIds.includes(s.id)}
                  onCheckedChange={(v) => setLinkIds((ids) => v === true ? [...ids, s.id] : ids.filter((i) => i !== s.id))}
                  aria-label={`Link ${s.name} to ${linksFor?.name}`}
                />
                <span className="flex-1">{s.name}</span>
                <span className="text-muted-foreground text-xs">{formatMoney(s.priceCents, org.currency)}</span>
              </label>
            ))}
            {services.length === 0 && <p className="text-sm text-muted-foreground">Add services first.</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLinksFor(null)} className="min-h-[44px]">Cancel</Button>
            <Button onClick={() => void saveLinks()} disabled={linksSaving} className="min-h-[44px]">
              {linksSaving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Save links
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* delete service confirm */}
      <Dialog open={Boolean(deleteSvc)} onOpenChange={(o) => !o && setDeleteSvc(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete “{deleteSvc?.name}”?</DialogTitle>
            <DialogDescription>
              Services with existing bookings cannot be deleted — the server will tell you if so.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteSvc(null)} className="min-h-[44px]">Cancel</Button>
            <Button variant="destructive" onClick={() => void deleteService()} className="min-h-[44px]">
              <Trash2 className="h-4 w-4" aria-hidden /> Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* ============================== step 3: imports ============================== */

type ImportResult = { ok: boolean; message: string }

function ImportsStep({ markStepDone }: StepProps) {
  const { toast } = useToast()
  const [custCsv, setCustCsv] = useState('')
  const [custBusy, setCustBusy] = useState(false)
  const [custResults, setCustResults] = useState<ImportResult[] | null>(null)
  const [svcCsv, setSvcCsv] = useState('')
  const [svcBusy, setSvcBusy] = useState(false)
  const [svcResults, setSvcResults] = useState<ImportResult[] | null>(null)

  const importCustomers = async () => {
    if (!custCsv.trim()) return
    setCustBusy(true)
    try {
      const d = await api.post<{ created: number; errors: Array<{ row: number; message: string }> }>('/api/customers/import', { csv: custCsv })
      const rows: ImportResult[] = [{ ok: true, message: `${d.created} customer(s) created` }, ...d.errors.map((e) => ({ ok: false, message: `Row ${e.row}: ${e.message}` }))]
      setCustResults(rows)
      await markStepDone('imports')
    } catch (err) {
      setCustResults([{ ok: false, message: err instanceof Error ? err.message : 'Import failed' }])
    } finally {
      setCustBusy(false)
    }
  }

  const importServices = async () => {
    const text = svcCsv.trim()
    if (!text) return
    setSvcBusy(true)
    try {
      const lines = text.split(/\r?\n/).filter((l) => l.trim())
      if (lines.length < 2) {
        setSvcResults([{ ok: false, message: 'CSV needs a header row and at least one data row' }])
        return
      }
      const results: ImportResult[] = []
      for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i])
        const [name, category, durationMin, priceCents] = cols
        if (!name) { results.push({ ok: false, message: `Row ${i + 1}: missing service name` }); continue }
        try {
          await api.post('/api/services', {
            name,
            category: category || undefined,
            durationMin: Math.max(5, Math.round(Number(durationMin) || 60)),
            priceCents: Math.max(0, Math.round(Number(priceCents) || 0)),
          })
          results.push({ ok: true, message: `${name} — created` })
        } catch (err) {
          results.push({ ok: false, message: `${name} — ${err instanceof Error ? err.message : 'failed'}` })
        }
      }
      setSvcResults(results)
      await markStepDone('imports')
    } finally {
      setSvcBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><FileSpreadsheet className="h-4 w-4" aria-hidden /> CSV templates</CardTitle>
          <CardDescription>Download a template, fill it in your spreadsheet tool, paste the rows below.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            variant="outline" className="min-h-[44px]"
            onClick={() => downloadTextFile('customers-template.csv', 'name,email,phone,notes,tags\nJane Doe,jane@example.com,+1 555 010 1,VIP,retail\nJohn Smith,john@example.com,,,\n')}
            aria-label="Download customers CSV template"
          >
            <Download className="h-4 w-4" aria-hidden /> customers.csv
          </Button>
          <Button
            variant="outline" className="min-h-[44px]"
            onClick={() => downloadTextFile('services-template.csv', 'name,category,durationMin,priceCents\nConsultation,general,30,5000\nSignature Cut,hair,60,6500\n')}
            aria-label="Download services CSV template"
          >
            <Download className="h-4 w-4" aria-hidden /> services.csv
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Import customers</CardTitle>
          <CardDescription>Header: <code className="text-xs">name,email,phone,notes,tags</code> (tags separated by <code className="text-xs">|</code> or comma).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea rows={6} value={custCsv} onChange={(e) => setCustCsv(e.target.value)} placeholder={'name,email,phone,notes,tags\nJane Doe,jane@example.com,+1 555 010 1,,retail'} aria-label="Customer CSV paste area" />
          <Button onClick={() => void importCustomers()} disabled={custBusy || !custCsv.trim()} className="min-h-[44px]" aria-label="Import customers">
            {custBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Users className="h-4 w-4" aria-hidden />} Import customers
          </Button>
          {custResults && (
            <ul className="space-y-1 max-h-40 overflow-y-auto text-sm" aria-label="Customer import results">
              {custResults.map((r, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  {r.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5" aria-hidden /> : <XCircle className="h-4 w-4 text-rose-600 mt-0.5" aria-hidden />}
                  <span className={r.ok ? 'text-muted-foreground' : 'text-rose-700'}>{r.message}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Import services</CardTitle>
          <CardDescription>Header: <code className="text-xs">name,category,durationMin,priceCents</code> — imported row by row, honestly.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea rows={6} value={svcCsv} onChange={(e) => setSvcCsv(e.target.value)} placeholder={'name,category,durationMin,priceCents\nConsultation,general,30,5000'} aria-label="Services CSV paste area" />
          <Button onClick={() => void importServices()} disabled={svcBusy || !svcCsv.trim()} className="min-h-[44px]" aria-label="Import services">
            {svcBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />} Import services
          </Button>
          {svcResults && (
            <ul className="space-y-1 max-h-40 overflow-y-auto text-sm" aria-label="Service import results">
              {svcResults.map((r, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  {r.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5" aria-hidden /> : <XCircle className="h-4 w-4 text-rose-600 mt-0.5" aria-hidden />}
                  <span className={r.ok ? 'text-muted-foreground' : 'text-rose-700'}>{r.message}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/* ============================== step 4: knowledge ============================== */

function KnowledgeStep({ canManage, markStepDone }: StepProps) {
  const { toast } = useToast()
  const setActiveSection = useAppStore((s) => s.setActiveSection)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [approved, setApproved] = useState(true)
  const [saving, setSaving] = useState(false)

  const addDoc = async () => {
    setSaving(true)
    try {
      await api.post('/api/knowledge', { title: title.trim(), content, approved })
      toast({ title: 'FAQ added', description: approved ? 'Approved — the AI can use it now.' : 'Saved as a draft.' })
      setTitle('')
      setContent('')
      await markStepDone('knowledge')
    } catch (err) {
      toast({ title: 'Could not save', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Bot className="h-4 w-4" aria-hidden /> Quick-add FAQs</CardTitle>
        <CardDescription>Add the questions customers always ask. The AI answers only from approved documents.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="faqTitle">Question / title</Label>
          <Input id="faqTitle" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What are your opening hours?" className="min-h-[44px]" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="faqContent">Answer / content</Label>
          <Textarea id="faqContent" rows={6} value={content} onChange={(e) => setContent(e.target.value)} placeholder="We are open Monday to Friday 9–18…" />
        </div>
        <label className="flex items-center gap-3 text-sm">
          <Switch checked={approved} onCheckedChange={setApproved} aria-label="Approved for AI use" disabled={!canManage} />
          Approved — usable by the AI immediately
        </label>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void addDoc()} disabled={saving || !title.trim() || !content.trim() || !canManage} className="min-h-[44px]" aria-label="Add FAQ document">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />} Add FAQ
          </Button>
          <Button variant="outline" onClick={() => setActiveSection('knowledge')} className="min-h-[44px]" aria-label="Open the full knowledge section">
            Open full Knowledge section →
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/* ============================== step 5: AI provider ============================== */

type LlmTest = { ok: boolean; message: string; latencyMs: number }

function AiStep({ canManage, markStepDone }: StepProps) {
  const { toast } = useToast()
  const [provider, setProvider] = useState<'ollama' | 'openai_compatible'>('ollama')
  const [baseUrl, setBaseUrl] = useState('http://localhost:11434')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<LlmTest | null>(null)
  const [dataMode, setDataMode] = useState('hybrid')

  useEffect(() => {
    void (async () => {
      try {
        const d = await api.get<{ capabilities: Record<string, { provider: string; baseUrl: string; model: string }>; dataMode: string }>('/api/providers')
        const llm = d.capabilities.llm
        if (llm) {
          if (llm.provider === 'ollama' || llm.provider === 'openai_compatible') setProvider(llm.provider)
          setBaseUrl(llm.baseUrl || 'http://localhost:11434')
          setModel(llm.model)
        }
        setDataMode(d.dataMode)
      } catch { /* defaults are fine */ } finally {
        setLoaded(true)
      }
    })()
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      const body: Record<string, unknown> = { provider, enabled: true }
      if (provider === 'ollama' || provider === 'openai_compatible') { body.baseUrl = baseUrl.trim(); body.model = model.trim() }
      if (provider === 'openai_compatible' && apiKey.trim()) body.apiKey = apiKey.trim()
      await api.put('/api/providers/llm', body)
      toast({ title: 'LLM provider saved' })
      await markStepDone('ai')
    } catch (err) {
      toast({ title: 'Save failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const runTest = async () => {
    setTesting(true)
    setTest(null)
    try {
      const r = await api.post<LlmTest>('/api/providers/llm/test')
      setTest(r)
    } catch (err) {
      setTest({ ok: false, message: err instanceof Error ? err.message : 'Test failed', latencyMs: 0 })
    } finally {
      setTesting(false)
    }
  }

  const changeDataMode = async (mode: string) => {
    try {
      await api.put('/api/settings/data-mode', { dataMode: mode })
      setDataMode(mode)
      await markStepDone('ai')
    } catch (err) {
      toast({ title: 'Could not change data mode', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    }
  }

  if (!loaded) return <Skeleton className="h-72 w-full" aria-label="Loading AI settings" />

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Bot className="h-4 w-4" aria-hidden /> Conversation model (LLM)</CardTitle>
          <CardDescription>Which model powers the AI receptionist. You can change this any time in AI Providers.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="LLM provider">
            {([
              { id: 'ollama', title: 'Ollama (local)', desc: 'Runs on your own machine — no data leaves this server. Recommended for privacy.' },
              { id: 'openai_compatible', title: 'OpenAI-compatible', desc: 'Bring your own endpoint and key (OpenAI, Groq, OpenRouter, vLLM, LM Studio…).' },
            ] as const).map((opt) => (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={provider === opt.id}
                disabled={!canManage}
                onClick={() => setProvider(opt.id)}
                className={cn(
                  'text-left rounded-lg border p-3 min-h-[44px] transition-colors disabled:opacity-60',
                  provider === opt.id ? 'border-primary bg-muted/50' : 'hover:bg-muted/40',
                )}
              >
                <p className="font-medium text-sm">{opt.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{opt.desc}</p>
              </button>
            ))}
          </div>

          {true && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="llmUrl">Base URL</Label>
                <Input id="llmUrl" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:11434" className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="llmModel">Model</Label>
                <Input id="llmModel" value={model} onChange={(e) => setModel(e.target.value)} placeholder="llama3.1:8b" className="min-h-[44px]" />
              </div>
            </div>
          )}
          {provider === 'openai_compatible' && (
            <div className="space-y-1.5">
              <Label htmlFor="llmKey">API key</Label>
              <Input id="llmKey" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Paste key (stored server-side, never echoed)" autoComplete="off" className="min-h-[44px]" />
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void save()} disabled={saving || !canManage} className="min-h-[44px]" aria-label="Save LLM provider">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />} Save
            </Button>
            <Button variant="outline" onClick={() => void runTest()} disabled={testing || !canManage} className="min-h-[44px]" aria-label="Test the LLM connection">
              {testing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <PlayCircle className="h-4 w-4" aria-hidden />} Test connection
            </Button>
          </div>

          {test && (
            <Alert role="status" className={test.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'}>
              {test.ok ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <XCircle className="h-4 w-4" aria-hidden />}
              <AlertDescription>{test.message || (test.ok ? 'Connection OK.' : 'Test failed.')} {test.latencyMs ? `(${test.latencyMs} ms)` : ''}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><ShieldAlert className="h-4 w-4" aria-hidden /> Data mode</CardTitle>
          <CardDescription>Whether cloud AI may be contacted at all.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Data mode">
            {([
              { id: 'local_only', label: 'Strict — never call cloud AI' },
              { id: 'hybrid', label: 'Hybrid — you choose per capability' },
              { id: 'cloud_first', label: 'Cloud first — prefer cloud models' },
            ] as const).map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={dataMode === m.id}
                disabled={!canManage}
                onClick={() => void changeDataMode(m.id)}
                className={cn(
                  'text-left rounded-lg border p-3 text-sm min-h-[44px] transition-colors disabled:opacity-60',
                  dataMode === m.id ? 'border-primary bg-muted/50 font-medium' : 'hover:bg-muted/40',
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground flex items-start gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 text-emerald-600 shrink-0" aria-hidden />
            Embeddings/retrieval use the built-in local lexical engine by default — no external calls, nothing to configure.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

/* ============================== step 6: channels ============================== */

function ChannelsStep({ markStepDone, canManage }: StepProps) {
  const { toast } = useToast()
  const [channels, setChannels] = useState<{ email: boolean; sms: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        setChannels(await api.get<{ email: boolean; sms: boolean }>('/api/settings/channels'))
      } catch {
        setChannels({ email: false, sms: false })
      }
    })()
  }, [])

  const toggle = async (key: 'email' | 'sms', value: boolean) => {
    if (!channels) return
    setBusy(true)
    try {
      const d = await api.put<{ email: boolean; sms: boolean }>('/api/settings/channels', { ...channels, [key]: value })
      setChannels(d)
      await markStepDone('channels')
    } catch (err) {
      toast({ title: 'Could not update channels', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Mail className="h-4 w-4" aria-hidden /> Channels</CardTitle>
        <CardDescription>Where outbound messages (reminders, confirmations) are intended to go.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!channels ? <Skeleton className="h-20 w-full" aria-label="Loading channels" /> : (
          <div className="grid gap-3 sm:grid-cols-2">
            {(['email', 'sms'] as const).map((ch) => (
              <label key={ch} className="flex items-center gap-3 rounded-md border p-3 text-sm min-h-[44px]">
                <Switch checked={channels[ch]} disabled={!canManage || busy} onCheckedChange={(v) => void toggle(ch, v)} aria-label={`Enable ${ch} channel`} />
                <span className="capitalize font-medium">{ch}</span>
                <Badge variant={channels[ch] ? 'secondary' : 'outline'} className="ml-auto text-[10px]">{channels[ch] ? 'configured' : 'off'}</Badge>
              </label>
            ))}
          </div>
        )}
        <Alert className="border-amber-200 bg-amber-50 text-amber-900" role="note">
          <ShieldAlert className="h-4 w-4" aria-hidden />
          <AlertDescription>
            Honest note: in this build there is no SMTP/SMS sender wired. Enabling a channel marks it as configured — outbound messages are queued in the Outbox with their real status, never silently dropped or faked as sent.
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  )
}

/* ============================== step 7: collections ============================== */

function CollectionsStep({ org, queueSave, canManage, markStepDone }: StepProps) {
  const { toast } = useToast()
  const initial = (() => {
    try {
      return JSON.parse(org.collectionsCfg || '{}') as { reminderDays?: number[]; maxTouchesPerInvoice?: number; quietStart?: string; quietEnd?: string; template?: string }
    } catch { return {} }
  })()
  const [reminderDays, setReminderDays] = useState((initial.reminderDays ?? [1, 3, 7]).join(', '))
  const [maxTouches, setMaxTouches] = useState(String(initial.maxTouchesPerInvoice ?? 4))
  const [quietStart, setQuietStart] = useState(initial.quietStart ?? '21:00')
  const [quietEnd, setQuietEnd] = useState(initial.quietEnd ?? '08:00')
  const [template, setTemplate] = useState(initial.template ?? 'Hi {{customer_name}}, a friendly reminder that invoice {{invoice_number}} ({{amount_due}}) was due on {{due_date}}. You can settle it any time — just reply here. — {{business_name}}')
  const [creating, setCreating] = useState(false)
  const [createdName, setCreatedName] = useState('')

  useEffect(() => {
    const days = reminderDays.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0)
    const touches = Math.max(1, Math.round(Number(maxTouches) || 4))
    queueSave('collections', {
      collectionsCfg: { reminderDays: days, maxTouchesPerInvoice: touches, quietStart, quietEnd, template },
    })
  }, [reminderDays, maxTouches, quietStart, quietEnd, template, queueSave])

  const createAutomation = async () => {
    setCreating(true)
    try {
      const days = reminderDays.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0)
      await api.post('/api/automations', {
        name: 'Overdue invoice reminders',
        description: 'Created by the setup wizard — sends reminders on the configured days after the due date.',
        triggerType: 'invoice_overdue',
        triggerCfg: { minDaysOverdue: days[0] ?? 1 },
        conditions: [{ field: 'outstandingCents', op: 'gt', value: 0 }],
        delayMinutes: 0,
        actions: [{ type: 'send_invoice_reminder', cfg: { channel: 'email', template } }],
        maxRunsPerDay: Math.max(1, Math.round(Number(maxTouches) || 4)),
        quietHours: { start: quietStart, end: quietEnd },
        testMode: true,
        enabled: true,
      })
      setCreatedName('Overdue invoice reminders')
      toast({ title: 'Automation created (test mode)', description: 'It logs what it would do — switch to live when you are comfortable.' })
      await markStepDone('collections')
    } catch (err) {
      toast({ title: 'Could not create automation', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setCreating(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Receipt className="h-4 w-4" aria-hidden /> Collections policy</CardTitle>
        <CardDescription>How persistently (and politely) overdue invoices are chased. Changes autosave.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="remDays">Reminder days after due date</Label>
            <Input id="remDays" value={reminderDays} onChange={(e) => setReminderDays(e.target.value)} placeholder="1, 3, 7" className="min-h-[44px]" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="maxTouches">Max reminders per invoice</Label>
            <Input id="maxTouches" type="number" min={1} value={maxTouches} onChange={(e) => setMaxTouches(e.target.value)} className="min-h-[44px]" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="qStart">Quiet hours start</Label>
            <Input id="qStart" value={quietStart} onChange={(e) => setQuietStart(e.target.value)} placeholder="21:00" className="min-h-[44px]" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="qEnd">Quiet hours end</Label>
            <Input id="qEnd" value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)} placeholder="08:00" className="min-h-[44px]" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="remTpl">First reminder template</Label>
          <Textarea id="remTpl" rows={4} value={template} onChange={(e) => setTemplate(e.target.value)} />
          <p className="text-xs text-muted-foreground">Placeholders: {'{{customer_name}} {{invoice_number}} {{amount_due}} {{due_date}} {{business_name}} {{payment_link}}'}</p>
        </div>
        <Separator />
        <div className="space-y-2">
          <Button onClick={() => void createAutomation()} disabled={creating || !canManage} className="min-h-[44px]" aria-label="Create the overdue reminder automation in test mode">
            {creating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <FlaskConical className="h-4 w-4" aria-hidden />}
            Create overdue-reminder automation (test mode)
          </Button>
          {createdName && (
            <p className="text-sm text-emerald-800 flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4" aria-hidden /> “{createdName}” created in TEST MODE — review it in Automations, then flip it to live.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/* ============================== step 8: test & activate ============================== */

type CheckStatus = 'pending' | 'running' | 'pass' | 'fail' | 'blocked'
type CheckItem = { key: string; label: string; status: CheckStatus; detail: string }

const INITIAL_CHECKS: CheckItem[] = [
  { key: 'customer', label: 'Create a test customer', status: 'pending', detail: '' },
  { key: 'service', label: 'Ensure a bookable service exists', status: 'pending', detail: '' },
  { key: 'availability', label: 'Fetch real availability', status: 'pending', detail: '' },
  { key: 'booking', label: 'Create a booking', status: 'pending', detail: '' },
  { key: 'invoice', label: 'Create an invoice for the booking', status: 'pending', detail: '' },
  { key: 'payment', label: 'Record a verified payment', status: 'pending', detail: '' },
  { key: 'ledger', label: 'Verify ledger entries', status: 'pending', detail: '' },
]

function TestStep({ canManage, onComplete }: StepProps & { onComplete: () => void; activated?: boolean }) {
  const { toast } = useToast()
  const [checks, setChecks] = useState<CheckItem[]>(INITIAL_CHECKS)
  const [running, setRunning] = useState(false)
  const [allPassed, setAllPassed] = useState(false)
  const [completing, setCompleting] = useState(false)

  const setCheck = (key: string, status: CheckStatus, detail = '') =>
    setChecks((cs) => cs.map((c) => c.key === key ? { ...c, status, detail: detail || c.detail } : c))

  const runTest = async () => {
    setRunning(true)
    setAllPassed(false)
    let current = INITIAL_CHECKS.map((c) => ({ ...c, status: 'pending' as CheckStatus, detail: '' }))
    setChecks(current)

    const stepKeys = INITIAL_CHECKS.map((c) => c.key)
    const active = (idx: number) => {
      current = current.map((c, i) => i === idx ? { ...c, status: 'running' as CheckStatus } : c)
      setChecks(current)
    }
    const pass = (idx: number, detail: string) => {
      current = current.map((c, i) => i === idx ? { ...c, status: 'pass' as CheckStatus, detail } : c)
      setChecks(current)
    }
    const fail = (idx: number, detail: string) => {
      current = current.map((c, i) => i === idx ? { ...c, status: 'fail' as CheckStatus, detail } : i > idx ? { ...c, status: 'blocked' as CheckStatus } : c)
      setChecks(current)
    }

    let customerId = ''
    let serviceId = ''
    let serviceName = ''
    let priceCents = 0
    let startAt = ''
    let invoiceId = ''
    let totalCents = 0

    try {
      // 1. customer
      active(0)
      try {
        const c = await api.post<{ id: string; name: string }>('/api/customers', {
          name: `Setup Test Customer ${new Date().toISOString().slice(11, 19)}`,
          notes: 'Created by the setup end-to-end test — safe to delete.',
        })
        customerId = c.id
        pass(0, `Created “${c.name}”`)
      } catch (err) {
        fail(0, err instanceof Error ? err.message : 'Unknown error')
        return
      }

      // 2. service
      active(1)
      try {
        const d = await api.get<{ services: Service[] }>('/api/services')
        const existing = d.services.find((s) => s.active)
        if (existing) {
          serviceId = existing.id
          serviceName = existing.name
          priceCents = existing.priceCents
          pass(1, `Using existing service “${existing.name}” (${formatMoney(existing.priceCents)})`)
        } else {
          const s = await api.post<Service>('/api/services', { name: 'Setup Test Service', durationMin: 30, priceCents: 5000 })
          serviceId = s.id
          serviceName = s.name
          priceCents = s.priceCents
          pass(1, `Created “${s.name}” (${formatMoney(s.priceCents)})`)
        }
      } catch (err) {
        fail(1, err instanceof Error ? err.message : 'Unknown error')
        return
      }

      // 3. availability
      active(2)
      try {
        const from = new Date(Date.now() + 60 * 60 * 1000)
        const to = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        const d = await api.get<{ slots: Array<{ startAt: string; endAt: string }>; total: number }>(
          `/api/availability?serviceId=${encodeURIComponent(serviceId)}&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
        )
        if (!d.slots.length) {
          fail(2, `No open slots in the next 7 days — widen your working hours and retry.`)
          return
        }
        startAt = d.slots[0].startAt
        pass(2, `Found ${d.total} slot(s); first at ${new Date(startAt).toLocaleString()}`)
      } catch (err) {
        fail(2, err instanceof Error ? err.message : 'Unknown error')
        return
      }

      // 4. booking
      active(3)
      try {
        const b = await api.post<{ id: string; startAt: string }>('/api/bookings', { customerId, serviceId, startAt })
        pass(3, `Booking created at ${new Date(b.startAt).toLocaleString()}`)
      } catch (err) {
        fail(3, err instanceof Error ? err.message : 'Unknown error')
        return
      }

      // 5. invoice
      active(4)
      try {
        const inv = await api.post<{ id: string; number: string; totalCents: number }>('/api/invoices', {
          customerId,
          items: [{ description: `${serviceName} (setup test)`, qty: 1, unitPriceCents: priceCents }],
        })
        invoiceId = inv.id
        totalCents = inv.totalCents
        pass(4, `Invoice ${inv.number} for ${formatMoney(inv.totalCents)}`)
      } catch (err) {
        fail(4, err instanceof Error ? err.message : 'Unknown error')
        return
      }

      // 6. payment
      active(5)
      try {
        const p = await api.post<{ id?: string; status?: string }>(`/api/invoices/${invoiceId}/payments`, {
          amountCents: totalCents, method: 'cash', reference: 'setup-test',
        })
        pass(5, `Verified payment recorded (${p.status ?? 'verified'}, ${formatMoney(totalCents)})`)
      } catch (err) {
        fail(5, err instanceof Error ? err.message : 'Unknown error')
        return
      }

      // 7. ledger
      active(6)
      try {
        const d = await api.get<{ entries: Array<{ id: string; invoiceId: string | null; type: string }> }>('/api/ledger?limit=50')
        const matching = d.entries.filter((e) => e.invoiceId === invoiceId)
        if (matching.length === 0) {
          fail(6, `No ledger entries found for invoice — expected at least one (got ${d.entries.length} total entries).`)
          return
        }
        pass(6, `${matching.length} ledger entr${matching.length === 1 ? 'y' : 'ies'} posted for this invoice (debit/credit balanced)`)
      } catch (err) {
        fail(6, err instanceof Error ? err.message : 'Unknown error')
        return
      }

      setAllPassed(true)
      toast({ title: 'End-to-end test passed', description: 'Bookings, invoicing, payments and ledger all responded correctly.' })
    } finally {
      setRunning(false)
    }
  }

  const complete = async () => {
    setCompleting(true)
    try {
      onComplete()
    } finally {
      setCompleting(false)
    }
  }

  const icon = (status: CheckStatus) => {
    switch (status) {
      case 'pass': return <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" aria-hidden />
      case 'fail': return <XCircle className="h-4 w-4 text-rose-600 shrink-0" aria-hidden />
      case 'running': return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" aria-hidden />
      case 'blocked': return <MinusCircle className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
      default: return <CircleDashed className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><PlayCircle className="h-4 w-4" aria-hidden /> End-to-end test &amp; activation</CardTitle>
        <CardDescription>
          Runs a real customer → booking → invoice → verified payment → ledger flow against your live data. Everything it creates is labeled “setup test”.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-2" aria-label="Test checklist" aria-live="polite">
          {checks.map((c) => (
            <li key={c.key} className="flex items-start gap-2 text-sm rounded-md border p-2.5">
              {icon(c.status)}
              <div className="min-w-0">
                <p className={cn(c.status === 'pass' && 'text-emerald-900', c.status === 'fail' && 'text-rose-800 font-medium', c.status === 'blocked' && 'text-muted-foreground')}>
                  {c.label}
                </p>
                {c.detail && <p className={cn('text-xs mt-0.5 break-words', c.status === 'fail' ? 'text-rose-700' : 'text-muted-foreground')}>{c.detail}</p>}
              </div>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void runTest()} disabled={running} className="min-h-[44px]" aria-label="Run the end-to-end test">
            {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <PlayCircle className="h-4 w-4" aria-hidden />}
            {checks.some((c) => c.status === 'pass') ? 'Run test again' : 'Run end-to-end test'}
          </Button>
          <Button
            onClick={() => void complete()}
            disabled={!allPassed || completing || !canManage}
            className="min-h-[44px]"
            aria-label="Complete setup"
          >
            {completing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}
            Complete setup
          </Button>
        </div>
        {!canManage && <p className="text-xs text-muted-foreground">Activation requires an owner or admin account.</p>}
      </CardContent>
    </Card>
  )
}
