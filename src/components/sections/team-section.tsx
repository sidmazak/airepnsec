'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, ApiClientError, type TeamInvite, type TeamMember } from '@/lib/client/api'
import { useToast } from '@/hooks/use-toast'
import { useAppStore } from '@/lib/client/store'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Copy, KeyRound, Loader2, Mail, ShieldOff, UserPlus, Users, UserX } from 'lucide-react'

const ROLES = ['admin', 'agent', 'viewer'] as const
type Role = (typeof ROLES)[number]

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  agent: 'Agent',
  viewer: 'Viewer',
}

export function TeamSection() {
  const { toast } = useToast()
  const session = useAppStore((s) => s.session)
  const setSession = useAppStore((s) => s.setSession)
  const role = session?.user?.role ?? 'viewer'
  const isOwner = role === 'owner'
  const canManage = role === 'owner' || role === 'admin'

  const [members, setMembers] = useState<TeamMember[]>([])
  const [invites, setInvites] = useState<TeamInvite[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<Role>('agent')
  const [inviteBusy, setInviteBusy] = useState(false)
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)

  const [resetTarget, setResetTarget] = useState<TeamMember | null>(null)
  const [resetLink, setResetLink] = useState<string | null>(null)
  const [resetBusy, setResetBusy] = useState(false)

  const [deactivateTarget, setDeactivateTarget] = useState<TeamMember | null>(null)

  const [pwOpen, setPwOpen] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [pwBusy, setPwBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [m, i] = await Promise.all([
        api.get<{ members: TeamMember[] }>('/api/users'),
        api.get<{ invites: TeamInvite[] }>('/api/users/invites'),
      ])
      setMembers(m.members)
      setInvites(i.invites)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the team')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const sendInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    setInviteBusy(true)
    try {
      const res = await api.post<{ inviteUrl: string }>('/api/users/invites', {
        email: inviteEmail.trim(),
        role: inviteRole,
      })
      setInviteUrl(res.inviteUrl)
      setInviteEmail('')
      toast({ title: 'Invitation created', description: 'The invitation email is queued in the outbox. Share the link if email is not configured yet.' })
      await load()
    } catch (err) {
      toast({ title: 'Could not create the invitation', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setInviteBusy(false)
    }
  }

  const revokeInvite = async (invite: TeamInvite) => {
    try {
      await api.post('/api/users/invites/revoke', { id: invite.id })
      toast({ title: 'Invitation revoked' })
      await load()
    } catch (err) {
      toast({ title: 'Could not revoke the invitation', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    }
  }

  const changeRole = async (member: TeamMember, nextRole: Role) => {
    try {
      await api.patch(`/api/users/${member.id}`, { role: nextRole })
      toast({ title: `${member.name} is now ${ROLE_LABEL[nextRole]}` })
      await load()
    } catch (err) {
      toast({ title: 'Could not change the role', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    }
  }

  const setActive = async (member: TeamMember, active: boolean) => {
    try {
      await api.patch(`/api/users/${member.id}`, { active })
      toast({ title: active ? `${member.name} can sign in again` : `${member.name} was deactivated`, description: active ? undefined : 'All of their sessions were revoked.' })
      await load()
    } catch (err) {
      toast({ title: 'Could not update the member', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    }
  }

  const revokeSessions = async (member: TeamMember) => {
    try {
      const res = await api.post<{ revoked: number }>(`/api/users/${member.id}/revoke-sessions`)
      toast({ title: 'Sessions revoked', description: `${res.revoked} session(s) signed out.` })
    } catch (err) {
      toast({ title: 'Could not revoke sessions', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    }
  }

  const issueReset = async () => {
    if (!resetTarget) return
    setResetBusy(true)
    try {
      const res = await api.post<{ link: string }>(`/api/users/${resetTarget.id}/reset-password`)
      setResetLink(res.link)
    } catch (err) {
      toast({ title: 'Could not issue a reset link', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setResetBusy(false)
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

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setPwBusy(true)
    try {
      await api.patch('/api/users/me/password', { currentPassword, newPassword })
      toast({ title: 'Password changed', description: 'Every session was signed out — sign in again with the new password.' })
      setPwOpen(false)
      setCurrentPassword('')
      setNewPassword('')
      setSession(null)
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : err instanceof Error ? err.message : 'Unknown error'
      toast({ title: 'Could not change the password', description: msg, variant: 'destructive' })
    } finally {
      setPwBusy(false)
    }
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Team</h2>
          <p className="text-sm text-muted-foreground">
            People who can sign in to this organisation. Owners manage everything, admins run the
            business, agents handle conversations and bookings, viewers get read-only access.
          </p>
        </div>
        {canManage && (
          <Button className="min-h-[44px]" onClick={() => { setInviteOpen(true); setInviteUrl(null) }}>
            <UserPlus className="h-4 w-4" aria-hidden />
            Invite member
          </Button>
        )}
      </div>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>Retry</Button>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-muted-foreground" aria-hidden />
            <div>
              <CardTitle>Members</CardTitle>
              <CardDescription>{members.length} account(s) in this organisation.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-2/3" />
            </div>
          ) : members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No members yet.</p>
          ) : (
            <div className="max-h-96 overflow-y-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Member</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last sign-in</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map((m) => {
                    const isSelf = m.id === session?.user?.id
                    const manageable = canManage && !isSelf && (isOwner || m.role === 'agent' || m.role === 'viewer')
                    return (
                      <TableRow key={m.id}>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium">{m.name}{isSelf ? ' (you)' : ''}</span>
                            <span className="text-xs text-muted-foreground">{m.email}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          {m.role === 'owner' || !manageable ? (
                            <Badge variant="secondary">{ROLE_LABEL[m.role] ?? m.role}</Badge>
                          ) : (
                            <Select value={m.role} onValueChange={(v) => void changeRole(m, v as Role)}>
                              <SelectTrigger className="h-9 w-32" aria-label={`Role for ${m.name}`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {ROLES.map((r) => (
                                  <SelectItem key={r} value={r}>{ROLE_LABEL[r]}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </TableCell>
                        <TableCell>
                          {m.active ? (
                            <Badge className="bg-emerald-100 text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-200">Active</Badge>
                          ) : (
                            <Badge className="bg-muted text-muted-foreground">Deactivated</Badge>
                          )}
                          {m.twoFactorEnabled && <Badge variant="outline" className="ml-1">2FA</Badge>}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {m.lastLoginAt ? new Date(m.lastLoginAt).toLocaleString() : 'Never'}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            {manageable && (
                              <Button variant="ghost" size="sm" className="min-h-[36px]" aria-label={`Sign out ${m.name}`} onClick={() => void revokeSessions(m)}>
                                Sign out
                              </Button>
                            )}
                            {isOwner && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="min-h-[36px]"
                                aria-label={`Issue a password reset for ${m.name}`}
                                onClick={() => { setResetTarget(m); setResetLink(null) }}
                              >
                                <KeyRound className="h-4 w-4" aria-hidden />
                                Reset
                              </Button>
                            )}
                            {manageable && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="min-h-[36px] text-destructive"
                                aria-label={`Deactivate ${m.name}`}
                                onClick={() => setDeactivateTarget(m)}
                              >
                                <ShieldOff className="h-4 w-4" aria-hidden />
                                Deactivate
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {canManage && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Mail className="h-5 w-5 text-muted-foreground" aria-hidden />
              <div>
                <CardTitle>Pending invitations</CardTitle>
                <CardDescription>Invitation links work once and expire after 7 days.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-9 w-full" />
            ) : invites.length === 0 ? (
              <p className="text-sm text-muted-foreground">No pending invitations.</p>
            ) : (
              <ul className="space-y-2">
                {invites.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                    <div>
                      <p className="text-sm font-medium">{i.email}</p>
                      <p className="text-xs text-muted-foreground">
                        {ROLE_LABEL[i.role] ?? i.role} · expires {new Date(i.expiresAt).toLocaleString()}
                      </p>
                    </div>
                    <Button variant="outline" size="sm" className="min-h-[36px]" onClick={() => void revokeInvite(i)}>
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Your account</CardTitle>
          <CardDescription>Change the password you sign in with.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" className="min-h-[44px]" onClick={() => setPwOpen(true)}>
            <KeyRound className="h-4 w-4" aria-hidden />
            Change my password
          </Button>
        </CardContent>
      </Card>

      {/* invite dialog */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Invite a team member</DialogTitle>
            <DialogDescription>
              They receive a one-time link to set their own password. The link is emailed through the
              outbox — if no email integration is configured, copy the link below and send it yourself.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={sendInvite} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="team-invite-email">Email</Label>
              <Input id="team-invite-email" type="email" required maxLength={200} value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} className="min-h-[44px]" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="team-invite-role">Role</Label>
              <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as Role)}>
                <SelectTrigger id="team-invite-role" className="min-h-[44px]" aria-label="Role for the new member">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r} value={r}>{ROLE_LABEL[r]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {inviteUrl && (
              <div className="rounded-md border p-3 space-y-2">
                <p className="text-xs text-muted-foreground">Invitation link (shown once):</p>
                <div className="flex items-center gap-2">
                  <code className="text-xs break-all rounded bg-muted px-2 py-1 flex-1">{inviteUrl}</code>
                  <Button type="button" variant="outline" size="sm" className="min-h-[36px]" aria-label="Copy invitation link" onClick={() => void copy(inviteUrl, 'Invitation link')}>
                    <Copy className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" className="min-h-[44px]" onClick={() => setInviteOpen(false)}>Close</Button>
              <Button type="submit" className="min-h-[44px]" disabled={inviteBusy}>
                {inviteBusy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                Create invitation
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* password reset dialog */}
      <Dialog open={!!resetTarget} onOpenChange={(open) => { if (!open) { setResetTarget(null); setResetLink(null) } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset password</DialogTitle>
            <DialogDescription>
              A one-time reset link for {resetTarget?.email}. It is emailed through the outbox and
              expires in one hour. Share the link below if email is not configured.
            </DialogDescription>
          </DialogHeader>
          {resetLink ? (
            <div className="rounded-md border p-3 space-y-2">
              <p className="text-xs text-muted-foreground">Reset link (shown once):</p>
              <div className="flex items-center gap-2">
                <code className="text-xs break-all rounded bg-muted px-2 py-1 flex-1">{resetLink}</code>
                <Button variant="outline" size="sm" className="min-h-[36px]" aria-label="Copy reset link" onClick={() => void copy(resetLink, 'Reset link')}>
                  <Copy className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            </div>
          ) : (
            <Button className="min-h-[44px]" disabled={resetBusy} onClick={() => void issueReset()}>
              {resetBusy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Issue reset link
            </Button>
          )}
          <DialogFooter>
            <Button variant="outline" className="min-h-[44px]" onClick={() => { setResetTarget(null); setResetLink(null) }}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* change own password */}
      <Dialog open={pwOpen} onOpenChange={setPwOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Change your password</DialogTitle>
            <DialogDescription>All sessions (including this one) are signed out after the change.</DialogDescription>
          </DialogHeader>
          <form onSubmit={changePassword} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="team-current-pw">Current password</Label>
              <Input id="team-current-pw" type="password" autoComplete="current-password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className="min-h-[44px]" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="team-new-pw">New password</Label>
              <Input id="team-new-pw" type="password" autoComplete="new-password" minLength={8} required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="min-h-[44px]" />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" className="min-h-[44px]" onClick={() => setPwOpen(false)}>Cancel</Button>
              <Button type="submit" className="min-h-[44px]" disabled={pwBusy}>
                {pwBusy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                Change password
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* deactivate confirmation */}
      <AlertDialog open={!!deactivateTarget} onOpenChange={(open) => { if (!open) setDeactivateTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <UserX className="h-4 w-4" aria-hidden />
              Deactivate {deactivateTarget?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They will not be able to sign in again and all of their sessions are revoked. Their
              history (bookings, invoices, payments) is kept. You can reactivate the account later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-[44px]">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="min-h-[44px]"
              onClick={() => { if (deactivateTarget) void setActive(deactivateTarget, false) }}
            >
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
