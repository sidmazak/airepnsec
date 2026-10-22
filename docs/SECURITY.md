# Security — AI Secretary

Threat model in one line: a self-hosted business app whose highest-value assets are customer PII,
provider API keys and financial records; principal risks are auth bypass, cross-org leakage, secret
exfiltration, webhook abuse and concurrent-turn corruption.

## 1. Authentication

| Aspect | Design |
|---|---|
| Method | Email + password (first-party); optional TOTP second factor |
| Password hashing | Node `crypto.scrypt` (N=16384, r=8, p=1) with per-user random salt; `timingSafeEqual`; hash never logged or returned |
| Session | Random 48-byte token (`id.secret`); only SHA-256 of the token is stored in `Session.tokenHash`; expiry 14 days; `revokedAt` supported |
| Cookie | `ais_session`, `HttpOnly`, `SameSite=Strict`, `Secure` when `NODE_ENV=production`, path `/` |
| Login hardening | Generic errors; per-email 10/min + per-IP 30/min limits; audit success/failure; TOTP code required when enabled |
| 2FA | RFC 6238 TOTP (SHA1, 30 s, ±1 step); encrypted secret; enrollment requires password; disable requires password + current code |
| Revocation | Logout revokes the current session row; `POST /api/auth/sessions/revoke-all` revokes every other session. Persistent across restarts. |

There is no OAuth/SSO, no password-reset email flow, and no user-management API in this build.

## 2. RBAC

Roles live on `User.role` (owner/admin/agent/viewer); every request resolves the user and org from
the session, never from client input. There is one organization per deployment in practice; all
business rows still carry `orgId` and every query filters it.

| Action | Owner/Admin | Agent | Viewer |
|---|---|---|---|
| Dashboard, bookings, customers, invoices, conversations | ✅ | ✅ | read-only |
| Create/change bookings, customers, invoices, record/verify payments | ✅ | ✅ | ❌ |
| Knowledge, data sources, automations, providers, integrations, settings | ✅ | ❌ | ❌ |
| Ledger reversal, void invoice, export/backup | ✅ | ❌ | ❌ |
| Telephony line configuration | ✅ | ❌ | read-only |
| Security/2FA/revoke sessions | ✅ (any signed-in user for own account) | ✅ | ✅ |

Nav visibility mirrors server gates. Routes default to `withAuth` (any signed-in role) and pass
`{ roles }` for restricted mutations; sensitive services re-check ownership.

## 3. Organization isolation

- Every business query includes `organizationId` from the verified session.
- IDs are cuids; cross-org access returns 404 to avoid existence leaks.
- Exports/backups/dashboards/ledger views are org-filtered by construction.
- `requireCustomer` and service helpers re-check `orgId` before mutating.

## 4. Secrets & provider keys

- Provider API keys and integration credentials are **AES-256-GCM encrypted** (`v1:iv:tag:ciphertext`)
  with a key derived from `APP_SECRET` (SHA-256) or, if unset, a generated `.data/secret.key` (0600).
- Plaintext keys are write-only: responses expose only `apiKeyPresent` / `configured` booleans.
- There is no reveal-key endpoint.
- Rotating `APP_SECRET`/the key file **does not re-encrypt** existing credentials; plan rotation as a
  credential re-entry exercise (see SELF_HOSTING.md).
- Server-only modules are not imported by client components.

## 5. Input validation

- zod schemas at API boundaries (`parseBody`); unknown fields are rejected by default object schemas;
  sizes/lengths are bounded.
- Business services re-validate amounts, dates, currencies and org ownership.
- Assistant tool arguments are parsed per-tool before execution; invalid args become observations,
  never partial writes.
- Data-source SQL must be a single read-only `SELECT`/`WITH`; blocklist plus statement/comment checks.

## 6. Rate limiting

- In-memory sliding-window limiter, per `clientIp:path`. `withAuth` defaults to 120/min; `withPublic`
  defaults to 60/min and accepts per-route overrides.
- Login adds per-email 10/min and per-IP 30/min. Telephony webhooks use 300/min (incoming voice,
  SMS, WhatsApp) or 600/min (gather/status) to survive call storms.
- 429 responses; no `Retry-After` header is emitted.
- Honest limitation: the limiter is per-process. Multi-instance deployments need a shared store.

## 7. Security headers

Set centrally in `next.config.ts` for `/(.*)`:

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), geolocation=(), microphone=(self)` |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` |
| `Strict-Transport-Security` | production only, 1 year + includeSubDomains |
| `Content-Security-Policy` | production only; `default-src 'self'`, inline scripts/styles allowed for the Next runtime, `connect-src 'self' https: wss:`, `frame-ancestors 'none'` |

There is no `middleware.ts`; headers are applied by Next config. A reverse proxy may add its own
HSTS/CSP but must not weaken these.

## 8. Webhook security

- **Payment (generic):** `x-signature` = hex HMAC-SHA256 of the raw body with the org webhook secret;
  invalid signatures are stored as rejected and change nothing; events deduped by unique `eventId`.
- **Stripe:** `Stripe-Signature: t=…,v1=…` HMAC-SHA256 over `"<t>.<rawBody>"`, timing-safe; event-id dedupe.
- **Twilio Voice/SMS/WhatsApp:** `X-Twilio-Signature` HMAC-SHA1 over the full URL + sorted params;
  candidate URL list handles proxies; every attempt persisted in `WebhookEvent` with `signatureValid`.
- **Outbound webhooks:** hex HMAC-SHA256 (`x-signature`) when a secret is configured; literal `none`
  otherwise, so receivers can tell signed from unsigned.

## 9. Audit events

`AuditEvent` covers logins/failures, 2FA changes, session revocation, bookings, invoices, payments,
ledger reversals, settings/provider changes (metadata only), integrations, automations, exports,
backups, telephony events and outbound dispatch. Audit rows are append-only; they are written by the
services/routes after the mutation and are not part of the same DB transaction for every operation
(documented, not claimed otherwise). Actor is `user`, `ai`, `system` or `webhook`.

## 10. Data export, backup & deletion

- **Export** (`GET /api/admin/export`): JSON attachment with org data; provider configs, app settings
  (webhook secret), sessions and password hashes are excluded. Audited.
- **Backup** (`POST /api/admin/backup`): SQLite `VACUUM INTO backups/backup-<ts>.db`; Postgres installs
  must use `pg_dump` (the endpoint would fail honestly on Postgres). Audited.
- **Deletion:** there is **no organization-wide purge/delete endpoint** in this build. Delete rows via
  the UI/API individually or remove the database volume; take a backup first.
- Restore: stop the app, replace the SQLite file (or restore the Postgres dump), run
  `npx prisma db push`, then verify health/providers.

## 10a. Local models, OAuth tokens and backups

- **Local speech models** live in `.models/` (git-ignored) and are downloaded from the Hugging
  Face CDN on demand. They contain no secrets and no tenant data — only model weights. The
  catalog is a fixed allow-list; a model id outside the catalog is rejected (`422 bad_model`).
- **Microsoft 365 / Google OAuth refresh tokens** are stored AES-256-GCM encrypted in
  `Integration.secretsEnc` together with the client secret and are never returned by any route.
  Only `configured: boolean` is exposed. The OAuth `state` nonce is single-use and expires after
  10 minutes.
- **Backups** are written with file mode 0600 into `backups/`; the folder is git-ignored and must
  be protected like the database itself (it contains the same business data). The `APP_SECRET` is
  never part of a backup — without it, encrypted credentials stay encrypted.

## 11. Local-only mode guarantees

- `local_only` blocks external `openai_compatible` calls at `assertAiPolicy`; endpoints on localhost,
  private ranges, link-local, `.local`/`.internal` and `host.docker.internal` are treated as local.
- Blocked calls raise an explicit error (no silent reroute to cloud).
- No telemetry/analytics/crash reporting/font CDNs. Outbound traffic only goes to integrations/AI
  endpoints the operator configures, plus the one-time ONNX model download (if not cached).
- Outbound email/SMS/WhatsApp/webhook delivery **is implemented** and must be configured deliberately.

## 12. Consent & opt-out

- `Customer.consentContact` (service communications) and `Customer.optOut` (absolute outbound block).
- Checked when queueing messages and again at dispatch/send time; opted-out customers get no outbound
  SMS/WhatsApp/email. Inbound messages are still stored.
- There is no automatic inbound "STOP" parser; operators set `optOut` in the customer UI/API.
- Reminder dedupe uses unique `dedupeKey` values.

## 13. Known gaps (honest)

- In-memory rate limiting (per-process); shared-store limiter not implemented.
- CSRF relies on `SameSite=Strict` + custom `x-requested-with: ais` header; no double-submit token.
- `x-forwarded-for` is trusted as-is. Behind a proxy, overwrite it at the edge; if exposed directly it
  is spoofable (affects rate-limit keys, not authentication).
- DNS-rebind TOCTOU remains for data-source HTTP fetches (resolution and fetch are separate; no IP
  pinning). Data-source and outbound-webhook URLs are SSRF-guarded at request/test time; private
  webhook targets require an explicit owner/admin `allowPrivate` opt-in.
- No automated role-matrix/concurrency test yet; see TEST_GAPS.
- No SSO, inbound email, vision or reranking.
