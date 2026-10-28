'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/lib/client/store'
import { api, ApiClientError, type SessionInfo } from '@/lib/client/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, LogIn, Sparkles, ShieldCheck, Bot, KeyRound, Eye, EyeOff } from 'lucide-react'

type SsoProvider = { kind: 'oidc' | 'saml'; label: string }

export function AuthScreen() {
  const setSession = useAppStore((s) => s.setSession)
  const [mode, setMode] = useState<'login' | 'setup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [code, setCode] = useState('')
  const [needsTotp, setNeedsTotp] = useState(false)
  const [name, setName] = useState('')
  const [orgName, setOrgName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [demoAvailable, setDemoAvailable] = useState<boolean | null>(null)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [ssoProviders, setSsoProviders] = useState<SsoProvider[]>([])

  const applySession = (s: SessionInfo) => setSession(s)

  // discover whether first-run owner registration is available
  useEffect(() => {
    api.get<SessionInfo>('/api/session').then((s) => {
      setDemoAvailable(Boolean(s.demoAvailable))
      setNeedsSetup(Boolean(s.needsSetup))
      if (s.needsSetup) setMode('setup')
    }).catch(() => setDemoAvailable(false))
  }, [])

  // federated sign-in methods offered by this instance + the reason of a failed SSO round-trip
  useEffect(() => {
    api.get<{ providers: SsoProvider[] }>('/api/auth/sso/providers')
      .then((r) => setSsoProviders(r.providers ?? []))
      .catch(() => setSsoProviders([]))
    const params = new URLSearchParams(window.location.search)
    const ssoError = params.get('sso_error')
    if (ssoError) {
      setError(ssoError)
      params.delete('sso_error')
      const clean = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`
      window.history.replaceState({}, '', clean)
    }
  }, [])

  const login = async (e?: React.FormEvent) => {
    e?.preventDefault()
    setError('')
    setBusy(true)
    try {
      await api.post('/api/auth/login', needsTotp ? { email, password, code: code.trim() } : { email, password })
      const s = await api.get<SessionInfo>('/api/session')
      applySession(s)
    } catch (err) {
      if (err instanceof ApiClientError && (err.code === 'totp_required' || err.code === 'totp_invalid')) {
        setNeedsTotp(true)
        setError(err.code === 'totp_required'
          ? 'Enter the 6-digit code from your authenticator app.'
          : 'Invalid authenticator code. Try the current code.')
      } else {
        setError(err instanceof Error ? err.message : 'Sign in failed')
      }
    } finally {
      setBusy(false)
    }
  }

  const demoLogin = async () => {
    setError('')
    setBusy(true)
    try {
      const seed = await api.post<{ orgId: string; email: string; password: string }>('/api/demo/seed')
      await api.post('/api/auth/login', { email: seed.email, password: seed.password })
      const s = await api.get<SessionInfo>('/api/session')
      applySession(s)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Demo mode failed to start')
    } finally {
      setBusy(false)
    }
  }

  const registerOwner = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await api.post('/api/auth/register-owner', { orgName, businessType: 'generic', name, email, password })
      const s = await api.get<SessionInfo>('/api/session')
      applySession(s)
      useAppStore.getState().setActiveSection('setup')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(420px,0.75fr)]">
      <h1 className="sr-only">AI Secretary</h1>
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r bg-muted/30 p-10 lg:flex xl:p-16">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground" aria-hidden>
            <Bot className="h-5 w-5" />
          </div>
          <span className="text-lg font-semibold tracking-tight">AI Secretary</span>
        </div>

        <div className="max-w-xl">
          <h2 className="text-balance text-3xl font-semibold tracking-tight xl:text-4xl">
            Your front office, in one secure workspace.
          </h2>
          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-muted-foreground">
            Bookings, invoices, payments and customer conversations — with an AI receptionist that works from your real business data.
          </p>
          <div className="mt-8 flex flex-wrap gap-2">
            {['Bookings', 'Invoicing', 'AI receptionist', 'Local-first'].map((item) => (
              <span key={item} className="rounded-full border bg-background/70 px-3 py-1 text-xs font-medium text-muted-foreground">
                {item}
              </span>
            ))}
          </div>
        </div>

        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="h-4 w-4" aria-hidden />
          Self-hosted. Private by default. Your data stays yours.
        </p>
      </aside>

      <main className="flex min-h-screen flex-col">
        <div className="flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
          <div className="w-full max-w-[400px]">
            <div className="mb-8 flex items-center gap-3 lg:hidden">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground" aria-hidden>
                <Bot className="h-5 w-5" />
              </div>
              <span className="text-lg font-semibold tracking-tight">AI Secretary</span>
            </div>

            <Card className="shadow-sm">
              <CardHeader className="space-y-1.5">
                <h2 className="text-xl font-semibold leading-none tracking-tight">{mode === 'login' ? 'Sign in' : 'Create workspace'}</h2>
                <CardDescription>
                  {needsSetup || mode === 'setup'
                    ? 'First time as admin/owner — create the workspace below.'
                    : 'Sign in as the owner of this workspace.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {error && (
                  <Alert variant="destructive" role="alert">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                {mode === 'login' ? (
                  <form onSubmit={login} className="space-y-3" aria-label="Sign in form">
                    <div className="space-y-1.5">
                      <Label htmlFor="email">Email</Label>
                      <Input
                        id="email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false}
                        required value={email} onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@company.com" className="min-h-[44px]"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="password">Password</Label>
                      <div className="relative">
                        <Input
                          id="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password"
                          required value={password} onChange={(e) => setPassword(e.target.value)}
                          placeholder="Enter your password" className="min-h-[44px] pr-11"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((v) => !v)}
                          aria-label={showPassword ? 'Hide password' : 'Show password'}
                          title={showPassword ? 'Hide password' : 'Show password'}
                          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        >
                          {showPassword ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                        </button>
                      </div>
                    </div>
                    {needsTotp && (
                      <div className="space-y-1.5">
                        <Label htmlFor="totp-code">Authenticator code</Label>
                        <Input
                          id="totp-code" inputMode="numeric" autoComplete="one-time-code" maxLength={10}
                          value={code} onChange={(e) => setCode(e.target.value)}
                          placeholder="6-digit code" className="min-h-[44px] tracking-[0.3em]"
                        />
                      </div>
                    )}
                    <Button type="submit" className="min-h-[44px] w-full" disabled={busy} title={busy ? 'Signing in' : 'Sign in'}>
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <LogIn className="h-4 w-4" aria-hidden />}
                      {busy ? 'Signing in…' : 'Sign in'}
                    </Button>
                  </form>
                ) : (
                  <form onSubmit={registerOwner} className="space-y-3" aria-label="Owner registration form">
                    <div className="space-y-1.5">
                      <Label htmlFor="orgName">Business name</Label>
                      <Input id="orgName" required value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Acme Inc." className="min-h-[44px]" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="name">Your name</Label>
                      <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex Rivera" className="min-h-[44px]" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="email">Email</Label>
                      <Input
                        id="email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false}
                        required value={email} onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@company.com" className="min-h-[44px]"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="password">Password</Label>
                      <div className="relative">
                        <Input
                          id="password" type={showPassword ? 'text' : 'password'} autoComplete="new-password"
                          required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)}
                          placeholder="At least 8 characters" className="min-h-[44px] pr-11"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((v) => !v)}
                          aria-label={showPassword ? 'Hide password' : 'Show password'}
                          title={showPassword ? 'Hide password' : 'Show password'}
                          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        >
                          {showPassword ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                        </button>
                      </div>
                    </div>
                    <Button type="submit" className="min-h-[44px] w-full" disabled={busy} title={busy ? 'Creating workspace' : 'Create workspace'}>
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
                      {busy ? 'Creating workspace…' : 'Create workspace'}
                    </Button>
                  </form>
                )}

                {(mode === 'setup' || needsSetup) && (
                  <p className="text-center text-sm text-muted-foreground">
                    {mode === 'login' ? 'New installation?' : 'Already have an account?'}{' '}
                    <button
                      type="button"
                      className="font-medium text-foreground underline-offset-4 hover:underline"
                      onClick={() => { setError(''); setMode(mode === 'login' ? 'setup' : 'login') }}
                      title={mode === 'login' ? 'Create the owner account' : 'Sign in instead'}
                    >
                      {mode === 'login' ? 'Create owner account' : 'Sign in'}
                    </button>
                  </p>
                )}

                {ssoProviders.length > 0 && mode === 'login' && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-muted-foreground">
                      <span className="h-px flex-1 bg-border" />
                      or
                      <span className="h-px flex-1 bg-border" />
                    </div>
                    <div className="space-y-2">
                      {ssoProviders.map((provider) => (
                        <Button key={provider.kind} asChild variant="outline" className="min-h-[44px] w-full" title={`Continue with ${provider.label}`}>
                          <a href={`/api/auth/sso/${provider.kind}/start`} title={`Continue with ${provider.label}`}>
                            <KeyRound className="h-4 w-4" aria-hidden />
                            Continue with {provider.label}
                          </a>
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
              <CardFooter className="border-t bg-muted/20 px-6 py-3">
                <Button type="button" variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={demoLogin} disabled={busy} title={demoAvailable === false ? 'Create demo workspace with sample data' : 'Explore demo workspace with sample data'}>
                  <Sparkles className="h-4 w-4" aria-hidden />
                  {demoAvailable === false ? 'Create demo workspace (sample data)' : 'Explore demo workspace (sample data)'}
                </Button>
              </CardFooter>
            </Card>
          </div>
        </div>
      </main>
    </div>
  )
}
