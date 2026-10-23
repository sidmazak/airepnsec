'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/client/api'
import { useToast } from '@/hooks/use-toast'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Copy, KeyRound, Loader2, Plug, Users } from 'lucide-react'

/**
 * Federated sign-in (OIDC / SAML) and SCIM 2.0 provisioning.
 *
 * Secrets are write-only: the API never returns them, so the fields stay empty
 * and a filled-in value replaces the stored one.
 */

type SsoEntry = {
  kind: 'oidc' | 'saml'
  enabled: boolean
  configured: boolean
  secretPresent: Record<string, boolean>
  config: Record<string, unknown>
}

type SsoResponse = { sso: SsoEntry[] }

type ScimState = { enabled: boolean; url: string; tokenPresent: boolean; createdAt: string | null }

const OIDC_FIELDS = [
  { key: 'label', label: 'Button label', placeholder: 'Sign in with Okta' },
  { key: 'issuer', label: 'Issuer', placeholder: 'https://id.example.com/realms/main' },
  { key: 'clientId', label: 'Client ID', placeholder: 'the client id from your provider' },
  { key: 'redirectUri', label: 'Redirect URI', placeholder: 'https://app.example.com/api/auth/sso/oidc/callback' },
  { key: 'scopes', label: 'Scopes', placeholder: 'openid profile email' },
] as const

const SAML_FIELDS = [
  { key: 'label', label: 'Button label', placeholder: 'Sign in with SAML' },
  { key: 'entityId', label: 'Service provider entity ID', placeholder: 'https://app.example.com/saml/metadata' },
  { key: 'acsUrl', label: 'Assertion consumer URL', placeholder: 'https://app.example.com/api/auth/sso/saml/acs' },
  { key: 'idpEntityId', label: 'Identity provider entity ID', placeholder: 'https://id.example.com/metadata' },
  { key: 'idpSsoUrl', label: 'Identity provider sign-in URL', placeholder: 'https://id.example.com/sso' },
  { key: 'idpMetadataUrl', label: 'IdP metadata URL (optional)', placeholder: 'https://id.example.com/metadata.xml' },
] as const

function field(entry: SsoEntry | undefined, key: string): string {
  const value = entry?.config?.[key]
  return typeof value === 'string' ? value : ''
}

export function SsoSettings() {
  const { toast } = useToast()
  const [data, setData] = useState<SsoResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({})
  const [enabled, setEnabled] = useState<Record<string, boolean>>({})
  const [autoProvision, setAutoProvision] = useState<Record<string, boolean>>({})
  const [defaultRole, setDefaultRole] = useState<Record<string, string>>({})
  const [domains, setDomains] = useState<Record<string, string>>({})
  const [clientSecret, setClientSecret] = useState('')
  const [idpCertificate, setIdpCertificate] = useState('')

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<SsoResponse>('/api/admin/sso')
      setData(res)
      const next: Record<string, Record<string, string>> = {}
      const nextEnabled: Record<string, boolean> = {}
      const nextProvision: Record<string, boolean> = {}
      const nextRole: Record<string, string> = {}
      const nextDomains: Record<string, string> = {}
      for (const entry of res.sso ?? []) {
        next[entry.kind] = Object.fromEntries(
          Object.entries(entry.config ?? {}).filter(([, v]) => typeof v === 'string')
        ) as Record<string, string>
        nextEnabled[entry.kind] = entry.enabled
        nextProvision[entry.kind] = entry.config?.autoProvision === true
        nextRole[entry.kind] = typeof entry.config?.defaultRole === 'string' ? entry.config.defaultRole : 'agent'
        const list = Array.isArray(entry.config?.domainAllowlist) ? (entry.config.domainAllowlist as string[]) : []
        nextDomains[entry.kind] = list.join(', ')
      }
      setDrafts(next)
      setEnabled(nextEnabled)
      setAutoProvision(nextProvision)
      setDefaultRole(nextRole)
      setDomains(nextDomains)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load single sign-on settings')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const save = async (kind: 'oidc' | 'saml') => {
    setBusy(true)
    try {
      const config: Record<string, unknown> = {
        ...(drafts[kind] ?? {}),
        autoProvision: autoProvision[kind] ?? false,
        defaultRole: defaultRole[kind] ?? 'agent',
        domainAllowlist: (domains[kind] ?? '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
      }
      const secrets: Record<string, string> = {}
      if (kind === 'oidc' && clientSecret.trim()) secrets.clientSecret = clientSecret.trim()
      if (kind === 'saml' && idpCertificate.trim()) secrets.idpCertificate = idpCertificate.trim()
      await api.put('/api/admin/sso', { kind, enabled: enabled[kind] ?? false, config, secrets })
      setClientSecret('')
      setIdpCertificate('')
      toast({ title: 'Single sign-on settings saved' })
      await load()
    } catch (err) {
      toast({ title: 'Could not save', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader><CardTitle>Single sign-on</CardTitle></CardHeader>
        <CardContent className="space-y-2" aria-busy="true">
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-9 w-full max-w-md" />
        </CardContent>
      </Card>
    )
  }

  const oidc = data?.sso?.find((s) => s.kind === 'oidc')
  const saml = data?.sso?.find((s) => s.kind === 'saml')

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-muted-foreground" aria-hidden />
            <div>
              <CardTitle>Single sign-on (SAML / OIDC)</CardTitle>
              <CardDescription>Let staff sign in with your identity provider. Passwords never reach this app.</CardDescription>
            </div>
          </div>
          <Badge className={oidc?.enabled || saml?.enabled ? 'bg-emerald-100 text-emerald-900' : 'bg-muted text-muted-foreground'}>
            {oidc?.enabled || saml?.enabled ? 'Enabled' : 'Off'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <Alert variant="destructive" role="alert" className="mb-4">
            <AlertDescription className="flex items-center justify-between gap-3">
              <span>{error}</span>
              <Button variant="outline" size="sm" onClick={() => void load()}>Retry</Button>
            </AlertDescription>
          </Alert>
        )}
        <Tabs defaultValue="oidc">
          <TabsList>
            <TabsTrigger value="oidc">OpenID Connect</TabsTrigger>
            <TabsTrigger value="saml">SAML 2.0</TabsTrigger>
          </TabsList>

          <TabsContent value="oidc" className="mt-4 space-y-4">
            <div className="flex items-center gap-3">
              <input
                id="sso-oidc-enabled"
                type="checkbox"
                className="h-4 w-4"
                checked={enabled.oidc ?? false}
                onChange={(e) => setEnabled({ ...enabled, oidc: e.target.checked })}
              />
              <Label htmlFor="sso-oidc-enabled" className="text-sm">Accept OIDC sign-ins</Label>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {OIDC_FIELDS.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label htmlFor={`sso-oidc-${f.key}`}>{f.label}</Label>
                  <Input
                    id={`sso-oidc-${f.key}`}
                    className="min-h-[44px]"
                    placeholder={f.placeholder}
                    value={drafts.oidc?.[f.key] ?? field(oidc, f.key)}
                    onChange={(e) => setDrafts({ ...drafts, oidc: { ...(drafts.oidc ?? {}), [f.key]: e.target.value } })}
                  />
                </div>
              ))}
              <div className="space-y-1.5">
                <Label htmlFor="sso-oidc-secret">Client secret</Label>
                <Input
                  id="sso-oidc-secret"
                  type="password"
                  className="min-h-[44px]"
                  placeholder={oidc?.secretPresent?.clientSecret ? 'Stored — type to replace' : 'client secret'}
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Stored encrypted on the server and never returned. Leave empty to keep the current one.</p>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="saml" className="mt-4 space-y-4">
            <div className="flex items-center gap-3">
              <input
                id="sso-saml-enabled"
                type="checkbox"
                className="h-4 w-4"
                checked={enabled.saml ?? false}
                onChange={(e) => setEnabled({ ...enabled, saml: e.target.checked })}
              />
              <Label htmlFor="sso-saml-enabled" className="text-sm">Accept SAML sign-ins</Label>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {SAML_FIELDS.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label htmlFor={`sso-saml-${f.key}`}>{f.label}</Label>
                  <Input
                    id={`sso-saml-${f.key}`}
                    className="min-h-[44px]"
                    placeholder={f.placeholder}
                    value={drafts.saml?.[f.key] ?? field(saml, f.key)}
                    onChange={(e) => setDrafts({ ...drafts, saml: { ...(drafts.saml ?? {}), [f.key]: e.target.value } })}
                  />
                </div>
              ))}
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="sso-saml-cert-file">Upload the identity provider certificate</Label>
                <Input
                  id="sso-saml-cert-file"
                  type="file"
                  accept=".pem,.crt,.cer,.txt,application/x-pem-file,text/plain"
                  className="min-h-[44px]"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    const reader = new FileReader()
                    reader.onload = () => setIdpCertificate(String(reader.result ?? ''))
                    reader.onerror = () => toast({ title: 'Could not read the certificate file', variant: 'destructive' })
                    reader.readAsText(file)
                  }}
                />
                <p className="text-xs text-muted-foreground">Accepts PEM, CRT or CER text. You can also paste it below.</p>
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="sso-saml-cert">Identity provider certificate (PEM)</Label>
                <textarea
                  id="sso-saml-cert"
                  className="min-h-[120px] w-full rounded-md border bg-background px-3 py-2 text-xs"
                  placeholder="-----BEGIN CERTIFICATE-----"
                  value={idpCertificate}
                  onChange={(e) => setIdpCertificate(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Used to verify the signature on the SAML response. Stored encrypted and never returned.</p>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <div className="mt-4 grid gap-3 md:grid-cols-2 border-t pt-4">
          <div className="space-y-1.5">
            <Label htmlFor="sso-auto-provision">Create accounts automatically</Label>
            <div className="flex items-center gap-3">
              <input
                id="sso-auto-provision"
                type="checkbox"
                className="h-4 w-4"
                checked={autoProvision.oidc ?? false}
                onChange={(e) => setAutoProvision({ ...autoProvision, oidc: e.target.checked, saml: e.target.checked })}
              />
              <span className="text-sm text-muted-foreground">Unknown identities get an account</span>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sso-default-role">Role for new accounts</Label>
            <select
              id="sso-default-role"
              className="h-11 w-full rounded-md border bg-background px-3 text-sm"
              value={defaultRole.oidc ?? 'agent'}
              onChange={(e) => setDefaultRole({ ...defaultRole, oidc: e.target.value, saml: e.target.value })}
            >
              <option value="admin">Admin</option>
              <option value="agent">Agent</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="sso-domains">Allowed e-mail domains (comma separated, empty = any)</Label>
            <Input
              id="sso-domains"
              className="min-h-[44px]"
              placeholder="example.com, subsidiary.example"
              value={domains.oidc ?? ''}
              onChange={(e) => setDomains({ ...domains, oidc: e.target.value, saml: e.target.value })}
            />
          </div>
        </div>

        <div className="mt-4 flex gap-2">
          <Button className="min-h-[44px]" disabled={busy} onClick={() => void save('oidc')}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Save OIDC
          </Button>
          <Button variant="outline" className="min-h-[44px]" disabled={busy} onClick={() => void save('saml')}>
            Save SAML
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export function ScimSettings() {
  const { toast } = useToast()
  const [state, setState] = useState<ScimState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [token, setToken] = useState('')

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ scim: ScimState }>('/api/admin/scim')
      setState(res.scim)
      setEnabled(res.scim.enabled)
      if (res.scim.url) setBaseUrl(res.scim.url.replace(/\/api\/scim\/v2$/, ''))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load SCIM settings')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const save = async (rotate: boolean) => {
    setBusy(true)
    try {
      const res = await api.put<{ scim: ScimState; token?: string }>('/api/admin/scim', {
        enabled,
        baseUrl: baseUrl || window.location.origin,
        rotate,
      })
      setToken(res.token ?? '')
      toast({ title: res.token ? 'New SCIM token issued' : 'SCIM settings saved', description: res.token ? 'Copy the token now — it is shown only once.' : undefined })
      await load()
    } catch (err) {
      toast({ title: 'Could not save', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
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

  if (loading) {
    return (
      <Card>
        <CardHeader><CardTitle>SCIM provisioning</CardTitle></CardHeader>
        <CardContent className="space-y-2" aria-busy="true">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-9 w-full max-w-md" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-muted-foreground" aria-hidden />
            <div>
              <CardTitle>SCIM 2.0 provisioning</CardTitle>
              <CardDescription>Let your identity provider create and deactivate staff accounts automatically.</CardDescription>
            </div>
          </div>
          <Badge className={state?.enabled ? 'bg-emerald-100 text-emerald-900' : 'bg-muted text-muted-foreground'}>
            {state?.enabled ? 'Enabled' : 'Off'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription className="flex items-center justify-between gap-3">
              <span>{error}</span>
              <Button variant="outline" size="sm" onClick={() => void load()}>Retry</Button>
            </AlertDescription>
          </Alert>
        )}
        <div className="flex items-center gap-3">
          <input
            id="scim-enabled"
            type="checkbox"
            className="h-4 w-4"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <Label htmlFor="scim-enabled" className="text-sm">Accept SCIM requests</Label>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="scim-url">SCIM base URL</Label>
          <Input
            id="scim-url"
            className="min-h-[44px]"
            placeholder="https://app.example.com"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            The endpoint is <code className="rounded bg-muted px-1">{state?.url || `${baseUrl || window.location.origin}/api/scim/v2`}</code>
          </p>
        </div>
        {state?.tokenPresent && !token && (
          <p className="text-sm text-muted-foreground">A bearer token is stored. Issue a new one to hand it to your provider.</p>
        )}
        {token && (
          <div className="rounded-md border p-3 space-y-2">
            <p className="text-sm font-medium">Copy the token now — it is shown only once</p>
            <div className="flex items-center gap-2">
              <code className="text-xs break-all rounded bg-muted px-2 py-1 flex-1">{token}</code>
              <Button type="button" variant="outline" size="sm" aria-label="Copy SCIM token" onClick={() => void copy(token, 'SCIM token')}>
                <Copy className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          </div>
        )}
        <div className="flex gap-2">
          <Button className="min-h-[44px]" disabled={busy} onClick={() => void save(false)}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            <Plug className="h-4 w-4" aria-hidden />
            Save
          </Button>
          <Button variant="outline" className="min-h-[44px]" disabled={busy} onClick={() => void save(true)}>
            Issue new token
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
