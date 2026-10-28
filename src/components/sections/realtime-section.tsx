'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/client/api'
import { useToast } from '@/hooks/use-toast'
import { useAppStore } from '@/lib/client/store'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Mic, Square, Loader2, Wifi, WifiOff, Volume2 } from 'lucide-react'

export default function RealtimeSection() {
  const { toast } = useToast()
  const setActiveSection = useAppStore((s) => s.setActiveSection)
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle')
  const [log, setLog] = useState<Array<{ who: 'system' | 'user' | 'assistant' | 'tool'; text: string }>>([])
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const conversationIdRef = useRef<string | null>(null)

  const append = useCallback((who: 'system' | 'user' | 'assistant' | 'tool', text: string) => {
    setLog((prev) => [...prev, { who, text }])
  }, [])

  // Realtime transcripts are persisted to the conversation (best-effort) so voice
  // calls show up in the Inbox like any other channel.
  const pendingRef = useRef<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  const flushTranscript = useCallback(async () => {
    const cid = conversationIdRef.current
    const items = pendingRef.current
    if (!cid || items.length === 0) return
    pendingRef.current = []
    try {
      await api.post(`/api/conversations/${cid}/transcript`, { messages: items })
    } catch (err) {
      console.error('[realtime] transcript persist failed:', err instanceof Error ? err.message : err)
    }
  }, [])
  const record = useCallback(
    (who: 'user' | 'assistant', text: string) => {
      append(who, text)
      pendingRef.current.push({ role: who, content: text })
    },
    [append]
  )

  useEffect(() => {
    const timer = setInterval(() => void flushTranscript(), 5000)
    return () => {
      clearInterval(timer)
      void flushTranscript()
    }
  }, [flushTranscript])

  const teardown = useCallback(() => {
    dcRef.current?.close()
    pcRef.current?.close()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    dcRef.current = null
    pcRef.current = null
    streamRef.current = null
    setStatus('idle')
  }, [])

  useEffect(() => () => teardown(), [teardown])

  const start = useCallback(async () => {
    if (status === 'connecting' || status === 'connected') return
    setStatus('connecting')
    setLog([])
    try {
      // open a voice_test conversation for tool context
      const conv = await api.post<{ conversation: { id: string } }>('/api/conversations', { channel: 'voice_test', contactName: 'Realtime voice caller' })
      conversationIdRef.current = conv.conversation.id

      const session = await api.post<{ clientSecret: string; model: string; sdpUrl?: string } & Record<string, unknown>>('/api/ai/realtime/session', {})
      const clientSecret = session.clientSecret as string
      const model = (session.model as string) || 'gpt-4o-realtime-preview'
      const sdpUrl = session.sdpUrl || `https://api.openai.com/v1/realtime`

      const pc = new RTCPeerConnection()
      pcRef.current = pc
      const audio = audioRef.current ?? new Audio()
      audio.autoplay = true
      audioRef.current = audio
      pc.ontrack = (e) => { audio.srcObject = e.streams[0] }

      const ms = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = ms
      ms.getTracks().forEach((t) => pc.addTrack(t, ms))

      const dc = pc.createDataChannel('oai-events')
      dcRef.current = dc

      let assistantBuf = ''
      dc.onmessage = async (ev) => {
        let msg: Record<string, unknown>
        try { msg = JSON.parse(ev.data as string) } catch { return }
        const type = String(msg.type ?? '')
        if (type === 'response.output_audio_transcript.delta') {
          assistantBuf += String(msg.delta ?? '')
        } else if (type === 'response.output_audio_transcript.done') {
          if (assistantBuf.trim()) record('assistant', assistantBuf.trim())
          assistantBuf = ''
        } else if (type === 'conversation.item.input_audio_transcription.completed') {
          const text = String(msg.transcript ?? '').trim()
          if (text) record('user', text)
        } else if (type === 'response.function_call_arguments.done') {
          const name = String(msg.name ?? '')
          const callId = String(msg.call_id ?? '')
          let args: Record<string, unknown> = {}
          try { args = JSON.parse(String(msg.arguments ?? '{}')) } catch { args = {} }
          append('tool', `calling ${name}…`)
          try {
            const cid = conversationIdRef.current
            const res = await api.post<{ result: unknown }>('/api/ai/realtime/tool', { conversationId: cid, tool: name, args })
            dc.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(res.result ?? {}) } }))
            dc.send(JSON.stringify({ type: 'response.create' }))
            append('tool', `${name} done`)
          } catch (err) {
            const text = err instanceof Error ? err.message : 'tool failed'
            dc.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ error: text }) } }))
            dc.send(JSON.stringify({ type: 'response.create' }))
            append('tool', `${name} failed: ${text}`)
          }
        } else if (type === 'error') {
          append('system', `error: ${JSON.stringify(msg.error ?? msg)}`)
        }
      }

      dc.onopen = () => { setStatus('connected'); append('system', 'Realtime session connected — speak naturally.') }

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const resp = await fetch(`${sdpUrl}?model=${encodeURIComponent(model)}`, {
        method: 'POST',
        body: offer.sdp ?? '',
        headers: { authorization: `Bearer ${clientSecret}`, 'content-type': 'application/sdp' },
      })
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '')
        throw new Error(`Realtime SDP exchange failed (HTTP ${resp.status}): ${txt.slice(0, 160)}`)
      }
      const answer = await resp.text()
      await pc.setRemoteDescription({ type: 'answer', sdp: answer })
    } catch (err) {
      const text = err instanceof Error ? err.message : 'Realtime connection failed'
      append('system', `Failed: ${text}`)
      toast({ title: 'Realtime connection failed', description: text, variant: 'destructive' })
      teardown()
      setStatus('error')
    }
  }, [append, record, status, teardown, toast])

  const stop = useCallback(() => {
    void flushTranscript()
    append('system', 'Realtime session ended.')
    teardown()
  }, [append, flushTranscript, teardown])

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">OpenAI Realtime Voice</h2>
          <p className="text-sm text-muted-foreground">Low-latency WebRTC voice with the same receptionist tools. Requires an OpenAI-compatible provider + API key.</p>
        </div>
        <div className="flex gap-2">
          {status === 'connected'
            ? <Button variant="destructive" onClick={stop} title="Stop"><Square className="h-4 w-4 mr-1.5" /> Stop</Button>
            : <Button onClick={start} disabled={status === 'connecting'} title={status === 'connecting' ? 'Connecting to realtime voice' : 'Start realtime voice'}><Mic className="h-4 w-4 mr-1.5" /> {status === 'connecting' ? 'Connecting…' : 'Start realtime'}</Button>}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Badge variant={status === 'connected' ? 'secondary' : 'outline'} className={status === 'connected' ? 'text-emerald-600' : ''}>
          {status === 'connected' ? <Wifi className="h-3.5 w-3.5 mr-1" /> : <WifiOff className="h-3.5 w-3.5 mr-1" />}
          {status}
        </Badge>
        <Badge variant="outline"><Volume2 className="h-3.5 w-3.5 mr-1" /> WebRTC audio</Badge>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Transcript / events</CardTitle><CardDescription>Tool calls execute through the validated backend and update business data.</CardDescription></CardHeader>
        <CardContent>
          <ScrollArea className="h-80 w-full rounded-md border p-3">
            <div className="space-y-2">
              {log.length === 0 && <p className="text-sm text-muted-foreground">Press Start and speak to the receptionist.</p>}
              {log.map((l, i) => (
                <div key={i} className="text-sm">
                  <span className="font-medium text-muted-foreground mr-2">{l.who}:</span>
                  <span>{l.text}</span>
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <audio ref={audioRef} autoPlay hidden />
    </div>
  )
}
