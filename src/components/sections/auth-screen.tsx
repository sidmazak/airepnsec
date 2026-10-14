'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/lib/client/store'
import { api, type SessionInfo } from '@/lib/client/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'
import { Loader2, LogIn, Sparkles, ShieldCheck, CalendarCheck, Receipt, Bot } from 'lucide-react'

export function AuthScreen() {
  const setSession = useAppStore((s) => s.setSession)
  const [mode, setMode] = useState<'login' | 'setup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [orgName, setOrgName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [demoAvailable, setDemoAvailable] = useState<boolean | null>(null)

  const applySession = (s: SessionInfo) => setSession(s)

  // discover whether first-run owner registration is available
  useEffect(() => {
    api.get<SessionInfo>('/api/session').then((s) => {
      setDemoAvailable(Boolean(s.demoAvailable))
      if (s.needsSetup) setMode('setup')
    }).catch(() => setDemoAvailable(false))
  }, [])

  const login = async (e?: React.FormEvent) => {
    e?.preventDefault()
    setError('')
    setBusy(true)
    try {
      await api.post('/api/auth/login', { email, password })
      const s = await api.get<SessionInfo>('/api/session')
      applySession(s)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed')
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
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-muted/60 to-background">
      <main className="flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-5xl grid lg:grid-cols-2 gap-8 items-center">
          <div className="space-y-6">
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 rounded-xl bg-primary text-primary-foreground flex items-center justify-center" aria-hidden>
                <Bot className="h-6 w-6" />
              </div>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">AI Secretary</h1>
                <p className="text-sm text-muted-foreground">Your local-first AI receptionist &amp; back office</p>
              </div>
            </div>
            <ul className="space-y-3 text-sm text-muted-foreground" aria-label="Product highlights">
              <li className="flex gap-2"><CalendarCheck className="h-4 w-4 mt-0.5 text-primary" aria-hidden /> Real booking engine with conflict protection — web, chat, and voice test calls</li>
              <li className="flex gap-2"><Receipt className="h-4 w-4 mt-0.5 text-primary" aria-hidden /> Invoices, verified payments, and an auditable ledger you can trust</li>
              <li className="flex gap-2"><Bot className="h-4 w-4 mt-0.5 text-primary" aria-hidden /> AI receptionist that answers from your approved knowledge and real data</li>
              <li className="flex gap-2"><ShieldCheck className="h-4 w-4 mt-0.5 text-primary" aria-hidden /> Local-first: works without cloud AI; bring your own keys when you want them</li>
            </ul>
          </div>

          <Card className="w-full">
            <CardHeader>
              <CardTitle>{mode === 'login' ? 'Sign in' : 'Create your workspace'}</CardTitle>
              <CardDescription>
                {mode === 'login'
                  ? 'Use the account created during setup.'
                  : 'This is the first run on this installation — create the owner account.'}
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
                    <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@business.example" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="password">Password</Label>
                    <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
                  </div>
                  <Button type="submit" className="w-full" disabled={busy}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <LogIn className="h-4 w-4" aria-hidden />}
                    Sign in
                  </Button>
                </form>
              ) : (
                <form onSubmit={registerOwner} className="space-y-3" aria-label="Owner registration form">
                  <div className="space-y-1.5">
                    <Label htmlFor="orgName">Business name</Label>
                    <Input id="orgName" required value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Acme Salon" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="name">Your name</Label>
                    <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex Rivera" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="email">Email</Label>
                    <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@business.example" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="password">Password (min 8 characters)</Label>
                    <Input id="password" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
                  </div>
                  <Button type="submit" className="w-full" disabled={busy}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
                    Create workspace &amp; start setup
                  </Button>
                </form>
              )}

              <div className="flex items-center justify-between text-sm">
                <button
                  type="button"
                  className="text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => setMode(mode === 'login' ? 'setup' : 'login')}
                >
                  {mode === 'login' ? 'First run? Create owner account' : 'Already have an account? Sign in'}
                </button>
              </div>

              <Separator />

              <div className="space-y-2">
                <Button type="button" variant="secondary" className="w-full" onClick={demoLogin} disabled={busy}>
                  <Sparkles className="h-4 w-4" aria-hidden />
                  Try the demo workspace (seeded data, no real customers)
                </Button>
                <p className="text-xs text-muted-foreground">
                  {demoAvailable === false
                    ? 'Demo data has not been created yet — the first click creates it.'
                    : 'Demo credentials: demo@aisecretary.local / demo-1234. Demo data is clearly labeled and separate from production records.'}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
      <footer className="py-4 text-center text-xs text-muted-foreground pb-[max(1rem,env(safe-area-inset-bottom))]">
        AI Secretary — self-hosted, local-first. No data leaves this machine unless you connect a provider.
      </footer>
    </div>
  )
}
