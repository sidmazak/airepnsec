'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/client/api'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, UserPlus } from 'lucide-react'

/**
 * Public screens for the two emailed links:
 *  - `#?join=<token>`  -> accept an invitation and set a password
 *  - `#/reset-password?token=<token>` -> set a new password
 */

function Shell({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div className="w-full max-w-md">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
      </div>
    </div>
  )
}

export function JoinScreen({ token, onDone }: { token: string; onDone: () => void }) {
  const { toast } = useToast()
  const [email, setEmail] = useState<string | null>(null)
  const [role, setRole] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.get<{ invite: { email: string; role: string } }>(`/api/users/invites/${encodeURIComponent(token)}`)
      .then((res) => {
        if (cancelled) return
        setEmail(res.invite.email)
        setRole(res.invite.role)
      })
      .catch(() => { if (!cancelled) setInvalid(true) })
    return () => { cancelled = true }
  }, [token])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api.post(`/api/users/invites/${encodeURIComponent(token)}/accept`, {
        name: name.trim() || undefined,
        password,
      })
      toast({ title: 'Welcome aboard', description: 'Your account is ready.' })
      onDone()
    } catch (err) {
      toast({ title: 'Could not join', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  if (invalid) {
    return (
      <Shell title="Invitation not valid" description="This invitation link is invalid, expired, or already used.">
        <Alert variant="destructive">
          <AlertDescription>Ask the owner of this organisation for a new invitation.</AlertDescription>
        </Alert>
      </Shell>
    )
  }

  return (
    <Shell title="Join the team" description="Set a password to accept the invitation.">
      {email === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-busy="true">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Checking the invitation…
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div className="rounded-md border p-3 text-sm">
            <p className="font-medium">{email}</p>
            <p className="text-xs text-muted-foreground">Role: {role}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="join-name">Your name (optional)</Label>
            <Input id="join-name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className="min-h-[44px]" autoComplete="name" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="join-password">Password</Label>
            <Input id="join-password" type="password" required minLength={8} maxLength={200} value={password} onChange={(e) => setPassword(e.target.value)} className="min-h-[44px]" autoComplete="new-password" />
            <p className="text-xs text-muted-foreground">At least 8 characters.</p>
          </div>
          <Button type="submit" className="w-full min-h-[44px]" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <UserPlus className="h-4 w-4" aria-hidden />}
            Create my account
          </Button>
        </form>
      )}
    </Shell>
  )
}

export function ResetPasswordScreen({ token, onDone }: { token: string; onDone: () => void }) {
  const { toast } = useToast()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password !== confirm) {
      toast({ title: 'Passwords do not match', variant: 'destructive' })
      return
    }
    setBusy(true)
    try {
      await api.post('/api/auth/reset-password', { token, password })
      toast({ title: 'Password updated', description: 'Sign in with your new password.' })
      onDone()
    } catch (err) {
      toast({ title: 'Could not reset the password', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell title="Set a new password" description="This link works once. All of your sessions are signed out afterwards.">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="reset-pw">New password</Label>
          <Input id="reset-pw" type="password" required minLength={8} maxLength={200} value={password} onChange={(e) => setPassword(e.target.value)} className="min-h-[44px]" autoComplete="new-password" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="reset-pw2">Repeat password</Label>
          <Input id="reset-pw2" type="password" required minLength={8} maxLength={200} value={confirm} onChange={(e) => setConfirm(e.target.value)} className="min-h-[44px]" autoComplete="new-password" />
        </div>
        <Button type="submit" className="w-full min-h-[44px]" disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          Update password
        </Button>
      </form>
    </Shell>
  )
}
