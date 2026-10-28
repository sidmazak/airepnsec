'use client'

import { useEffect, useState } from 'react'
import { api, ApiClientError } from '@/lib/client/api'
import { useToast } from '@/hooks/use-toast'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { Copy, KeyRound, Loader2, ShieldCheck, ShieldOff } from 'lucide-react'
import { ScimSettings, SsoSettings } from '@/components/sections/sso-settings'

type TwoFactorStatus = { enabled: boolean; enrollmentPending: boolean }

export function SecuritySection() {
  const { toast } = useToast()
  const [status, setStatus] = useState<TwoFactorStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [flow, setFlow] = useState<'idle' | 'enroll' | 'confirm' | 'disable'>('idle')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [enrollment, setEnrollment] = useState<{ secret: string; otpauthUrl: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setStatus(await api.get<TwoFactorStatus>('/api/auth/2fa'))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load security settings')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const resetFlow = () => {
    setFlow('idle')
    setPassword('')
    setCode('')
    setEnrollment(null)
  }

  const startEnrollment = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await api.post<{ secret: string; otpauthUrl: string }>('/api/auth/2fa/setup', { password })
      setEnrollment({ secret: res.secret, otpauthUrl: res.otpauthUrl })
      setFlow('confirm')
      toast({ title: 'Enrollment started', description: 'Add the secret to your authenticator app, then confirm with a current code.' })
    } catch (err) {
      toast({ title: 'Could not start enrollment', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const confirmEnrollment = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api.post('/api/auth/2fa/enable', { code: code.trim() })
      toast({ title: 'Two-factor authentication enabled', description: 'You will be asked for a code on every sign-in.' })
      resetFlow()
      await load()
    } catch (err) {
      toast({ title: 'Code not accepted', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const disable = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api.post('/api/auth/2fa/disable', { password, code: code.trim() || undefined })
      toast({ title: 'Two-factor authentication disabled' })
      resetFlow()
      await load()
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : err instanceof Error ? err.message : 'Unknown error'
      toast({ title: 'Could not disable', description: msg, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast({ title: `${what} copied` })
    } catch {
      toast({ title: 'Copy failed', description: 'Copy it manually.', variant: 'destructive' })
    }
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Security</h2>
        <p className="text-sm text-muted-foreground">Account protection for this installation. Two-factor codes are verified server-side (RFC 6238 TOTP) and the secret never leaves this server.</p>
      </div>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={() => void load()} title="Retry">Retry</Button>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              {status?.enabled ? <ShieldCheck className="h-5 w-5 text-emerald-600" aria-hidden /> : <ShieldOff className="h-5 w-5 text-muted-foreground" aria-hidden />}
              <div>
                <CardTitle>Two-factor authentication</CardTitle>
                <CardDescription>Time-based codes from any authenticator app (Google Authenticator, 1Password, Aegis…).</CardDescription>
              </div>
            </div>
            {status && (
              <Badge className={status.enabled ? 'bg-emerald-100 text-emerald-900' : 'bg-muted text-muted-foreground'}>
                {status.enabled ? 'Enabled' : status.enrollmentPending ? 'Enrollment pending' : 'Off'}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-9 w-full max-w-sm" />
            </div>
          ) : flow === 'idle' ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {status?.enabled
                  ? 'Codes are required on every sign-in. Keep your authenticator app backed up; without it, an owner must reset the account directly in the database.'
                  : 'Protect this account with a second factor. Setup takes about a minute.'}
              </p>
              <Button className="min-h-[44px]" onClick={() => { resetFlow(); setFlow(status?.enabled ? 'disable' : 'enroll') }} title={status?.enabled ? 'Disable two-factor authentication' : 'Enable two-factor authentication'}>
                <KeyRound className="h-4 w-4" aria-hidden />
                {status?.enabled ? 'Disable two-factor' : 'Enable two-factor'}
              </Button>
            </div>
          ) : flow === 'enroll' ? (
            <form onSubmit={startEnrollment} className="space-y-3 max-w-sm" aria-label="Start two-factor enrollment">
              <div className="space-y-1.5">
                <Label htmlFor="sec-password">Confirm your password</Label>
                <Input id="sec-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="min-h-[44px]" />
              </div>
              <div className="flex gap-2">
                <Button type="submit" className="min-h-[44px]" disabled={busy} title="Continue">
                  {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                  Continue
                </Button>
                <Button type="button" variant="outline" className="min-h-[44px]" onClick={resetFlow} title="Cancel">Cancel</Button>
              </div>
            </form>
          ) : flow === 'confirm' && enrollment ? (
            <form onSubmit={confirmEnrollment} className="space-y-4 max-w-lg" aria-label="Confirm two-factor enrollment">
              <div className="rounded-md border p-3 space-y-2">
                <p className="text-sm font-medium">1. Add this secret to your authenticator app</p>
                <div className="flex items-center gap-2">
                  <code className="text-xs break-all rounded bg-muted px-2 py-1 flex-1">{enrollment.secret}</code>
                  <Button type="button" variant="outline" size="sm" className="min-h-[36px]" aria-label="Copy secret" title="Copy secret" onClick={() => void copy(enrollment.secret, 'Secret')}>
                    <Copy className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <code className="text-[10px] break-all rounded bg-muted px-2 py-1 flex-1 text-muted-foreground">{enrollment.otpauthUrl}</code>
                  <Button type="button" variant="outline" size="sm" className="min-h-[36px]" aria-label="Copy otpauth URL" title="Copy otpauth URL" onClick={() => void copy(enrollment.otpauthUrl, 'otpauth URL')}>
                    <Copy className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">Most apps accept the otpauth:// URL directly; otherwise enter the secret manually.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sec-code">2. Enter the current 6-digit code</Label>
                <Input id="sec-code" inputMode="numeric" autoComplete="one-time-code" maxLength={10} required value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" className="min-h-[44px] tracking-[0.3em]" />
              </div>
              <div className="flex gap-2">
                <Button type="submit" className="min-h-[44px]" disabled={busy} title="Verify &amp; enable">
                  {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                  Verify &amp; enable
                </Button>
                <Button type="button" variant="outline" className="min-h-[44px]" onClick={resetFlow} title="Cancel">Cancel</Button>
              </div>
            </form>
          ) : (
            <form onSubmit={disable} className="space-y-3 max-w-sm" aria-label="Disable two-factor">
              <div className="space-y-1.5">
                <Label htmlFor="sec-off-password">Your password</Label>
                <Input id="sec-off-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sec-off-code">Current authenticator code</Label>
                <Input id="sec-off-code" inputMode="numeric" autoComplete="one-time-code" maxLength={10} required value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" className="min-h-[44px] tracking-[0.3em]" />
              </div>
              <div className="flex gap-2">
                <Button type="submit" variant="destructive" className="min-h-[44px]" disabled={busy} title="Disable two-factor">
                  {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                  Disable two-factor
                </Button>
                <Button type="button" variant="outline" className="min-h-[44px]" onClick={resetFlow} title="Cancel">Cancel</Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      <SsoSettings />

      <ScimSettings />
    </div>
  )
}
