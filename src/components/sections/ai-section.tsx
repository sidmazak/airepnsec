'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, formatDateTime, type ProviderConfigPublic, type ModelRecommendation } from '@/lib/client/api'
import { useAppStore } from '@/lib/client/store'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PROVIDER_KIND_LABELS, presetsFor, type AiPreset, type PresetCapability } from '@/lib/ai/presets'
import {
  Bot, CheckCircle2, Database, Download, Globe, KeyRound, Loader2, Monitor, PlugZap, RefreshCw,
  ShieldAlert, ShieldCheck, Trash2, XCircle,
} from 'lucide-react'

/* ------------------------------ helpers ------------------------------ */

const PROVIDER_LABELS: Record<string, string> = PROVIDER_KIND_LABELS

const CLOUD_PROVIDERS = ['openai_compatible', 'anthropic', 'google', 'azure_openai']

function presetDefaultModel(preset: AiPreset, capability: string): string {
  if (capability === 'embedding') return preset.models.find((m) => /embed/i.test(m)) ?? preset.models[0] ?? ''
  if (capability === 'stt') return preset.models.find((m) => /whisper|stt|transcribe/i.test(m)) ?? preset.models[0] ?? ''
  if (capability === 'tts') return preset.models.find((m) => /tts|speech/i.test(m)) ?? preset.models[0] ?? ''
  if (capability === 'rerank') return preset.models.find((m) => /rerank/i.test(m)) ?? preset.models[0] ?? ''
  if (capability === 'vision') return preset.models.find((m) => /vision|pixtral|gemini/i.test(m)) ?? preset.models[0] ?? ''
  return preset.models[0] ?? ''
}

const DATA_MODES: Array<{ id: string; title: string; description: string }> = [
  { id: 'local_only', title: 'Strict — local only', description: 'Never call cloud AI — requires local Ollama or a compatible local endpoint.' },
  { id: 'hybrid', title: 'Hybrid', description: 'Local + cloud allowed; you choose per capability.' },
  { id: 'cloud_first', title: 'Cloud first', description: 'Prefer cloud models where a cloud provider is configured.' },
]

function isCloudProvider(p: string): boolean {
  return CLOUD_PROVIDERS.includes(p)
}

type CapabilityInfo = { label: string; description: string; kinds: string[] }
type TestResult = { ok: boolean; message: string; latencyMs: number }
type AiLog = {
  id?: string; ts: string; capability: string; provider: string; model: string
  latencyMs: number; tokensIn: number; tokensOut: number; ok: boolean; errorSanitized: string
}
type Draft = { provider: string; baseUrl: string; model: string; apiKey: string | null; enabled: boolean; apiVersion: string }

type LocalSpeechModelRow = {
  id: string
  capability: 'stt' | 'tts'
  label: string
  repo: string
  approxBytes: number
  license: string
  notes: string
  installed: boolean
  bytesOnDisk: number
}

export type HardwareInfoResponse = {
  hardware: {
    platform: string
    nodeVersion: string
    cpuModel: string
    cpuCores: number
    ramTotalGb: number
    ramFreeGb: number
    gpu: { vendor: string; name: string; vramGb: number | null; count: number }
    diskFreeGb: number | null
    tier: string
  }
  recommendations: ModelRecommendation[]
  recommendedChatModel: ModelRecommendation | null
  configured: Array<{ capability: string; provider: string; model: string; enabled: boolean }>
}

function HardwareRow({ info }: { info: HardwareInfoResponse['hardware'] }) {
  const rows: Array<[string, string]> = [
    ['Platform', `${info.platform} · Node ${info.nodeVersion}`],
    ['CPU', `${info.cpuModel} · ${info.cpuCores} cores`],
    ['Memory', `${info.ramTotalGb} GB total · ${info.ramFreeGb} GB free`],
    ['GPU', info.gpu.vendor === 'none' ? 'none detected' : `${info.gpu.name}${info.gpu.vramGb ? ` · ${info.gpu.vramGb} GB VRAM` : ''}`],
    ['Disk free', info.diskFreeGb === null ? 'unknown' : `${info.diskFreeGb} GB`],
    ['Tier', info.tier],
  ]
  return (
    <div className="rounded-lg border p-3 space-y-1.5">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-3 text-sm">
          <span className="text-muted-foreground">{k}</span>
          <span className="text-right font-medium">{v}</span>
        </div>
      ))}
    </div>
  )
}

function HardwareRecommendations({ info }: { info: HardwareInfoResponse }) {
  const best = info.recommendedChatModel
  const configuredChat = info.configured.find((c) => c.capability === 'llm' && c.enabled)
  return (
    <div className="rounded-lg border p-3 space-y-2">
      <p className="text-sm">
        {best ? (
          <>
            Recommended chat model: <span className="font-medium">{best.model}</span>{' '}
            <span className="text-muted-foreground">({best.sizeGb} GB, {best.note})</span>
          </>
        ) : (
          <span className="text-muted-foreground">No catalog model fits this machine — use an external endpoint.</span>
        )}
      </p>
      {configuredChat && (
        <p className="text-xs text-muted-foreground">
          Currently configured: {configuredChat.provider} · {configuredChat.model || 'no model set'}
        </p>
      )}
      <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
        {info.recommendations.map((r) => (
          <div key={`${r.capability}-${r.model}`} className="flex items-start justify-between gap-2 text-xs">
            <div className="min-w-0">
              <span className="font-medium">{r.model}</span>{' '}
              <span className="text-muted-foreground">({r.capability} · {r.sizeGb} GB)</span>
              <p className="text-muted-foreground">{r.note}</p>
            </div>
            <Badge variant={r.fits ? 'outline' : 'secondary'} className="shrink-0">
              {r.fits ? 'fits' : 'too big'}
            </Badge>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------ section ------------------------------ */

export function AiSection() {
  const { toast } = useToast()
  const session = useAppStore((s) => s.session)
  const canManage = session?.user?.role === 'owner' || session?.user?.role === 'admin'

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [capabilities, setCapabilities] = useState<Record<string, ProviderConfigPublic>>({})
  const [capabilityInfo, setCapabilityInfo] = useState<Record<string, CapabilityInfo>>({})
  const [dataMode, setDataMode] = useState('hybrid')

  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [savingCap, setSavingCap] = useState<string | null>(null)
  const [testingCap, setTestingCap] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({})
  const [modelOptions, setModelOptions] = useState<Record<string, string[]>>({})
  const [modelsLoading, setModelsLoading] = useState<string | null>(null)
  const [modelNotice, setModelNotice] = useState<Record<string, string>>({})
  const [modelCustom, setModelCustom] = useState<Record<string, boolean>>({})

  const [tab, setTab] = useState('providers')
  const [logs, setLogs] = useState<AiLog[]>([])
  const [logsLoading, setLogsLoading] = useState(false)
  const [hwLoading, setHwLoading] = useState(false)
  const [hardwareInfo, setHardwareInfo] = useState<HardwareInfoResponse | null>(null)
  const [logsError, setLogsError] = useState('')

  const [channels, setChannels] = useState<{ email: boolean; sms: boolean } | null>(null)
  const [channelsBusy, setChannelsBusy] = useState(false)

  // The local speech model catalog — one row per ONNX model in .models/.
  const [localSpeechModels, setLocalSpeechModels] = useState<LocalSpeechModelRow[]>([])
  const [localSpeechBusy, setLocalSpeechBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await api.get<{ capabilities: Record<string, ProviderConfigPublic>; dataMode: string; capabilityInfo: Record<string, CapabilityInfo> }>('/api/providers')
      setCapabilities(d.capabilities)
      setCapabilityInfo(d.capabilityInfo ?? {})
      setDataMode(d.dataMode)
      setDrafts(Object.fromEntries(
        Object.entries(d.capabilities).map(([cap, cfg]) => [cap, {
          provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model, apiKey: null, enabled: cfg.enabled,
          apiVersion: typeof cfg.config?.apiVersion === 'string' ? cfg.config.apiVersion : '',
        }]),
      ))
      setModelOptions(Object.fromEntries(
        Object.entries(d.capabilities).map(([cap, cfg]) => {
          const preset = presetsFor(cap as PresetCapability).find((p) => p.provider === cfg.provider && p.baseUrl === cfg.baseUrl)
          return [cap, preset?.models ?? []]
        }),
      ))
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load AI provider settings')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadLogs = useCallback(async () => {
    setLogsLoading(true)
    try {
      const d = await api.get<{ logs: AiLog[] }>('/api/ai/logs?limit=30')
      setLogs(d.logs)
      setLogsError('')
    } catch (err) {
      setLogsError(err instanceof Error ? err.message : 'Could not load the activity log')
    } finally {
      setLogsLoading(false)
    }
  }, [])

  const loadHardware = useCallback(async () => {
    setHwLoading(true)
    try {
      const d = await api.get<HardwareInfoResponse>('/api/system/hardware')
      setHardwareInfo(d)
    } catch {
      setHardwareInfo(null)
    } finally {
      setHwLoading(false)
    }
  }, [])

  const loadChannels = useCallback(async () => {
    try {
      const d = await api.get<{ email: boolean; sms: boolean }>('/api/settings/channels')
      setChannels(d)
    } catch { /* non-fatal */ }
  }, [])

  const loadLocalSpeechModels = useCallback(async () => {
    try {
      const d = await api.get<{ models: LocalSpeechModelRow[] }>('/api/ai/speech/models')
      setLocalSpeechModels(d.models ?? [])
    } catch {
      setLocalSpeechModels([])
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadChannels() }, [loadChannels])
  useEffect(() => { void loadLocalSpeechModels() }, [loadLocalSpeechModels])
  useEffect(() => { if (tab === 'logs') void loadLogs() }, [tab, loadLogs])
  useEffect(() => { if (tab === 'hardware') void loadHardware() }, [tab, loadHardware])

  const downloadLocalModel = async (id: string) => {
    setLocalSpeechBusy(id)
    try {
      const r = await api.post<{ detail: string }>('/api/ai/speech/models', { id })
      toast({ title: 'Model ready', description: r.detail })
      await loadLocalSpeechModels()
    } catch (err) {
      toast({ title: 'Download failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setLocalSpeechBusy(null)
    }
  }

  const removeLocalModel = async (id: string) => {
    setLocalSpeechBusy(id)
    try {
      const r = await api.delete<{ detail: string }>('/api/ai/speech/models', { id })
      toast({ title: 'Model removed', description: r.detail })
      await loadLocalSpeechModels()
    } catch (err) {
      toast({ title: 'Could not remove the model', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setLocalSpeechBusy(null)
    }
  }

  const setDataModeValue = async (mode: string) => {
    if (!canManage) return
    try {
      await api.put('/api/settings/data-mode', { dataMode: mode })
      setDataMode(mode)
      toast({
        title: 'Data mode updated',
        description: mode === 'local_only' ? 'Cloud AI calls are now blocked server-side.' : 'Cloud AI calls follow your per-capability settings.',
      })
    } catch (err) {
      toast({ title: 'Could not change data mode', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    }
  }

  const setDraft = (cap: string, patch: Partial<Draft>) => {
    setDrafts((d) => ({ ...d, [cap]: { ...d[cap], ...patch } }))
  }

  const saveCapability = async (cap: string) => {
    const draft = drafts[cap]
    if (!draft) return
    setSavingCap(cap)
    try {
      const body: Record<string, unknown> = {
        provider: draft.provider,
        baseUrl: draft.baseUrl.trim(),
        model: draft.model.trim(),
        enabled: draft.enabled,
      }
      if (draft.apiKey !== null) body.apiKey = draft.apiKey // '' clears, non-empty replaces, null keeps
      if (draft.provider === 'azure_openai') {
        body.config = { ...capabilities[cap]?.config, ...(draft.apiVersion.trim() ? { apiVersion: draft.apiVersion.trim() } : {}) }
      }
      const d = await api.put<{ config: ProviderConfigPublic }>(`/api/providers/${cap}`, body)
      setCapabilities((c) => ({ ...c, [cap]: d.config }))
      setDrafts((dr) => ({ ...dr, [cap]: {
        ...dr[cap], provider: d.config.provider, baseUrl: d.config.baseUrl, model: d.config.model,
        apiKey: null, enabled: d.config.enabled, apiVersion: typeof d.config.config?.apiVersion === 'string' ? d.config.config.apiVersion : '',
      } }))
      toast({ title: `${capabilityInfo[cap]?.label ?? cap} saved` })
    } catch (err) {
      toast({ title: 'Save failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setSavingCap(null)
    }
  }

  const applyPreset = (cap: string, preset: AiPreset) => {
    setDraft(cap, {
      provider: preset.provider,
      baseUrl: preset.baseUrl,
      model: presetDefaultModel(preset, cap) || drafts[cap]?.model || '',
      enabled: true,
    })
    setModelOptions((o) => ({ ...o, [cap]: preset.models }))
    setModelCustom((c) => ({ ...c, [cap]: false }))
    setModelNotice((n) => ({ ...n, [cap]: preset.note ?? '' }))
  }

  const loadModels = async (cap: string) => {
    const draft = drafts[cap]
    if (!draft) return
    setModelsLoading(cap)
    setModelNotice((n) => ({ ...n, [cap]: '' }))
    try {
      const r = await api.post<{ models: string[]; source: string; error?: string }>(`/api/providers/${cap}/models`, {
        provider: draft.provider,
        baseUrl: draft.baseUrl,
        model: draft.model,
        apiKey: draft.apiKey ?? undefined,
      })
      setModelOptions((o) => ({ ...o, [cap]: r.models }))
      if (r.error) setModelNotice((n) => ({ ...n, [cap]: r.error ?? '' }))
      else if (r.models.length === 0) setModelNotice((n) => ({ ...n, [cap]: 'The provider returned no models — type the model id manually.' }))
      if (r.models.length > 0 && !draft.model) setDraft(cap, { model: r.models[0] })
      setModelCustom((c) => ({ ...c, [cap]: false }))
    } catch (err) {
      setModelNotice((n) => ({ ...n, [cap]: err instanceof Error ? err.message : 'Could not load models' }))
    } finally {
      setModelsLoading(null)
    }
  }

  const testCapability = async (cap: string) => {
    setTestingCap(cap)
    try {
      const r = await api.post<TestResult>(`/api/providers/${cap}/test`)
      setTestResults((t) => ({ ...t, [cap]: r }))
      await load()
    } catch (err) {
      setTestResults((t) => ({
        ...t,
        [cap]: { ok: false, message: err instanceof Error ? err.message : 'Test failed', latencyMs: 0 },
      }))
    } finally {
      setTestingCap(null)
    }
  }

  const toggleChannel = async (key: 'email' | 'sms', value: boolean) => {
    if (!channels || !canManage) return
    setChannelsBusy(true)
    const next = { ...channels, [key]: value }
    try {
      const d = await api.put<{ email: boolean; sms: boolean }>('/api/settings/channels', next)
      setChannels(d)
      toast({
        title: value ? `${key.toUpperCase()} channel marked configured` : `${key.toUpperCase()} channel disabled`,
        description: value ? 'Queued outbox messages will use it once a sender is wired.' : undefined,
      })
    } catch (err) {
      toast({ title: 'Could not update channels', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setChannelsBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-4" aria-label="Loading AI settings">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 lg:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-32 w-full" />)}</div>
        <div className="grid gap-4 lg:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-64 w-full" />)}</div>
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription className="space-y-2">
          <p>{error}</p>
          <Button size="sm" variant="outline" onClick={() => void load()} className="min-h-[44px]">Retry</Button>
        </AlertDescription>
      </Alert>
    )
  }

  const caps = Object.entries(capabilities)

  return (
    <div className="space-y-4" aria-label="AI providers and privacy">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <h2 className="text-lg font-semibold tracking-tight">AI Providers &amp; privacy</h2>
          <p className="text-sm text-muted-foreground">Which models run each capability, where your data flows, and proof that it works.</p>
        </div>
        {!canManage && <Badge variant="outline">read-only — owner/admin can edit</Badge>}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="AI settings tabs">
          <TabsTrigger value="providers" className="min-h-[44px]"><Bot className="h-4 w-4 mr-1.5" aria-hidden /> Providers</TabsTrigger>
          <TabsTrigger value="hardware" className="min-h-[44px]"><Monitor className="h-4 w-4 mr-1.5" aria-hidden /> Hardware</TabsTrigger>
          <TabsTrigger value="logs" className="min-h-[44px]"><RefreshCw className="h-4 w-4 mr-1.5" aria-hidden /> AI activity log</TabsTrigger>
        </TabsList>

        <TabsContent value="hardware" className="space-y-4 mt-4">
          {/* hardware */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2"><Monitor className="h-4 w-4" aria-hidden /> Host capabilities</CardTitle>
              <CardDescription>What this machine can run — read locally, no data leaves it.</CardDescription>
            </CardHeader>
            <CardContent>
              {hwLoading ? (
                <Skeleton className="h-60 w-full" />
              ) : hardwareInfo ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <HardwareRow info={hardwareInfo.hardware} />
                  <HardwareRecommendations info={hardwareInfo} />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Loading the hardware probe…</p>
              )}
            </CardContent>
          </Card>

          {/* data mode */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2"><Globe className="h-4 w-4" aria-hidden /> Data mode</CardTitle>
              <CardDescription>Controls whether any cloud AI may be contacted, org-wide.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Data mode">
                {DATA_MODES.map((m) => {
                  const selected = dataMode === m.id
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={!canManage}
                      onClick={() => void setDataModeValue(m.id)}
                      className={cn(
                        'text-left rounded-lg border p-3 min-h-[44px] transition-colors disabled:opacity-60',
                        selected ? 'border-primary bg-muted/50' : 'hover:bg-muted/40',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        {m.id === 'local_only'
                          ? <ShieldCheck className={cn('h-4 w-4', selected ? 'text-emerald-700' : 'text-muted-foreground')} aria-hidden />
                          : <ShieldAlert className={cn('h-4 w-4', selected && m.id !== 'hybrid' ? 'text-amber-700' : 'text-muted-foreground')} aria-hidden />}
                        <span className="font-medium text-sm">{m.title}</span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">{m.description}</p>
                    </button>
                  )
                })}
              </div>
              {dataMode === 'local_only' && (
                <p className="mt-2 text-xs text-emerald-800 flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Strict mode is enforced server-side — cloud calls are blocked even if configured.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="providers" className="space-y-4 mt-4">
          {/* local speech model catalog */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Local speech models</CardTitle>
              <CardDescription>
                Speech-to-text and text-to-speech that run entirely on this machine. The ONNX weights are stored in
                the <code className="bg-muted rounded px-1 py-0.5">.models/</code> folder and are downloaded from the
                Hugging Face CDN on demand — no audio ever leaves the server.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {localSpeechModels.length === 0 ? (
                <p className="text-sm text-muted-foreground">The local model catalog is not available.</p>
              ) : (
                localSpeechModels.map((m) => (
                  <div key={m.id} className="rounded-md border p-3 flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium flex items-center gap-2">
                        {m.label}
                        <Badge variant={m.installed ? 'outline' : 'secondary'}>
                          {m.installed ? 'installed' : 'not downloaded'}
                        </Badge>
                      </p>
                      <p className="text-xs text-muted-foreground">{m.notes}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {m.repo} · {m.license} · ≈{Math.round(m.approxBytes / 1_000_000)} MB
                        {m.installed ? ` · ${(m.bytesOnDisk / 1_000_000).toFixed(1)} MB on disk` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {m.installed ? (
                        <Button
                          variant="outline" size="sm" className="min-h-[36px]"
                          disabled={!canManage || localSpeechBusy === m.id}
                          onClick={() => void removeLocalModel(m.id)}
                          aria-label={`Remove ${m.label}`}
                        >
                          {localSpeechBusy === m.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
                          Remove
                        </Button>
                      ) : (
                        <Button
                          size="sm" className="min-h-[36px]"
                          disabled={!canManage || localSpeechBusy === m.id}
                          onClick={() => void downloadLocalModel(m.id)}
                          aria-label={`Download ${m.label}`}
                        >
                          {localSpeechBusy === m.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
                          Download
                        </Button>
                      )}
                    </div>
                  </div>
                ))
              )}
              <p className="text-xs text-muted-foreground">
                The first download and the first inference are slow on CPU (tens of seconds) — afterwards the models stay
                loaded in memory. Whisper needs 16 kHz mono audio; compressed browser recordings are converted with
                ffmpeg when it is installed on the server.
              </p>
            </CardContent>
          </Card>

          {/* capability cards */}
          <div className="grid gap-4 lg:grid-cols-2">
            {caps.map(([cap, cfg]) => {
              const info = capabilityInfo[cap]
              const draft = drafts[cap] ?? { provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model, apiKey: null, enabled: cfg.enabled, apiVersion: '' }
              const test = testResults[cap]
              const cloud = isCloudProvider(draft.provider)
              const needsBaseUrl = ['ollama', 'openai_compatible', 'anthropic', 'google', 'azure_openai'].includes(draft.provider)
              const needsKey = CLOUD_PROVIDERS.includes(draft.provider)
              const presets = presetsFor(cap as PresetCapability)
              const activePreset = presets.find((p) => p.provider === draft.provider && p.baseUrl === draft.baseUrl)
              const options = modelOptions[cap] ?? []
              const showCustomModel = Boolean(modelCustom[cap]) || (options.length > 0 && draft.model !== '' && !options.includes(draft.model))
              return (
                <Card key={cap}>
                  <CardHeader>
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <CardTitle className="text-base">{info?.label ?? cap}</CardTitle>
                        <CardDescription>{info?.description}</CardDescription>
                      </div>
                      <label className="flex items-center gap-2 text-sm shrink-0">
                        <Switch
                          checked={draft.enabled}
                          disabled={!canManage}
                          onCheckedChange={(v) => setDraft(cap, { enabled: v })}
                          aria-label={`Enable ${info?.label ?? cap}`}
                        />
                        {draft.enabled ? 'On' : 'Off'}
                      </label>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor={`prov-${cap}`}>Provider</Label>
                      <Select value={draft.provider} disabled={!canManage} onValueChange={(v) => setDraft(cap, { provider: v })}>
                        <SelectTrigger id={`prov-${cap}`} className="min-h-[44px]" aria-label={`Provider for ${info?.label ?? cap}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(info?.kinds ?? Object.keys(PROVIDER_LABELS)).map((k) => (
                            <SelectItem key={k} value={k}>{PROVIDER_LABELS[k] ?? k}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {presets.length > 0 && (
                      <div className="space-y-1.5">
                        <Label htmlFor={`preset-${cap}`}>Preset</Label>
                        <Select
                          value={activePreset?.id ?? ''}
                          disabled={!canManage}
                          onValueChange={(id) => {
                            const preset = presets.find((p) => p.id === id)
                            if (preset) applyPreset(cap, preset)
                          }}
                        >
                          <SelectTrigger id={`preset-${cap}`} className="min-h-[44px]" aria-label={`Provider preset for ${info?.label ?? cap}`}>
                            <SelectValue placeholder="Choose a provider preset (optional)" />
                          </SelectTrigger>
                          <SelectContent>
                            {presets.map((p) => (
                              <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {activePreset?.note && <p className="text-xs text-muted-foreground">{activePreset.note}</p>}
                      </div>
                    )}

                    {needsBaseUrl && (
                      <div className="space-y-1.5">
                        <Label htmlFor={`url-${cap}`}>Base URL</Label>
                        <Input
                          id={`url-${cap}`} value={draft.baseUrl} disabled={!canManage}
                          onChange={(e) => setDraft(cap, { baseUrl: e.target.value })}
                          placeholder={draft.provider === 'azure_openai' ? 'https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT' : 'http://localhost:11434'}
                          className="min-h-[44px]"
                        />
                      </div>
                    )}

                    {draft.provider === 'azure_openai' && (
                      <div className="space-y-1.5">
                        <Label htmlFor={`apiver-${cap}`}>Azure API version</Label>
                        <Input
                          id={`apiver-${cap}`} value={draft.apiVersion} disabled={!canManage}
                          onChange={(e) => setDraft(cap, { apiVersion: e.target.value })}
                          placeholder="2024-10-21"
                          className="min-h-[44px]"
                        />
                      </div>
                    )}

                    {draft.provider === 'local_speech' && (cap === 'stt' || cap === 'tts') && (
                      <div className="space-y-1.5">
                        <Label htmlFor={`model-${cap}`}>Local model</Label>
                        <Select
                          value={draft.model || localSpeechModels.find((m) => m.capability === cap)?.id || ''}
                          disabled={!canManage}
                          onValueChange={(v) => setDraft(cap, { model: v })}
                        >
                          <SelectTrigger id={`model-${cap}`} className="min-h-[44px]" aria-label={`Local speech model for ${info?.label ?? cap}`}>
                            <SelectValue placeholder="Pick a downloaded model" />
                          </SelectTrigger>
                          <SelectContent>
                            {localSpeechModels.filter((m) => m.capability === cap).map((m) => (
                              <SelectItem key={m.id} value={m.id}>
                                {m.label}{m.installed ? '' : ' — not downloaded'}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                          Download the weights under &quot;Local speech models&quot; below — the model runs on this machine and no audio leaves the server.
                        </p>
                      </div>
                    )}

                    {(needsBaseUrl) && (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <Label htmlFor={`model-${cap}`}>Model</Label>
                          <Button
                            type="button" size="sm" variant="ghost" className="h-8 px-2 text-xs"
                            disabled={!canManage || modelsLoading === cap}
                            onClick={() => void loadModels(cap)}
                            aria-label={`Load model list for ${info?.label ?? cap}`}
                          >
                            {modelsLoading === cap ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
                            Load models
                          </Button>
                        </div>
                        {options.length > 0 && !showCustomModel ? (
                          <Select
                            value={draft.model}
                            disabled={!canManage}
                            onValueChange={(v) => {
                              if (v === '__custom__') {
                                setModelCustom((c) => ({ ...c, [cap]: true }))
                                setDraft(cap, { model: '' })
                              } else {
                                setDraft(cap, { model: v })
                              }
                            }}
                          >
                            <SelectTrigger id={`model-${cap}`} className="min-h-[44px]" aria-label={`Model for ${info?.label ?? cap}`}>
                              <SelectValue placeholder="Pick a model" />
                            </SelectTrigger>
                            <SelectContent>
                              {options.map((m) => (
                                <SelectItem key={m} value={m}>{m}</SelectItem>
                              ))}
                              <SelectItem value="__custom__">Custom model id…</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input
                            id={`model-${cap}`} value={draft.model} disabled={!canManage}
                            onChange={(e) => setDraft(cap, { model: e.target.value })}
                            placeholder={cap === 'embedding' ? 'e.g. nomic-embed-text / text-embedding-3-small' : 'e.g. llama3.1:8b / claude-sonnet-4-20250514 / gemini-2.5-flash'}
                            className="min-h-[44px]"
                          />
                        )}
                        {showCustomModel && options.length > 0 && (
                          <button
                            type="button"
                            className="text-xs text-muted-foreground underline underline-offset-2"
                            onClick={() => {
                              setModelCustom((c) => ({ ...c, [cap]: false }))
                              setDraft(cap, { model: options[0] })
                            }}
                          >
                            Back to the provider model list
                          </button>
                        )}
                        {modelNotice[cap] && <p className="text-xs text-muted-foreground">{modelNotice[cap]}</p>}
                      </div>
                    )}

                    {needsKey && (
                      <div className="space-y-1.5">
                        <Label htmlFor={`key-${cap}`} className="flex items-center gap-1.5"><KeyRound className="h-3.5 w-3.5" aria-hidden /> API key</Label>
                        <Input
                          id={`key-${cap}`} type="password" disabled={!canManage}
                          value={draft.apiKey ?? ''}
                          onChange={(e) => setDraft(cap, { apiKey: e.target.value })}
                          placeholder={cfg.apiKeyPresent ? '•••••••• (saved — leave blank to keep)' : (activePreset?.keyHint ? `${activePreset.keyHint}` : 'Paste key')}
                          autoComplete="off"
                          className="min-h-[44px]"
                        />
                        <p className="text-xs text-muted-foreground">
                          {cfg.apiKeyPresent
                            ? 'A key is saved. Leave blank to keep it — type a new one to replace it, or empty the field and save to remove it.'
                            : 'Stored server-side, never echoed back to the browser.'}
                        </p>
                      </div>
                    )}

                    <div className="rounded-md border p-2.5 text-xs flex items-start gap-2" aria-label="Data flow">
                      {cloud
                        ? <ShieldAlert className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" aria-hidden />
                        : <ShieldCheck className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" aria-hidden />}
                      <span className={cloud ? 'text-amber-900' : 'text-emerald-900'}>{cfg.processesDataWhere || `Data is processed ${cloud ? 'by the external provider' : 'locally'}.`}</span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm" onClick={() => void saveCapability(cap)} disabled={!canManage || savingCap === cap}
                        className="min-h-[44px]" aria-label={`Save ${info?.label ?? cap} configuration`}
                      >
                        {savingCap === cap ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <PlugZap className="h-4 w-4" aria-hidden />}
                        Save
                      </Button>
                      <Button
                        size="sm" variant="outline" onClick={() => void testCapability(cap)}
                        disabled={testingCap === cap || !canManage}
                        className="min-h-[44px]" aria-label={`Test connection for ${info?.label ?? cap}`}
                      >
                        {testingCap === cap ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
                        Test connection
                      </Button>
                    </div>

                    {test && (
                      <Alert
                        role="status"
                        className={test.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'}
                      >
                        {test.ok ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <XCircle className="h-4 w-4" aria-hidden />}
                        <AlertDescription>
                          {test.message || (test.ok ? 'Connection OK.' : 'Test failed.')} {test.latencyMs ? `(${test.latencyMs} ms)` : ''}
                        </AlertDescription>
                      </Alert>
                    )}

                    {!test && cfg.lastTestAt && (
                      <p className={cn('text-xs flex items-center gap-1.5', cfg.lastTestOk ? 'text-emerald-700' : 'text-rose-700')}>
                        {cfg.lastTestOk ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : <XCircle className="h-3.5 w-3.5" aria-hidden />}
                        Last test {cfg.lastTestOk ? 'passed' : 'failed'} · {formatDateTime(cfg.lastTestAt)}
                        {cfg.lastTestError && !cfg.lastTestOk ? ` — ${cfg.lastTestError}` : ''}
                      </p>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>

          {/* channels mini-card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2"><Database className="h-4 w-4" aria-hidden /> Channels</CardTitle>
              <CardDescription>Mark email/SMS as configured for queued delivery.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {channels ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {(['email', 'sms'] as const).map((ch) => (
                    <label key={ch} className="flex items-center gap-3 rounded-md border p-3 text-sm">
                      <Switch
                        checked={channels[ch]}
                        disabled={!canManage || channelsBusy}
                        onCheckedChange={(v) => void toggleChannel(ch, v)}
                        aria-label={`${channels[ch] ? 'Disable' : 'Enable'} ${ch} channel`}
                      />
                      <span className="capitalize font-medium">{ch}</span>
                      <Badge variant={channels[ch] ? 'secondary' : 'outline'} className="ml-auto text-[10px]">
                        {channels[ch] ? 'configured' : 'not configured'}
                      </Badge>
                    </label>
                  ))}
                </div>
              ) : (
                <Skeleton className="h-16 w-full" />
              )}
              <Alert className="border-amber-200 bg-amber-50 text-amber-900" role="note">
                <ShieldAlert className="h-4 w-4" aria-hidden />
                <AlertDescription>
                  In this build, enabling marks the channel as configured for queued outbox delivery; no external sender is wired.
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="logs" className="space-y-3 mt-4">
          <div className="flex items-center gap-2">
            <p className="text-sm text-muted-foreground mr-auto">Every AI call is logged with metrics only — never conversation content.</p>
            <Button size="sm" variant="outline" onClick={() => void loadLogs()} disabled={logsLoading} className="min-h-[44px]" aria-label="Refresh activity log">
              {logsLoading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
              Refresh
            </Button>
          </div>

          {logsLoading && logs.length === 0 ? (
            <div className="space-y-2" aria-label="Loading activity log">
              {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : logsError ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="space-y-2">
                <p>{logsError}</p>
                <Button size="sm" variant="outline" onClick={() => void loadLogs()} className="min-h-[44px]">Retry</Button>
              </AlertDescription>
            </Alert>
          ) : logs.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center space-y-2">
                <Bot className="h-8 w-8 mx-auto text-muted-foreground" aria-hidden />
                <p className="text-sm text-muted-foreground">No AI calls yet. Chat with the receptionist in the Inbox and activity will appear here.</p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <div className="max-h-96 overflow-y-auto">
                  <Table aria-label="AI activity log">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Time</TableHead>
                        <TableHead>Capability</TableHead>
                        <TableHead className="hidden sm:table-cell">Provider / model</TableHead>
                        <TableHead>Latency</TableHead>
                        <TableHead className="hidden md:table-cell">Tokens (in/out)</TableHead>
                        <TableHead>Result</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {logs.map((l, i) => (
                        <TableRow key={l.id ?? i}>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{formatDateTime(l.ts)}</TableCell>
                          <TableCell className="text-sm">{l.capability}</TableCell>
                          <TableCell className="hidden sm:table-cell text-sm">
                            {l.provider}
                            <span className="text-muted-foreground"> · {l.model || '—'}</span>
                          </TableCell>
                          <TableCell className="text-sm">{l.latencyMs} ms</TableCell>
                          <TableCell className="hidden md:table-cell text-sm text-muted-foreground">{l.tokensIn} / {l.tokensOut}</TableCell>
                          <TableCell>
                            {l.ok ? (
                              <Badge className="bg-emerald-100 text-emerald-900 text-[10px]">ok</Badge>
                            ) : (
                              <span>
                                <Badge className="bg-rose-100 text-rose-900 text-[10px]">failed</Badge>
                                {l.errorSanitized && <p className="text-[10px] text-rose-700 max-w-[200px] mt-1">{l.errorSanitized}</p>}
                              </span>
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
          <Separator />
          <p className="text-xs text-muted-foreground">Logs are written by the AI platform for transparency. Sanitized errors only — no customer data.</p>
        </TabsContent>
      </Tabs>
    </div>
  )
}
