'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type MessageRow, type ProviderConfigPublic } from '@/lib/client/api'
import { useAppStore } from '@/lib/client/store'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import {
  Mic, Square, Phone, RotateCcw, Volume2, Loader2, Wrench,
  ArrowUpRight, AudioLines, Keyboard, CircleStop,
} from 'lucide-react'

type TurnStatus = 'idle' | 'recording' | 'transcribing' | 'thinking' | 'speaking'

const VOICES = ['tongtong', 'chuichui', 'xiaochen', 'jam', 'kazi', 'douji', 'luodo']

/* ---- minimal Web Speech API types (browser fallback path) ---- */

type Alternative = { transcript: string }
type RecogResult = { isFinal: boolean; length: number; [i: number]: Alternative }
type RecogResultList = { length: number; [i: number]: RecogResult }
type SpeechRecognitionLike = {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((e: { resultIndex: number; results: RecogResultList }) => void) | null
  onerror: ((e: { error?: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike
    webkitSpeechRecognition?: new () => SpeechRecognitionLike
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

type ToolChip = { tool: string; ok: boolean }

function parseMeta(meta: string): { toolCalls?: ToolChip[]; aiError?: string } {
  try {
    const parsed = JSON.parse(meta || '{}')
    return { toolCalls: Array.isArray(parsed.toolCalls) ? parsed.toolCalls : undefined, aiError: parsed.aiError }
  } catch {
    return {}
  }
}

function h(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`
}

/**
 * Convert a browser recording to 16 kHz mono PCM WAV.
 * Returns the original blob when the browser cannot decode it (the server
 * then falls back to ffmpeg or reports the real reason).
 */
async function toWav16kMono(blob: Blob): Promise<Blob> {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return blob
    const arrayBuffer = await blob.arrayBuffer()
    const ctx = new Ctx()
    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0))
    void ctx.close()
    const targetRate = 16000
    const frames = Math.max(1, Math.ceil(decoded.duration * targetRate))
    const offline = new OfflineAudioContext(1, frames, targetRate)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const rendered = await offline.startRendering()
    const samples = rendered.getChannelData(0)
    const bytes = new ArrayBuffer(44 + samples.length * 2)
    const view = new DataView(bytes)
    const ascii = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
    }
    ascii(0, 'RIFF')
    view.setUint32(4, 36 + samples.length * 2, true)
    ascii(8, 'WAVE')
    ascii(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, targetRate, true)
    view.setUint32(28, targetRate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    ascii(36, 'data')
    view.setUint32(40, samples.length * 2, true)
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]))
      view.setInt16(44 + i * 2, Math.round(s * 32767), true)
    }
    return new Blob([bytes], { type: 'audio/wav' })
  } catch {
    return blob
  }
}

export function VoiceSection() {
  const { toast } = useToast()
  const setActiveSection = useAppStore((s) => s.setActiveSection)
  const [providers, setProviders] = useState<ProviderConfigPublic[]>([])
  const [providersLoading, setProvidersLoading] = useState(true)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageRow[]>([])
  const [status, setStatus] = useState<TurnStatus>('idle')
  const [level, setLevel] = useState(0)
  const [latencies, setLatencies] = useState<{ stt?: number; ai?: number; tts?: number }>({})
  const [voice, setVoice] = useState('')
  const [speed, setSpeed] = useState(1)
  const [textInput, setTextInput] = useState('')
  const [micError, setMicError] = useState('')
  const [replayingId, setReplayingId] = useState<string | null>(null)
  const [browserVoices, setBrowserVoices] = useState<Array<{ name: string; lang: string }>>([])

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const audioQueueRef = useRef<HTMLAudioElement[]>([])
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const transcriptEndRef = useRef<HTMLDivElement | null>(null)

  const stt = providers.find((p) => p.capability === 'stt')
  const tts = providers.find((p) => p.capability === 'tts')
  // 'browser' (the out-of-the-box default) means Web Speech in this device's browser.
  const sttIsBrowser = !stt?.enabled || stt.provider === 'browser' || stt.provider === 'none'
  const ttsIsBrowser = !tts?.enabled || tts.provider === 'browser' || tts.provider === 'none'
  const busy = status === 'transcribing' || status === 'thinking' || status === 'speaking'

  const stopAudio = useCallback(() => {
    for (const a of audioQueueRef.current) {
      a.pause()
      a.src = ''
    }
    audioQueueRef.current = []
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel()
    setReplayingId(null)
  }, [])

  /* ---------- stable helpers (declared before the effects that use them) ---------- */

  const loadConversation = useCallback(async (id: string) => {
    try {
      const detail = await api.get<{ conversation: { id: string }; messages: MessageRow[] }>(`/api/conversations/${id}`)
      setConversationId(detail.conversation.id)
      setMessages(detail.messages ?? [])
    } catch {
      /* ignore — new session will be created on demand */
    }
  }, [])

  /** Stop any in-flight recording (mic stream, speech recognition, level meter, AudioContext). */
  const cleanupRecording = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') void audioCtxRef.current.close()
    audioCtxRef.current = null
    mediaRecorderRef.current = null
    try { recognitionRef.current?.abort() } catch { /* already stopped */ }
    recognitionRef.current = null
    setLevel(0)
  }, [])

  /* ---------- provider + conversation bootstrap ---------- */
  useEffect(() => {
    let cancelled = false
    api.get<{ capabilities: Record<string, ProviderConfigPublic> }>('/api/providers')
      .then((r) => { if (!cancelled) setProviders(Object.values(r.capabilities ?? {})) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setProvidersLoading(false) })

    // resume the most recent voice session, or open a fresh one lazily on first use
    api.get<{ conversations: Array<{ id: string; channel: string }> }>('/api/conversations')
      .then((r) => {
        const last = (r.conversations ?? []).find((c) => c.channel === 'voice_test')
        if (last && !cancelled) void loadConversation(last.id)
      })
      .catch(() => {})

    const savedVoice = typeof window !== 'undefined' ? window.localStorage.getItem('ais_voice') : null
    const savedSpeed = typeof window !== 'undefined' ? window.localStorage.getItem('ais_voice_speed') : null
    if (savedVoice) setVoice(savedVoice)
    if (savedSpeed) setSpeed(Number(savedSpeed) || 1)
    return () => { cancelled = true; cleanupRecording() }
  }, [loadConversation, cleanupRecording])

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, status])

  useEffect(() => {
    window.localStorage.setItem('ais_voice', voice)
    window.localStorage.setItem('ais_voice_speed', String(speed))
  }, [voice, speed])

  // Browser TTS voices (populated asynchronously by some browsers).
  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return
    const load = () => setBrowserVoices(window.speechSynthesis.getVoices().map((v) => ({ name: v.name, lang: v.lang })))
    load()
    window.speechSynthesis.addEventListener('voiceschanged', load)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load)
  }, [])

  const ensureConversation = async (): Promise<string | null> => {
    if (conversationId) return conversationId
    try {
      const r = await api.post<{ conversation: { id: string } }>('/api/conversations', { channel: 'voice_test', contactName: 'Voice caller' })
      setConversationId(r.conversation.id)
      setMessages([])
      return r.conversation.id
    } catch (err) {
      toast({ title: 'Could not open a voice session', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
      return null
    }
  }

  const newSession = async () => {
    stopAudio()
    try {
      const r = await api.post<{ conversation: { id: string } }>('/api/conversations', { channel: 'voice_test', contactName: 'Voice caller' })
      setConversationId(r.conversation.id)
      setMessages([])
      setLatencies({})
      toast({ title: 'New voice session started' })
    } catch (err) {
      toast({ title: 'Could not start a new session', description: err instanceof Error ? err.message : '', variant: 'destructive' })
    }
  }

  /* ---------- audio plumbing ---------- */

  const playAudioChunks = (chunks: Array<{ mime: string; b64: string }>, onDone?: () => void) => {
    stopAudio()
    const playAt = (i: number) => {
      if (i >= chunks.length) {
        setStatus('idle')
        setReplayingId(null)
        onDone?.()
        return
      }
      const el = new Audio(`data:${chunks[i].mime};base64,${chunks[i].b64}`)
      audioQueueRef.current.push(el)
      el.onended = () => playAt(i + 1)
      el.onerror = () => { setStatus('idle'); toast({ title: 'Audio playback failed', variant: 'destructive' }) }
      void el.play().catch(() => setStatus('idle'))
    }
    playAt(0)
  }

  const speak = async (text: string) => {
    if (!text.trim()) return
    if (ttsIsBrowser) {
      const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined
      if (!synth) {
        toast({ title: 'This browser has no speech synthesis', description: 'Configure a server TTS provider under AI Providers.', variant: 'destructive' })
        return
      }
      const t0 = performance.now()
      synth.cancel()
      const u = new SpeechSynthesisUtterance(text)
      u.rate = speed
      const chosen = voice ? synth.getVoices().find((v) => v.name === voice) : undefined
      if (chosen) u.voice = chosen
      setStatus('speaking')
      u.onend = () => { setStatus('idle'); setLatencies((l) => ({ ...l, tts: Math.round(performance.now() - t0) })) }
      u.onerror = () => setStatus('idle')
      synth.speak(u)
      return
    }
    try {
      setStatus('speaking')
      const t0 = performance.now()
      const r = await api.post<{ audio: Array<{ mime: string; b64: string }>; latencyMs: number }>('/api/ai/tts', { text, voice: voice || undefined, speed })
      setLatencies((l) => ({ ...l, tts: r.latencyMs || Math.round(performance.now() - t0) }))
      playAudioChunks(r.audio)
    } catch (err) {
      setStatus('idle')
      toast({ title: 'Speech synthesis failed', description: err instanceof Error ? err.message : '', variant: 'destructive' })
    }
  }

  /* ---------- the turn: STT → receptionist → TTS ---------- */
  const runTurn = async (text: string) => {
    const convId = await ensureConversation()
    if (!convId) return
    try {
      setStatus('thinking')
      const t0 = performance.now()
      const r = await api.post<{ reply: string; aiUsed: boolean; error?: string; latencyMs?: number }>(`/api/conversations/${convId}/messages`, { content: text })
      const detail = await api.get<{ messages: MessageRow[] }>(`/api/conversations/${convId}`)
      setMessages(detail.messages ?? [])
      setLatencies((l) => ({ ...l, ai: r.latencyMs || Math.round(performance.now() - t0) }))
      if (r.reply) await speak(r.reply)
      else setStatus('idle')
    } catch (err) {
      setStatus('idle')
      toast({ title: 'The assistant could not reply', description: err instanceof Error ? err.message : '', variant: 'destructive' })
    }
  }

  const transcribeAndReply = async (blob: Blob) => {
    const convId = await ensureConversation()
    if (!convId) return
    try {
      setStatus('transcribing')
      // Local Whisper models expect 16 kHz mono PCM. Convert in the browser so
      // the server does not need ffmpeg for the common case.
      const payload = stt?.provider === 'local_speech' ? await toWav16kMono(blob) : blob
      const buf = new Uint8Array(await payload.arrayBuffer())
      let binary = ''
      const CHUNK = 0x8000
      for (let i = 0; i < buf.length; i += CHUNK) binary += String.fromCharCode(...buf.subarray(i, i + CHUNK))
      const b64 = btoa(binary)
      const t0 = performance.now()
      const r = await api.post<{ text: string; latencyMs: number }>('/api/ai/asr', { b64, mime: payload.type || 'audio/wav' })
      setLatencies((l) => ({ ...l, stt: r.latencyMs || Math.round(performance.now() - t0) }))
      if (!r.text.trim()) {
        toast({ title: 'Nothing audible was captured', description: 'Try speaking a bit closer to the microphone.' })
        setStatus('idle')
        return
      }
      await runTurn(r.text)
    } catch (err) {
      setStatus('idle')
      toast({ title: 'Speech-to-text failed', description: err instanceof Error ? err.message : '', variant: 'destructive' })
    }
  }

  const startRecording = async () => {
    if (busy) { stopAudio(); if (status === 'speaking') setStatus('idle') }
    setMicError('')

    // Out-of-the-box browser path: Web Speech recognition, no server round-trip.
    const Ctor = getSpeechRecognitionCtor()
    if (sttIsBrowser && Ctor) {
      try {
        const rec = new Ctor()
        rec.lang = 'en-US'
        rec.interimResults = false
        rec.continuous = false
        let gotResult = false
        rec.onresult = (e) => {
          let final = ''
          for (let i = e.resultIndex; i < e.results.length; i++) {
            if (e.results[i].isFinal) final += e.results[i][0].transcript
          }
          if (final.trim()) {
            gotResult = true
            cleanupRecording()
            void runTurn(final.trim())
          }
        }
        rec.onerror = (e) => {
          if (e.error === 'no-speech') setMicError('No speech detected — try again.')
          else if (e.error === 'not-allowed') setMicError('Microphone permission was denied. Enable it in your browser settings.')
          else setMicError(`Speech recognition failed: ${e.error ?? 'unknown error'}`)
        }
        rec.onend = () => { if (!gotResult) setStatus('idle') }
        recognitionRef.current = rec
        rec.start()
        setStatus('recording')
        return
      } catch (err) {
        setMicError(`Browser speech recognition unavailable: ${err instanceof Error ? err.message : 'unknown error'}`)
        return
      }
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : ''
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        cleanupRecording()
        if (blob.size > 800) void transcribeAndReply(blob)
        else setStatus('idle')
      }
      mediaRecorderRef.current = recorder
      recorder.start()

      // live level meter
      const ctx = new AudioContext()
      audioCtxRef.current = ctx
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      ctx.createMediaStreamSource(stream).connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      const tick = () => {
        analyser.getByteFrequencyData(data)
        const avg = data.reduce((a, b) => a + b, 0) / data.length
        setLevel(Math.min(100, Math.round((avg / 140) * 100)))
        rafRef.current = requestAnimationFrame(tick)
      }
      tick()
      setStatus('recording')
    } catch (err) {
      cleanupRecording()
      setMicError(
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Microphone permission was denied. Enable it in your browser settings to use voice.'
          : `Microphone unavailable: ${err instanceof Error ? err.message : 'unknown error'}`
      )
    }
  }

  const stopRecording = () => {
    if (recognitionRef.current) {
      try { recognitionRef.current.stop() } catch { cleanupRecording(); setStatus('idle') }
      return
    }
    if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop()
  }

  const toggleMic = () => {
    if (status === 'recording') stopRecording()
    else if (!busy) void startRecording()
    else if (status === 'speaking') { stopAudio(); setStatus('idle') }
  }

  const submitText = (e: React.FormEvent) => {
    e.preventDefault()
    const text = textInput.trim()
    if (!text || busy) return
    setTextInput('')
    void runTurn(text)
  }

  const statusLabel: Record<TurnStatus, string> = {
    idle: 'Ready — press the microphone and speak',
    recording: 'Listening… press again to send',
    transcribing: 'Transcribing your speech…',
    thinking: 'The receptionist is thinking…',
    speaking: 'Speaking — press the microphone to interrupt',
  }

  return (
    <div className="space-y-4 pb-6">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            <AudioLines className="h-5 w-5 text-primary" aria-hidden />
            Voice Console
          </h1>
          <p className="text-sm text-muted-foreground">
            Talk to your AI receptionist out loud — real speech recognition, real model, real spoken replies.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={newSession}>
            <Phone className="h-4 w-4 mr-1.5" aria-hidden /> New session
          </Button>
        </div>
      </div>

      {/* provider status */}
      <div className="flex flex-wrap gap-2">
        {providersLoading ? (
          <>
            <Skeleton className="h-6 w-44" />
            <Skeleton className="h-6 w-44" />
          </>
        ) : (
          <>
            <ProviderChip label="Speech-to-text" provider={stt} onConfigure={() => setActiveSection('ai')} />
            <ProviderChip label="Text-to-speech" provider={tts} onConfigure={() => setActiveSection('ai')} />
            <Badge variant="outline" className="gap-1.5">
              <Volume2 className="h-3.5 w-3.5" aria-hidden /> {voice || 'default voice'} · {speed.toFixed(1)}×
            </Badge>
            {latencies.stt != null && <Badge variant="secondary">STT {h(latencies.stt)}</Badge>}
            {latencies.ai != null && <Badge variant="secondary">AI {h(latencies.ai)}</Badge>}
            {latencies.tts != null && <Badge variant="secondary">TTS {h(latencies.tts)}</Badge>}
          </>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        {/* transcript + controls */}
        <Card className="flex flex-col">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Live conversation</CardTitle>
            <CardDescription aria-live="polite">{statusLabel[status]}</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col gap-3">
            <div className="flex-1 rounded-lg border bg-muted/20 p-3 overflow-y-auto max-h-[46vh] min-h-[240px]" role="log" aria-label="Conversation transcript">
              {messages.length === 0 && status === 'idle' ? (
                <div className="h-full min-h-[200px] flex flex-col items-center justify-center text-center gap-2 text-muted-foreground">
                  <Mic className="h-8 w-8 opacity-40" aria-hidden />
                  <p className="text-sm">No turns yet in this session.</p>
                  <p className="text-xs">Try: &ldquo;What are your prices for a haircut?&rdquo; or &ldquo;Can I book tomorrow at 2pm?&rdquo;</p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {messages.map((m) => {
                    const meta = parseMeta(m.meta)
                    const isCustomer = m.role === 'customer'
                    const isAssistant = m.role === 'assistant'
                    return (
                      <li key={m.id} className={cn('flex', isCustomer ? 'justify-end' : 'justify-start')}>
                        <div className={cn(
                          'max-w-[85%] rounded-lg px-3 py-2 text-sm',
                          isCustomer ? 'bg-primary text-primary-foreground' : isAssistant ? 'bg-card border' : 'bg-muted text-muted-foreground'
                        )}>
                          <p className="whitespace-pre-wrap">{m.content}</p>
                          {meta.toolCalls && meta.toolCalls.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {meta.toolCalls.map((tc, i) => (
                                <Badge key={i} variant="outline" className={cn('gap-1 text-[10px] px-1.5 py-0', isCustomer && 'border-primary-foreground/30')}>
                                  <Wrench className="h-2.5 w-2.5" aria-hidden />
                                  {tc.tool}{tc.ok ? '' : ' (failed)'}
                                </Badge>
                              ))}
                            </div>
                          )}
                          {isAssistant && (
                            <div className="mt-1.5">
                              <Button
                                variant="ghost" size="sm"
                                className="h-6 px-1.5 text-xs text-muted-foreground"
                                disabled={status === 'speaking'}
                                onClick={() => { setReplayingId(m.id); void speak(m.content) }}
                              >
                                {replayingId === m.id ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" aria-hidden /> speaking…</> : <><Volume2 className="h-3 w-3 mr-1" aria-hidden /> replay</>}
                              </Button>
                            </div>
                          )}
                        </div>
                      </li>
                    )
                  })}
                  {status === 'thinking' && (
                    <li className="flex justify-start">
                      <div className="bg-card border rounded-lg px-3 py-2 text-sm text-muted-foreground flex items-center gap-2">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> thinking…
                      </div>
                    </li>
                  )}
                  {status === 'transcribing' && (
                    <li className="flex justify-end">
                      <div className="bg-primary/20 text-primary-foreground rounded-lg px-3 py-2 text-sm flex items-center gap-2">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> transcribing…
                      </div>
                    </li>
                  )}
                </ul>
              )}
              <div ref={transcriptEndRef} />
            </div>

            {/* mic + level */}
            <div className="flex items-center gap-4 rounded-lg border p-3">
              <button
                onClick={toggleMic}
                disabled={status === 'transcribing' || status === 'thinking'}
                aria-label={status === 'recording' ? 'Stop recording and send' : busy ? 'Interrupt playback' : 'Start recording'} title={status === 'recording' ? 'Stop recording and send' : busy ? 'Interrupt playback' : 'Start recording'}
                className={cn(
                  'relative h-14 w-14 rounded-full flex items-center justify-center text-primary-foreground transition-[transform,background-color] shrink-0',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  status === 'recording' ? 'bg-red-600 hover:bg-red-700' : 'bg-primary hover:bg-primary/90'
                )}
              >
                {status === 'recording' && <span className="absolute inset-0 rounded-full bg-red-500/60 animate-ping" aria-hidden />}
                {status === 'recording' ? <Square className="h-5 w-5" aria-hidden /> : busy ? <CircleStop className="h-5 w-5" aria-hidden /> : <Mic className="h-5 w-5" aria-hidden />}
              </button>
              <div className="flex-1 min-w-0">
                <div className="h-2 rounded-full bg-muted overflow-hidden" role="img" aria-label={`Microphone level ${level}%`}>
                  <div className={cn('h-full rounded-full transition-[width] duration-75', status === 'recording' ? 'bg-red-500' : 'bg-muted-foreground/30')} style={{ width: `${status === 'recording' ? level : 0}%` }} />
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground truncate">
                  {micError || (status === 'recording' ? 'Speak clearly, then press the red button to send.' : 'Press the mic and speak naturally.')}
                </p>
              </div>
            </div>

            {/* transcribe an existing audio file (server STT providers) */}
            {!sttIsBrowser && (
              <div className="space-y-1.5 rounded-lg border p-3">
                <label htmlFor="voice-audio-file" className="text-xs font-medium text-muted-foreground">Transcribe an audio file</label>
                <Input
                  id="voice-audio-file"
                  type="file"
                  accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm,.flac"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    e.currentTarget.value = ''
                    if (file) void transcribeAndReply(file)
                  }}
                  className="min-h-[44px]"
                />
                <p className="text-xs text-muted-foreground">Uses your configured speech-to-text provider. Keep clips under ~90 seconds (12 MB).</p>
              </div>
            )}

            {/* text fallback */}
            <form onSubmit={submitText} className="flex gap-2" aria-label="Type to the receptionist instead of speaking">
              <Input
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                placeholder={busy ? 'Wait for the current turn to finish…' : '…or type here — same assistant, same tools'}
                disabled={busy}
                aria-label="Type a message to the receptionist"
              />
              <Button type="submit" variant="secondary" disabled={busy || !textInput.trim()}>
                <Keyboard className="h-4 w-4 mr-1" aria-hidden /> Send
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* side panel */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Voice settings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1.5">Assistant voice</p>
                {ttsIsBrowser ? (
                  <Select value={voice || '__default'} onValueChange={(v) => setVoice(v === '__default' ? '' : v)}>
                    <SelectTrigger aria-label="Assistant voice"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default">Browser default</SelectItem>
                      {browserVoices.map((v) => <SelectItem key={v.name} value={v.name}>{v.name} ({v.lang})</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <Select value={voice || '__default'} onValueChange={(v) => setVoice(v === '__default' ? '' : v)}>
                    <SelectTrigger aria-label="Assistant voice"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default">Provider default</SelectItem>
                      {VOICES.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1.5">Speaking speed — {speed.toFixed(1)}×</p>
                <Slider value={[speed]} min={0.5} max={2} step={0.1} onValueChange={([v]) => setSpeed(v)} aria-label="Speaking speed" />
              </div>
              <p className="text-[11px] text-muted-foreground">
                With no speech provider configured, recording and playback run in this browser (Web Speech) — nothing leaves the device.
                Server providers (including self-hosted Kokoro-FastAPI / faster-whisper on this machine) are used automatically when configured.
                In strict local-only mode, external cloud speech services are blocked; the phone channel (Twilio) keeps its own built-in speech.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Real phone line</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>
                This console uses your browser microphone. The same receptionist can answer a
                <strong className="text-foreground"> real phone number </strong>
                through the Twilio Voice integration.
              </p>
              <Button variant="outline" size="sm" className="w-full" onClick={() => setActiveSection('integrations')}>
                <Phone className="h-4 w-4 mr-1.5" aria-hidden /> Set up phone + SMS
                <ArrowUpRight className="h-3.5 w-3.5 ml-auto" aria-hidden />
              </Button>
              <Button variant="ghost" size="sm" className="w-full" onClick={() => setActiveSection('inbox')}>
                <RotateCcw className="h-4 w-4 mr-1.5" aria-hidden /> View sessions in Inbox
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function ProviderChip({ label, provider, onConfigure }: { label: string; provider?: ProviderConfigPublic; onConfigure: () => void }) {
  const ok = Boolean(provider?.enabled && provider.provider !== 'none')
  const shown = provider?.provider === 'browser' ? 'browser (this device)' : (provider?.provider ?? '').replace('_', ' ')
  return (
    <button
      onClick={onConfigure}
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors hover:bg-muted"
      title="Configure in AI Providers"
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', ok ? 'bg-emerald-500' : 'bg-amber-500')} aria-hidden />
      {label}: {ok ? shown : 'not configured'}
    </button>
  )
}
