'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/client/api'
import { useAppStore } from '@/lib/client/store'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { RefreshCw, Coins, Cpu, Zap, Clock } from 'lucide-react'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar } from 'recharts'

type UsageData = {
  windowDays: number
  since: string
  summary: { calls: number; ok: number; fail: number; tokensIn: number; tokensOut: number; tokensTotal: number; costUsd: number; costKnown: boolean; avgLatencyMs: number; conversations: number; messages: number; aiConversations: number }
  byCapability: Array<{ capability: string; calls: number; ok: number; fail: number; tokensIn: number; tokensOut: number; latencyMs: number }>
  byProviderModel: Array<{ provider: string; model: string; calls: number; ok: number; fail: number; tokensIn: number; tokensOut: number; latencyMs: number; costUsd: number; costKnown: boolean }>
  daily: Array<{ date: string; calls: number; tokensIn: number; tokensOut: number; costUsd: number; ok: number; fail: number }>
}

function fmt(n: number) { return n.toLocaleString() }

export default function UsageSection() {
  const [days, setDays] = useState('30')
  const [data, setData] = useState<UsageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true); setError(null)
    try {
      const res = await api.get<UsageData>(`/api/usage?days=${days}`)
      setData(res)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load usage')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [days])

  const s = data?.summary
  const dailyChart = (data?.daily ?? []).map((d) => ({ date: d.date.slice(5), tokens: d.tokensIn + d.tokensOut, cost: d.costUsd, calls: d.calls }))

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Usage &amp; Billing</h2>
          <p className="text-sm text-muted-foreground">Token consumption, latency, cost estimates and provider breakdown. Costs are estimates from published per-token rates.</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="w-32 min-h-[44px]" aria-label="Usage period"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
              <SelectItem value="365">Last 12 months</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={load} className="min-h-[44px]" aria-label="Refresh usage" title="Refresh usage"><RefreshCw className="h-4 w-4" /></Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive"><AlertTitle>Failed to load usage</AlertTitle><AlertDescription>{error}</AlertDescription><Button variant="outline" size="sm" onClick={load} className="mt-2" title="Retry">Retry</Button></Alert>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium">AI calls</CardTitle><Zap className="h-4 w-4 text-muted-foreground" /></CardHeader><CardContent>{loading ? <Skeleton className="h-8 w-20" /> : <><div className="text-2xl font-bold">{fmt(s?.calls ?? 0)}</div><p className="text-xs text-muted-foreground">{s?.ok ?? 0} ok · {s?.fail ?? 0} failed</p></>}</CardContent></Card>
        <Card><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium">Tokens (in / out)</CardTitle><Cpu className="h-4 w-4 text-muted-foreground" /></CardHeader><CardContent>{loading ? <Skeleton className="h-8 w-28" /> : <><div className="text-2xl font-bold">{fmt(s?.tokensTotal ?? 0)}</div><p className="text-xs text-muted-foreground">{fmt(s?.tokensIn ?? 0)} in · {fmt(s?.tokensOut ?? 0)} out</p></>}</CardContent></Card>
        <Card><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium">Est. cost (USD)</CardTitle><Coins className="h-4 w-4 text-muted-foreground" /></CardHeader><CardContent>{loading ? <Skeleton className="h-8 w-20" /> : <><div className="text-2xl font-bold">${(s?.costUsd ?? 0).toFixed(4)}</div><p className="text-xs text-muted-foreground">{s?.costKnown ? 'known rates' : 'some rates unknown'}</p></>}</CardContent></Card>
        <Card><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium">Avg latency</CardTitle><Clock className="h-4 w-4 text-muted-foreground" /></CardHeader><CardContent>{loading ? <Skeleton className="h-8 w-20" /> : <><div className="text-2xl font-bold">{s?.avgLatencyMs ?? 0} ms</div><p className="text-xs text-muted-foreground">{s?.aiConversations ?? 0} AI conversations</p></>}</CardContent></Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Daily token volume</CardTitle><CardDescription>Tokens in + out per day</CardDescription></CardHeader>
          <CardContent className="h-64">
            {loading ? <Skeleton className="h-full w-full" /> : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={dailyChart}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="tokens" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Daily estimated cost</CardTitle><CardDescription>USD per day</CardDescription></CardHeader>
          <CardContent className="h-64">
            {loading ? <Skeleton className="h-full w-full" /> : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dailyChart}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="cost" fill="hsl(var(--primary))" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">By capability</CardTitle></CardHeader>
        <CardContent>
          {loading ? <Skeleton className="h-40 w-full" /> : (
            <Table>
              <TableHeader><TableRow><TableHead>Capability</TableHead><TableHead className="text-right">Calls</TableHead><TableHead className="text-right">OK</TableHead><TableHead className="text-right">Fail</TableHead><TableHead className="text-right">Tokens in</TableHead><TableHead className="text-right">Tokens out</TableHead><TableHead className="text-right">Avg ms</TableHead></TableRow></TableHeader>
              <TableBody>
                {(data?.byCapability ?? []).map((c) => (
                  <TableRow key={c.capability}>
                    <TableCell><Badge variant="secondary">{c.capability}</Badge></TableCell>
                    <TableCell className="text-right">{fmt(c.calls)}</TableCell>
                    <TableCell className="text-right">{fmt(c.ok)}</TableCell>
                    <TableCell className="text-right">{fmt(c.fail)}</TableCell>
                    <TableCell className="text-right">{fmt(c.tokensIn)}</TableCell>
                    <TableCell className="text-right">{fmt(c.tokensOut)}</TableCell>
                    <TableCell className="text-right">{c.calls ? Math.round(c.latencyMs / c.calls) : 0}</TableCell>
                  </TableRow>
                ))}
                {(!data?.byCapability || data.byCapability.length === 0) && <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-6">No AI activity in this window</TableCell></TableRow>}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">By provider / model</CardTitle><CardDescription>Cost estimates use published per-1M-token rates</CardDescription></CardHeader>
        <CardContent>
          {loading ? <Skeleton className="h-40 w-full" /> : (
            <Table>
              <TableHeader><TableRow><TableHead>Provider</TableHead><TableHead>Model</TableHead><TableHead className="text-right">Calls</TableHead><TableHead className="text-right">Tokens</TableHead><TableHead className="text-right">Cost USD</TableHead><TableHead className="text-right">Rate known</TableHead></TableRow></TableHeader>
              <TableBody>
                {(data?.byProviderModel ?? []).map((p) => (
                  <TableRow key={`${p.provider}-${p.model}`}>
                    <TableCell><Badge variant="outline">{p.provider}</Badge></TableCell>
                    <TableCell className="font-mono text-xs">{p.model}</TableCell>
                    <TableCell className="text-right">{fmt(p.calls)}</TableCell>
                    <TableCell className="text-right">{fmt(p.tokensIn + p.tokensOut)}</TableCell>
                    <TableCell className="text-right">{p.costUsd.toFixed(4)}</TableCell>
                    <TableCell className="text-right">{p.costKnown ? 'yes' : 'no'}</TableCell>
                  </TableRow>
                ))}
                {(!data?.byProviderModel || data.byProviderModel.length === 0) && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">No provider activity</TableCell></TableRow>}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
