import { db } from '@/lib/db'
import { parseJson } from '@/lib/org'
import { decryptSecret, encryptSecret, hashPassword, randomToken } from '@/lib/crypto'
import { audit } from '@/lib/audit'
import {
  oidcConfigSchema,
  samlConfigSchema,
  resolveExternalIdentity,
  normalizeEmail,
  type OidcConfig,
  type SamlConfig,
  type SsoKind,
  type ExternalIdentity,
} from '@/lib/security/sso'

/**
 * Organisation-level federated sign-in: configuration storage, account linking
 * and provisioning.
 *
 * The protocol plumbing lives in `src/lib/security/sso.ts` (pure, testable) and
 * `src/lib/security/saml.ts` (samlify wrapper). This module owns the database.
 */

export type SsoConfigRow = {
  id: string
  orgId: string
  kind: string
  enabled: boolean
  config: string
  secrets: string
  createdAt: Date
  updatedAt: Date
}

export type LoadedSsoConfig = {
  id: string
  kind: SsoKind
  enabled: boolean
  config: Record<string, unknown>
  secrets: Record<string, string>
}

export async function loadSsoConfig(orgId: string, kind: SsoKind): Promise<LoadedSsoConfig | null> {
  const row = await db.ssoConfig.findUnique({ where: { orgId_kind: { orgId, kind } } })
  if (!row) return null
  const rawSecrets = parseJson<Record<string, string>>(row.secrets, {})
  const secrets: Record<string, string> = {}
  for (const [key, value] of Object.entries(rawSecrets)) {
    secrets[key] = value ? decryptSecret(value) : ''
  }
  return {
    id: row.id,
    kind,
    enabled: row.enabled,
    config: parseJson<Record<string, unknown>>(row.config, {}),
    secrets,
  }
}

export async function listSsoConfigs(orgId: string): Promise<LoadedSsoConfig[]> {
  const rows = await db.ssoConfig.findMany({ where: { orgId } })
  const out: LoadedSsoConfig[] = []
  for (const row of rows) {
    const kind = row.kind as SsoKind
    const loaded = await loadSsoConfig(orgId, kind)
    if (loaded) out.push(loaded)
  }
  return out
}

/** Persist a configuration. Secrets are encrypted at rest and never returned. */
export async function saveSsoConfig(params: {
  orgId: string
  kind: SsoKind
  enabled: boolean
  config: Record<string, unknown>
  secrets?: Record<string, string>
  actorId: string
}): Promise<void> {
  const encrypted: Record<string, string> = {}
  for (const [key, value] of Object.entries(params.secrets ?? {})) {
    if (value) encrypted[key] = encryptSecret(value)
  }
  const existing = await db.ssoConfig.findUnique({ where: { orgId_kind: { orgId: params.orgId, kind: params.kind } } })
  const data = {
    enabled: params.enabled,
    config: JSON.stringify(params.config ?? {}),
    secrets: JSON.stringify(encrypted),
  }
  if (existing) {
    // Keep previously stored secrets when the operator does not resend them.
    const previous = parseJson<Record<string, string>>(existing.secrets, {})
    const merged = { ...previous }
    for (const [key, value] of Object.entries(encrypted)) merged[key] = value
    await db.ssoConfig.update({ where: { id: existing.id }, data: { ...data, secrets: JSON.stringify(merged) } })
  } else {
    await db.ssoConfig.create({ data: { orgId: params.orgId, kind: params.kind, ...data } })
  }
  await audit({
    orgId: params.orgId,
    actorType: 'user',
    actorId: params.actorId,
    action: 'sso.config_updated',
    entity: 'sso_config',
    entityId: params.kind,
    meta: { kind: params.kind, enabled: params.enabled, secretKeys: Object.keys(encrypted) },
  })
}

export function parseOidcConfig(config: Record<string, unknown>): OidcConfig {
  return oidcConfigSchema.parse(config)
}

export function parseSamlConfig(config: Record<string, unknown>): SamlConfig {
  return samlConfigSchema.parse(config)
}

/**
 * Resolve a SAML configuration, fetching IdP metadata from a URL if provided.
 * This merges the fetched metadata (entityId, SSO URL, certificate) into the config.
 */
export async function resolveSamlConfig(config: Record<string, unknown>): Promise<SamlConfig> {
  const raw = samlConfigSchema.parse(config)
  if (raw.idpMetadataUrl) {
    const { fetchAndParseIdpMetadata } = await import('@/lib/security/saml')
    const meta = await fetchAndParseIdpMetadata(raw.idpMetadataUrl)
    return {
      ...raw,
      idpEntityId: meta.entityId,
      idpSsoUrl: meta.ssoUrl,
      idpCertificate: meta.certificate,
    }
  }
  return raw
}

/** Common (non-protocol) policy fields shared by OIDC and SAML. */
export function commonPolicy(config: {
  autoProvision?: boolean
  defaultRole?: string
  domainAllowlist?: string[]
  linkExisting?: boolean
  requireVerifiedEmail?: boolean
}) {
  return {
    autoProvision: config.autoProvision ?? false,
    defaultRole: config.defaultRole ?? 'agent',
    domainAllowlist: config.domainAllowlist ?? [],
    linkExisting: config.linkExisting ?? true,
    requireVerifiedEmail: config.requireVerifiedEmail ?? true,
  }
}

export type SsoSignInResult =
  | { ok: true; user: { id: string; email: string; name: string; role: string }; created: boolean }
  | { ok: false; reason: string; code: string }

/**
 * Turn a verified external identity into a local session.
 *
 * Linking is only possible inside the same organisation and only for an
 * identity the provider has verified. Provisioning creates an account with a
 * random password — the user signs in through the provider, not with a
 * password that nobody knows.
 */
export async function signInWithExternalIdentity(params: {
  orgId: string
  kind: SsoKind
  identity: ExternalIdentity
  policy: ReturnType<typeof commonPolicy>
}): Promise<SsoSignInResult> {
  const email = normalizeEmail(params.identity.email ?? '')
  const [existingBySubject, existingByEmail] = await Promise.all([
    params.identity.subject
      ? db.user.findFirst({
          where: { orgId: params.orgId, ssoProvider: params.kind, ssoSubject: params.identity.subject },
          select: { id: true, orgId: true, active: true },
        })
      : null,
    email
      ? db.user.findFirst({
          where: { orgId: params.orgId, email },
          select: { id: true, orgId: true, active: true },
        })
      : null,
  ])

  const decision = resolveExternalIdentity({
    identity: params.identity,
    existing: existingByEmail,
    existingBySubject,
    orgId: params.orgId,
    config: params.policy,
  })

  if (decision.action === 'reject') {
    return { ok: false, reason: decision.reason, code: 'sso_rejected' }
  }

  if (decision.action === 'link') {
    const user = await db.user.update({
      where: { id: decision.userId },
      data: { ssoProvider: params.kind, ssoSubject: params.identity.subject, lastLoginAt: new Date() },
      select: { id: true, email: true, name: true, role: true },
    })
    await audit({
      orgId: params.orgId,
      actorType: 'user',
      actorId: user.id,
      action: 'auth.sso_login',
      entity: 'user',
      entityId: user.id,
      meta: { kind: params.kind, linked: true },
    })
    return { ok: true, user, created: false }
  }

  // Provisioning — the local password is random and never shared.
  const created = await db.user.create({
    data: {
      orgId: params.orgId,
      email,
      name: decision.name,
      role: decision.role,
      passwordHash: hashPassword(randomToken(24)),
      ssoProvider: params.kind,
      ssoSubject: params.identity.subject,
      lastLoginAt: new Date(),
    },
    select: { id: true, email: true, name: true, role: true },
  })
  await audit({
    orgId: params.orgId,
    actorType: 'user',
    actorId: created.id,
    action: 'auth.sso_login',
    entity: 'user',
    entityId: created.id,
    meta: { kind: params.kind, linked: false, provisioned: true, role: created.role },
  })
  return { ok: true, user: created, created: true }
}

/** Public (secret-free) view of a configuration for the admin UI. */
export function publicSsoConfig(loaded: LoadedSsoConfig): Record<string, unknown> {
  const config = { ...loaded.config }
  const secrets = Object.fromEntries(Object.keys(loaded.secrets).map((key) => [key, Boolean(loaded.secrets[key])]))
  return {
    kind: loaded.kind,
    enabled: loaded.enabled,
    configured: Object.values(secrets).some(Boolean),
    secretPresent: secrets,
    config,
  }
}

/* ------------------------------------------------------------------ */
/* organisation + discovery helpers                                    */
/* ------------------------------------------------------------------ */

/**
 * Resolve the organisation a public sign-in flow belongs to. Self-hosted
 * deployments run a single organisation; `?org=<slug>` selects one explicitly.
 */
export async function resolveSsoOrg(searchParams: URLSearchParams): Promise<{ id: string; slug: string; name: string } | null> {
  const slug = searchParams.get('org')?.trim()
  const orgs = await db.organization.findMany({ select: { id: true, slug: true, name: true }, take: 10 })
  if (!orgs.length) return null
  if (slug) return orgs.find((o) => o.slug === slug) ?? null
  return orgs[0]
}

type DiscoveryCacheEntry = { at: number; value: Awaited<ReturnType<typeof import('@/lib/security/sso').fetchOidcDiscovery>> }
const discoveryCache = new Map<string, DiscoveryCacheEntry>()
const DISCOVERY_TTL_MS = 10 * 60_000

/** Discovery documents are cached for ten minutes to spare the provider. */
export async function discoverOidc(issuer: string): Promise<Awaited<ReturnType<typeof import('@/lib/security/sso').fetchOidcDiscovery>>> {
  const key = issuer.replace(/\/+$/, '')
  const cached = discoveryCache.get(key)
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.value
  const { fetchOidcDiscovery } = await import('@/lib/security/sso')
  const value = await fetchOidcDiscovery(key)
  discoveryCache.set(key, { at: Date.now(), value })
  return value
}
