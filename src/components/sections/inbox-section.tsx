'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, streamPost, type ConversationRow, type Customer, type MessageRow, type StreamHandlers } from '@/lib/client/api'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ArrowLeft, Bot, CheckCircle2, CircleAlert, Loader2, Mic, MessageSquare, Plus,
  Send, ShieldAlert, Sparkles, UserRound, Volume2, XCircle, Wrench,
} from 'lucide-react'

/** List endpoint adds a denormalized customerName alongside customer. */
type ConvListRow = ConversationRow & { customerName?: string }

/* ------------------------------ small helpers ------------------------------ */

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.round(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const CHANNEL_BADGE: Record<string, string> = {
  web: 'bg-secondary text-secondary-foreground',
  voice_test: 'bg-amber-100 text-amber-900',
  sms: 'bg-emerald-100 text-emerald-900',
  whatsapp: 'bg-emerald-50 text-emerald-900 border border-emerald-200',
  phone: 'bg-muted text-muted-foreground border',
}

const STATUS_BADGE: Record<string, string> = {
  open: 'bg-emerald-100 text-emerald-900',
  waiting_human: 'bg-amber-100 text-amber-900',
  closed: 'bg-muted text-muted-foreground border',
}

function statusLabel(s: string): string {
  return s === 'waiting_human' ? 'waiting for staff' : s
}

function parseToolCalls(meta: string): Array<{ tool: string; ok: boolean }> {
  try {
    const m = JSON.parse(meta || '{}') as { toolCalls?: Array<{ tool?: string; ok?: boolean }> }
    return Array.isArray(m.toolCalls) ? m.toolCalls.map((t) => ({ tool: String(t.tool ?? 'tool'), ok: t.ok !== false })) : []
  } catch {
    return []
  }
}

/* --------------------------- voice test (Web Speech) --------------------------- */

type SpeechResultEvent = { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }
type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((e: SpeechResultEvent) => void) | null
  onerror: ((e: { error?: string }) => void) | null
  onend: (() => void) | null
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

type VoiceState = 'idle' | 'listening' | 'processing' | 'speaking'

function VoiceTestPanel({ onSend, disabled }: { onSend: (text: string) => Promise<string | null>; disabled?: boolean }) {
  // computed lazily — this panel only mounts after a user click, so the value is
  // hydration-safe and no setState-in-effect cascade is needed
  const [supported] = useState(() => getSpeechRecognition() !== null)
  const [vState, setVState] = useState<VoiceState>('idle')
  const [interim, setInterim] = useState('')
  const [typed, setTyped] = useState('')
  const [lastError, setLastError] = useState('')
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  const stateRef = useRef<VoiceState>('idle')

  const setVs = (s: VoiceState) => { stateRef.current = s; setVState(s) }

  useEffect(() => {
    return () => {
      try { recRef.current?.abort() } catch { /* ignore */ }
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel()
    }
  }, [])

  const speak = (text: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
    try {
      const synth = window.speechSynthesis
      synth.cancel()
      const u = new SpeechSynthesisUtterance(text)
      u.rate = 1
      const voices = synth.getVoices()
      if (voices.length > 0) u.voice = voices[0] // default browser voice
      u.onend = () => setVs('idle')
      u.onerror = () => setVs('idle')
      setVs('speaking')
      synth.speak(u)
    } catch {
      setVs('idle')
    }
  }

  const stopListening = () => {
    try { recRef.current?.stop() } catch { /* ignore */ }
  }

  const handleTranscript = async (text: string) => {
    setVs('processing')
    setInterim('')
    const reply = await onSend(text)
    if (reply) speak(reply)
    else setVs('idle')
  }

  const toggleMic = () => {
    setLastError('')
    if (stateRef.current === 'listening') {
      stopListening()
      return
    }
    if (stateRef.current === 'speaking' && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel()
    }
    const SR = getSpeechRecognition()
    if (!SR) return
    const rec = new SR()
    recRef.current = rec
    rec.lang = navigator.language || 'en-US'
    rec.continuous = false
    rec.interimResults = true
    rec.onresult = (e: SpeechResultEvent) => {
      let finalText = ''
      let interimText = ''
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i]
        const t = r[0]?.transcript ?? ''
        if (r.isFinal) finalText += t
        else interimText += t
      }
      setInterim(interimText)
      if (finalText.trim()) void handleTranscript(finalText.trim())
    }
    rec.onerror = (e: { error?: string }) => {
      setLastError(e.error === 'not-allowed'
        ? 'Microphone permission was denied — allow mic access and try again.'
        : `Voice input error: ${e.error ?? 'unknown'}`)
      setVs('idle')
      setInterim('')
    }
    rec.onend = () => {
      if (stateRef.current === 'listening') setVs('idle')
      setInterim('')
    }
    setVs('listening')
    try { rec.start() } catch {
      setVs('idle')
      setLastError('Could not start the microphone. Close other tabs using it and retry.')
    }
  }

  return (
    <Card className="border-dashed">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium flex items-center gap-2">
            <Volume2 className="h-4 w-4 text-muted-foreground" aria-hidden />
            Browser test call
          </p>
          <Badge variant="outline" className="text-[11px]">no telephony connected</Badge>
        </div>

        {supported === false && (
          <Alert className="border-amber-200 bg-amber-50 text-amber-900" role="alert">
            <ShieldAlert className="h-4 w-4" aria-hidden />
            <AlertDescription>
              Voice input is not supported in this browser — use Chrome/Edge, or type below.
            </AlertDescription>
          </Alert>
        )}

        {lastError && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{lastError}</AlertDescription>
          </Alert>
        )}

        {supported && (
          <div className="flex flex-col items-center gap-2 py-2">
            <button
              type="button"
              onClick={toggleMic}
              aria-pressed={vState === 'listening'}
              aria-label={vState === 'listening' ? 'Stop listening' : 'Start voice test — speak to the assistant'}
              disabled={disabled || vState === 'processing'}
              className={cn(
                'h-16 w-16 rounded-full flex items-center justify-center border-2 transition-colors min-h-[44px] min-w-[44px]',
                vState === 'listening'
                  ? 'bg-rose-600 text-white border-rose-700 animate-pulse'
                  : 'bg-background text-foreground hover:bg-muted',
              )}
            >
              {vState === 'processing' ? <Loader2 className="h-6 w-6 animate-spin" aria-hidden /> : <Mic className="h-6 w-6" aria-hidden />}
            </button>
            <p className="text-xs text-muted-foreground flex items-center gap-1.5" aria-live="polite">
              {vState === 'listening' && (
                <>
                  <span className="inline-block h-2 w-2 rounded-full bg-rose-600 animate-pulse" aria-hidden />
                  Listening… speak now
                </>
              )}
              {vState === 'processing' && <>Processing your message…</>}
              {vState === 'speaking' && <><Volume2 className="h-3.5 w-3.5" aria-hidden /> Assistant is speaking…</>}
              {vState === 'idle' && 'Tap the mic and speak like a customer would'}
            </p>
            {interim && <p className="text-sm italic text-muted-foreground max-w-md text-center">“{interim}”</p>}
          </div>
        )}

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            const t = typed.trim()
            if (!t) return
            setTyped('')
            void handleTranscript(t)
          }}
        >
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Type instead — simulate a customer voice message…"
            aria-label="Type a test message instead of speaking"
            className="min-h-[44px]"
          />
          <Button type="submit" variant="secondary" disabled={disabled || !typed.trim() || vState === 'processing'} aria-label="Send typed test message">
            <Send className="h-4 w-4" aria-hidden />
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

/* ------------------------------- main section ------------------------------- */

type ConvDetail = {
  conversation: ConversationRow & { customer?: { name: string } | null }
  messages: MessageRow[]
}

export function InboxSection() {
  const { toast } = useToast()
  const [convs, setConvs] = useState<ConvListRow[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ConvDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [composer, setComposer] = useState('')
  const [staffMode, setStaffMode] = useState(false)
  const [sending, setSending] = useState(false)
  const [aiError, setAiError] = useState('')
  const [aiOffNote, setAiOffNote] = useState(false)
  /** Partial assistant reply that arrived over the SSE stream. */
  const [streamedText, setStreamedText] = useState('')
  /** Tool the assistant is calling right now (streamed turns). */
  const [streamedTool, setStreamedTool] = useState('')
  const [newOpen, setNewOpen] = useState(false)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [contactName, setContactName] = useState('')
  const [customerId, setCustomerId] = useState<string>('none')
  const [channel, setChannel] = useState('web')
  const [creating, setCreating] = useState(false)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sendingRef = useRef(false)

  useEffect(() => { sendingRef.current = sending }, [sending])

  const loadList = useCallback(async (silent = false) => {
    if (!silent) setListLoading(true)
    try {
      const d = await api.get<{ conversations: ConversationRow[] }>('/api/conversations')
      setConvs(d.conversations)
      setListError('')
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Could not load conversations')
    } finally {
      setListLoading(false)
    }
  }, [])

  const loadDetail = useCallback(async (id: string, silent = false) => {
    if (!silent) setDetailLoading(true)
    try {
      const d = await api.get<ConvDetail>(`/api/conversations/${id}`)
      setDetail(d)
      setDetailError('')
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : 'Could not load the conversation')
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => { void loadList() }, [loadList])

  // poll the open conversation every 5s
  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    if (!selectedId) return
    void loadDetail(selectedId)
    pollRef.current = setInterval(() => {
      if (!sendingRef.current) void loadDetail(selectedId, true)
    }, 5000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [selectedId, loadDetail])

  // keep the thread pinned to the latest message
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [detail?.messages.length, detail?.conversation.id])

  const openConversation = (id: string) => {
    setSelectedId(id)
    setAiError('')
    setAiOffNote(false)
    setDetail(null)
  }

  const openNewDialog = async () => {
    setContactName('')
    setCustomerId('none')
    setChannel('web')
    setNewOpen(true)
    try {
      const d = await api.get<{ customers: Customer[] }>('/api/customers')
      setCustomers(d.customers)
    } catch { /* optional select — ignore */ }
  }

  const createConversation = async () => {
    setCreating(true)
    try {
      const body: Record<string, string> = { channel }
      if (contactName.trim()) body.contactName = contactName.trim()
      if (customerId !== 'none') body.customerId = customerId
      const d = await api.post<{ conversation: ConversationRow }>('/api/conversations', body)
      setNewOpen(false)
      toast({ title: 'Conversation created', description: 'Say hello as the customer, or let the AI greet them.' })
      await loadList(true)
      setSelectedId(d.conversation.id)
    } catch (err) {
      toast({ title: 'Could not create conversation', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setCreating(false)
    }
  }

  const patchConversation = async (patch: { status?: string; aiEnabled?: boolean }) => {
    if (!selectedId) return
    try {
      await api.patch(`/api/conversations/${selectedId}`, patch)
      await Promise.all([loadDetail(selectedId, true), loadList(true)])
      if (patch.status === 'closed') toast({ title: 'Conversation closed' })
      if (patch.aiEnabled === true) toast({ title: 'AI replies resumed' })
      if (patch.aiEnabled === false && !patch.status) toast({ title: 'AI replies paused', description: 'Staff replies will be used instead.' })
    } catch (err) {
      toast({ title: 'Update failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    }
  }

  /** Send through the SAME endpoint used by the voice test (customer simulator). */
  const sendAsCustomer = async (content: string): Promise<string | null> => {
    if (!selectedId || !detail) return null
    const convId = selectedId
    setSending(true)
    setAiError('')
    setAiOffNote(false)
    const tempId = `temp-${Date.now()}`
    setDetail((d) => d ? {
      ...d,
      messages: [...d.messages, { id: tempId, role: 'customer', content, meta: '', createdAt: new Date().toISOString() }],
    } : d)
    try {
      // Streamed turn: the reply arrives token by token. If the stream cannot be
      // used (proxy without streaming, offline) the request falls back to the
      // regular endpoint so the message is never lost.
      let reply = ''
      let sawDone = false
      const handlers: StreamHandlers = {
        onDelta: (text) => setStreamedText((prev) => prev + text),
        onTool: (info) => {
          setStreamedText('')
          setStreamedTool(info.tool)
        },
        onDone: (event) => {
          sawDone = true
          reply = event.reply || ''
          if (event.error) setAiError(event.error)
          if (!event.aiUsed && !event.error) setAiOffNote(true)
        },
        onError: (message) => setAiError(message),
      }

      try {
        await streamPost('/api/ai/stream', { conversationId: convId, message: content, channel: 'dashboard' }, handlers)
      } catch {
        if (!sawDone) {
          const r = await api.post<{ reply: string; assistantReply?: string; toolCalls?: Array<{ tool: string; ok: boolean }>; aiUsed: boolean; error?: string }>(
            `/api/conversations/${convId}/messages`, { content },
          )
          reply = r.reply || r.assistantReply || ''
          if (r.error) setAiError(r.error)
          if (!r.aiUsed && !r.error) setAiOffNote(true)
        }
      }

      await loadDetail(convId, true)
      void loadList(true)
      return reply || null
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Message could not be delivered')
      await loadDetail(convId, true)
      return null
    } finally {
      setStreamedText('')
      setStreamedTool('')
      setSending(false)
    }
  }

  const sendAsStaff = async () => {
    if (!selectedId || !composer.trim()) return
    setSending(true)
    try {
      await api.post(`/api/conversations/${selectedId}/agent-reply`, { content: composer.trim() })
      setComposer('')
      await loadDetail(selectedId, true)
      void loadList(true)
    } catch (err) {
      toast({ title: 'Reply failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setSending(false)
    }
  }

  const submitComposer = async () => {
    const text = composer.trim()
    if (!text || !selectedId) return
    if (staffMode) { await sendAsStaff(); return }
    setComposer('')
    await sendAsCustomer(text)
  }

  const conv = detail?.conversation
  const messages = detail?.messages ?? []
  const waiting = conv?.status === 'waiting_human'

  return (
    <div className="space-y-4" aria-label="Inbox">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <h2 className="text-lg font-semibold tracking-tight">Inbox</h2>
          <p className="text-sm text-muted-foreground">Your AI receptionist answers here — step in whenever you want.</p>
        </div>
        <Button
          variant={voiceOpen ? 'secondary' : 'outline'}
          onClick={() => setVoiceOpen((v) => !v)}
          aria-pressed={voiceOpen}
          aria-label="Toggle browser voice test"
          className="min-h-[44px]"
        >
          <Mic className="h-4 w-4" aria-hidden />
          Voice test
        </Button>
        <Button onClick={openNewDialog} className="min-h-[44px]" aria-label="Start a new conversation">
          <MessageSquare className="h-4 w-4" aria-hidden />
          New conversation
        </Button>
      </div>

      {voiceOpen && (
        <div className="max-w-2xl">
          <VoiceTestPanel onSend={sendAsCustomer} disabled={!selectedId || sending} />
          {!selectedId && <p className="mt-1 text-xs text-muted-foreground">Select or create a conversation first — the voice test talks through that thread.</p>}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(260px,340px)_1fr]">
        {/* left: conversation list */}
        <Card className={cn('self-start', selectedId ? 'hidden lg:block' : 'block')}>
          <CardContent className="p-3">
            {listLoading ? (
              <div className="space-y-2" aria-label="Loading conversations">
                {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
              </div>
            ) : listError ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription className="space-y-2">
                  <p>{listError}</p>
                  <Button size="sm" variant="outline" onClick={() => void loadList()} className="min-h-[44px]">Retry</Button>
                </AlertDescription>
              </Alert>
            ) : convs.length === 0 ? (
              <div className="py-8 text-center space-y-3">
                <Bot className="h-8 w-8 mx-auto text-muted-foreground" aria-hidden />
                <p className="text-sm text-muted-foreground">No conversations yet. Start one and the AI receptionist will answer as your customers would.</p>
                <Button size="sm" onClick={openNewDialog} className="min-h-[44px]"><Plus className="h-4 w-4" aria-hidden /> New conversation</Button>
              </div>
            ) : (
              <ul className="max-h-96 lg:max-h-[65vh] overflow-y-auto space-y-1" aria-label="Conversation list">
                {convs.map((c) => (
                  <li key={c.id}>
                    <button
                      onClick={() => openConversation(c.id)}
                      aria-current={selectedId === c.id ? 'true' : undefined}
                      className={cn(
                        'w-full text-left rounded-md border p-3 min-h-[44px] transition-colors',
                        selectedId === c.id ? 'border-primary bg-muted/60' : 'border-transparent hover:bg-muted/50',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate flex-1">{c.contactName || c.customerName || c.customer?.name || 'Unknown contact'}</span>
                        <span className="text-[11px] text-muted-foreground shrink-0">{relTime(c.updatedAt)}</span>
                      </div>
                      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                        <Badge className={cn('text-[10px] px-1.5', CHANNEL_BADGE[c.channel] ?? 'bg-muted')}>{c.channel}</Badge>
                        <Badge className={cn('text-[10px] px-1.5', STATUS_BADGE[c.status] ?? 'bg-muted')}>{statusLabel(c.status)}</Badge>
                        {!c.aiEnabled && c.status !== 'closed' && <Badge variant="outline" className="text-[10px] px-1.5">AI off</Badge>}
                      </div>
                      {c.lastMessage && (
                        <p className="text-xs text-muted-foreground mt-1.5 line-clamp-1">
                          {c.lastMessage.role === 'customer' ? 'They: ' : c.lastMessage.role === 'agent' ? 'Staff: ' : 'AI: '}
                          {c.lastMessage.content}
                        </p>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* right: conversation detail */}
        <Card className={cn('self-start', selectedId ? 'block' : 'hidden lg:block')}>
          <CardContent className="p-0">
            {!selectedId ? (
              <div className="p-8 text-center space-y-2">
                <UserRound className="h-8 w-8 mx-auto text-muted-foreground" aria-hidden />
                <p className="text-sm text-muted-foreground">Select a conversation on the left, or start a new one.</p>
              </div>
            ) : detailLoading && !detail ? (
              <div className="p-4 space-y-3" aria-label="Loading conversation">
                {[0, 1, 2, 3].map((i) => <Skeleton key={i} className={cn('h-12 w-2/3', i % 2 ? 'ml-auto' : '')} />)}
              </div>
            ) : detailError ? (
              <div className="p-4">
                <Alert variant="destructive" role="alert">
                  <AlertDescription className="space-y-2">
                    <p>{detailError}</p>
                    <Button size="sm" variant="outline" onClick={() => selectedId && void loadDetail(selectedId)} className="min-h-[44px]">Retry</Button>
                  </AlertDescription>
                </Alert>
              </div>
            ) : conv ? (
              <div className="flex flex-col">
                {/* header */}
                <div className="flex items-center gap-2 p-3 border-b">
                  <Button variant="ghost" size="icon" className="lg:hidden min-h-[44px] min-w-[44px]" onClick={() => setSelectedId(null)} aria-label="Back to conversation list">
                    <ArrowLeft className="h-5 w-5" aria-hidden />
                  </Button>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{conv.contactName || conv.customer?.name || 'Unknown contact'}</p>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Badge className={cn('text-[10px] px-1.5', CHANNEL_BADGE[conv.channel] ?? 'bg-muted')}>{conv.channel}</Badge>
                      <Badge className={cn('text-[10px] px-1.5', STATUS_BADGE[conv.status] ?? 'bg-muted')}>{statusLabel(conv.status)}</Badge>
                    </div>
                  </div>
                </div>

                {/* takeover controls */}
                <div className="flex flex-wrap items-center gap-3 p-3 border-b bg-muted/30">
                  <label className="flex items-center gap-2 text-sm">
                    <Switch
                      checked={conv.aiEnabled}
                      onCheckedChange={(v) => void patchConversation({ aiEnabled: v })}
                      disabled={conv.status === 'closed'}
                      aria-label="AI replies enabled"
                    />
                    AI replies enabled
                  </label>
                  <div className="flex gap-2 ml-auto flex-wrap">
                    <Button
                      size="sm" variant="outline"
                      disabled={conv.status === 'closed'}
                      onClick={() => void patchConversation({ status: 'open', aiEnabled: false })}
                      className="min-h-[44px]"
                      aria-label="Take over from the AI and reply as staff"
                    >
                      <UserRound className="h-4 w-4" aria-hidden /> Take over
                    </Button>
                    <Button
                      size="sm" variant="outline"
                      disabled={conv.status === 'closed' || conv.aiEnabled}
                      onClick={() => void patchConversation({ status: 'open', aiEnabled: true })}
                      className="min-h-[44px]"
                      aria-label="Resume AI replies"
                    >
                      <Sparkles className="h-4 w-4" aria-hidden /> Resume AI
                    </Button>
                    <Button
                      size="sm" variant="ghost"
                      disabled={conv.status === 'closed'}
                      onClick={() => void patchConversation({ status: 'closed' })}
                      className="min-h-[44px] text-muted-foreground"
                      aria-label="Close this conversation"
                    >
                      <XCircle className="h-4 w-4" aria-hidden /> Close
                    </Button>
                  </div>
                </div>

                {waiting && (
                  <Alert className="m-3 border-amber-200 bg-amber-50 text-amber-900" role="alert">
                    <CircleAlert className="h-4 w-4" aria-hidden />
                    <AlertDescription>
                      The AI handed this conversation to staff. Reply below as staff — the customer is waiting.
                    </AlertDescription>
                  </Alert>
                )}

                {aiError && (
                  <Alert className="m-3 border-amber-200 bg-amber-50 text-amber-900" role="alert">
                    <ShieldAlert className="h-4 w-4" aria-hidden />
                    <AlertDescription>AI unavailable — message saved, staff can reply. ({aiError})</AlertDescription>
                  </Alert>
                )}
                {aiOffNote && !aiError && (
                  <p className="px-3 pt-2 text-xs text-muted-foreground">AI was not used for that reply (AI replies are paused for this conversation).</p>
                )}

                {/* messages */}
                <div ref={scrollRef} className="p-3 space-y-3 max-h-96 overflow-y-auto" aria-label="Message thread" aria-live="polite">
                  {messages.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-6">No messages yet — simulate the customer or let the AI speak first.</p>
                  )}
                  {messages.map((m) => {
                    if (m.role === 'system') {
                      return (
                        <p key={m.id} className="text-center text-xs italic text-muted-foreground">{m.content}</p>
                      )
                    }
                    if (m.role === 'customer') {
                      return (
                        <div key={m.id} className="flex justify-start">
                          <div className="max-w-[85%] sm:max-w-[70%] rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words">{m.content}</div>
                        </div>
                      )
                    }
                    if (m.role === 'agent') {
                      return (
                        <div key={m.id} className="flex justify-end">
                          <div className="max-w-[85%] sm:max-w-[70%]">
                            <p className="text-[10px] text-muted-foreground text-right mb-0.5">📝 Staff</p>
                            <div className="rounded-2xl rounded-br-sm bg-secondary text-secondary-foreground px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words">{m.content}</div>
                          </div>
                        </div>
                      )
                    }
                    const tools = parseToolCalls(m.meta)
                    return (
                      <div key={m.id} className="flex justify-end">
                        <div className="max-w-[85%] sm:max-w-[70%]">
                          <p className="text-[10px] text-muted-foreground text-right mb-0.5 flex items-center justify-end gap-1">
                            <Bot className="h-3 w-3" aria-hidden /> AI receptionist
                          </p>
                          <div className="rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words">{m.content}</div>
                          {tools.length > 0 && (
                            <div className="flex flex-wrap gap-1 justify-end mt-1" aria-label="Tool calls used for this reply">
                              {tools.map((t, i) => (
                                <Badge key={i} variant="outline" className="text-[10px] px-1.5 py-0 gap-1 text-muted-foreground">
                                  {t.ok ? <CheckCircle2 className="h-3 w-3 text-emerald-600" aria-hidden /> : <XCircle className="h-3 w-3 text-rose-600" aria-hidden />}
                                  <Wrench className="h-2.5 w-2.5" aria-hidden />
                                  {t.tool}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                  {(streamedText || streamedTool) && (
                    <div className="flex justify-end">
                      <div className="max-w-[85%] sm:max-w-[70%]">
                        <p className="text-[10px] text-muted-foreground text-right mb-0.5 flex items-center justify-end gap-1">
                          <Bot className="h-3 w-3" aria-hidden /> AI receptionist
                        </p>
                        <div className="rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words">
                          {streamedText || (
                            <span className="inline-flex items-center gap-2">
                              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                              {streamedTool ? `Calling ${streamedTool}…` : 'Assistant is thinking…'}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                  {sending && !staffMode && !streamedText && !streamedTool && (
                    <div className="flex justify-end">
                      <div className="rounded-2xl bg-primary/70 text-primary-foreground px-3.5 py-2.5 text-sm flex items-center gap-2">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        Assistant is thinking…
                      </div>
                    </div>
                  )}
                </div>

                {/* composer */}
                <div className="border-t p-3 space-y-2">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <button
                      type="button"
                      onClick={() => setStaffMode(false)}
                      aria-pressed={!staffMode}
                      className={cn('rounded-md border px-2 py-1.5 min-h-[44px] text-xs', !staffMode ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted')}
                    >
                      Simulating customer
                    </button>
                    <button
                      type="button"
                      onClick={() => setStaffMode(true)}
                      aria-pressed={staffMode}
                      className={cn('rounded-md border px-2 py-1.5 min-h-[44px] text-xs', staffMode ? 'bg-secondary text-secondary-foreground border-border' : 'hover:bg-muted')}
                    >
                      📝 Reply as staff
                    </button>
                    <span className="ml-auto hidden sm:block">
                      {staffMode ? 'Your reply is sent as a human staff member.' : 'You are simulating the customer — the AI will answer.'}
                    </span>
                  </div>
                  <form
                    className="flex items-end gap-2"
                    onSubmit={(e) => { e.preventDefault(); void submitComposer() }}
                  >
                    <Textarea
                      value={composer}
                      onChange={(e) => setComposer(e.target.value)}
                      rows={2}
                      placeholder={staffMode ? 'Type your staff reply…' : 'Type what the customer says…'}
                      aria-label={staffMode ? 'Staff reply' : 'Customer message'}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submitComposer() }
                      }}
                    />
                    <Button
                      type="submit"
                      disabled={sending || !composer.trim() || (!staffMode && conv.status === 'closed')}
                      aria-label={staffMode ? 'Send staff reply' : 'Send customer message'}
                      className="min-h-[44px]"
                    >
                      {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
                      Send
                    </Button>
                  </form>
                  {!staffMode && conv.status === 'closed' && (
                    <p className="text-xs text-muted-foreground">This conversation is closed — reopen it with “Resume AI” or “Take over” to continue.</p>
                  )}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {/* new conversation dialog */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New conversation</DialogTitle>
            <DialogDescription>
              Start a thread. Optionally link an existing customer so the AI knows who it is talking to.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="contactName">Contact name (optional)</Label>
              <Input id="contactName" value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="e.g. Jamie Rivera" className="min-h-[44px]" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="custSelect">Existing customer (optional)</Label>
              <Select value={customerId} onValueChange={setCustomerId}>
                <SelectTrigger id="custSelect" className="min-h-[44px]" aria-label="Link an existing customer">
                  <SelectValue placeholder="No linked customer" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No linked customer</SelectItem>
                  {customers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="channelSelect">Channel</Label>
              <Select value={channel} onValueChange={setChannel}>
                <SelectTrigger id="channelSelect" className="min-h-[44px]" aria-label="Conversation channel">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="web">Web chat</SelectItem>
                  <SelectItem value="voice_test">Voice test (browser)</SelectItem>
                  <SelectItem value="phone">Phone</SelectItem>
                  <SelectItem value="sms">SMS</SelectItem>
                  <SelectItem value="whatsapp">WhatsApp</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Inbound SMS, WhatsApp and phone calls create their own threads automatically. Manual channels are labels for staff-created test threads.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOpen(false)} className="min-h-[44px]">Cancel</Button>
            <Button onClick={() => void createConversation()} disabled={creating} className="min-h-[44px]">
              {creating && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Create conversation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
