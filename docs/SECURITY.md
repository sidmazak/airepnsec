# Security — AI Secretary

Threat model in one line: a single-organization, self-hosted business app whose highest-value
assets are customer PII, provider API keys, and financial records; principal risks are auth
bypass, cross-org leakage, secret exfiltration, and unauthenticated webhook abuse.

## 1. Authentication

| Aspect | Design |
|---|---|
| Method | Email + password credentials (first-party; no OAuth in this build) |
| Password hashing | Node `crypto.scrypt` with per-user random salt; verification via `timingSafeEqual`. Hash + salt stored in `User.passwordHash`; never logged, never sent to client |
| Session | Opaque session payload + **HMAC-SHA256 signature** (server secret from env). No JWT; no client-readable session blob beyond user id/name/role |
| Cookie flags | `httpOnly`, `sameSite=strict`, `secure` in production, path-scoped; expiry server-enforced (signed expiry included in payload) |
| Login hardening | Constant-time comparisons; generic error messages (no user-exists oracle); login + failed logins audited |
| Note | `next-auth` is present in the dependency manifest from the scaffold but is **not** used by this build's auth; the purpose-built scrypt+HMAC path above is the mechanism |

## 2. RBAC

Roles: `OWNER > ADMIN > AGENT > VIEWER` (see [DATA_MODEL.md](./DATA_MODEL.md) `Membership`).

| Action | Owner | Admin | Agent | Viewer |
|---|---|---|---|---|
| View dashboard/bookings/invoices/ledger | ✅ | ✅ | ✅ | ✅ |
| Customers CRUD, bookings, invoices, record payments, knowledge | ✅ | ✅ | ✅ | ❌ |
| Verify payments, run collections automations | ✅ | ✅ | ✅ (per policy) | ❌ |
| Manage users & roles | ✅ | ✅ | ❌ | ❌ |
| AI providers/keys, channels, automations config | ✅ | ✅ | ❌ | ❌ |
| Ledger adjustments/reversals, void invoices | ✅ | ✅ | ❌ | ❌ |
| Export/backup, delete org data | ✅ | ✅ | ❌ | ❌ |
| Delete organization, transfer ownership | ✅ | ❌ | ❌ | ❌ |

Enforcement: route handlers resolve session → membership → role and assert permission **before**
calling business services; services re-assert for sensitive mutations (defense in depth).

## 3. Organization isolation

- Every business query includes `organizationId` from the verified session — never from client
  bodies or query strings alone.
- IDs are cuids (non-enumerable); cross-org access returns 404 (not 403) to avoid existence leaks.
- Exports, backups, dashboards, and ledger views are org-filtered by construction.
- Test requirement: attempting to read another org's customer/booking/invoice by id must fail —
  see [TEST_PLAN.md](./TEST_PLAN.md).

## 4. Secrets & provider keys

- Provider API keys (LLM, payments) are stored **AES-256-GCM encrypted** (`ProviderConfig.encryptedKey`)
  with a server-held key (`SERVER_ENCRYPTION_KEY` env). Unique IV per encryption; auth tag verified
  on decrypt.
- The plaintext key is **write-only**: after save, API responses return only provider name, masked
  hint (e.g. `sk-…last4`), and status. There is no "reveal key" endpoint.
- Server-held secrets never appear in client bundles: `src/lib/db`, `src/lib/ai`, integrations and
  crypto helpers are server-only modules.
- Encryption key rotation: decrypt-with-old → re-encrypt-with-new procedure documented for
  operators (run offline, audited).

## 5. Input validation

- **zod schemas at every API boundary** (route handlers); unknown fields rejected; sizes and
  string lengths bounded (CSV imports bounded by row count and file size).
- Business services validate again where math matters (amounts > 0, dates in range, currency
  match) — validation is not trusted to a single layer.
- Assistant tool args validated server-side per-tool before execution
  ([ARCHITECTURE.md](./ARCHITECTURE.md) §4). The LLM cannot inject unvalidated writes.

## 6. Rate limiting

- In-memory token bucket in this build: per-IP on auth and public endpoints; per-session on
  expensive endpoints (assistant turns, imports, exports).
- 429 responses with `Retry-After`; repeated abuse of auth endpoints triggers temporary lockout
  windows.
- Honest limitation: in-memory limiter is per-process; multi-instance production needs a shared
  store (**Planned**, DB-backed) — documented, not hidden.

## 7. Security headers

Set by middleware (and by Caddy at the edge in both sandbox and production):

| Header | Value |
|---|---|
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | camera=(), geolocation=(), microphone=(self) — microphone allowed for the browser voice test only |
| `Content-Security-Policy` | default-src 'self'; connect-src 'self' (+ configured local AI origin); no third-party script origins |
| `Strict-Transport-Security` | Production/TLS termination only |

## 8. Webhook security

- Generic adapter accepts `POST /api/webhooks/:provider`; signature verified as **HMAC-SHA256 over
  the raw body** with the per-provider secret (stored encrypted like other keys), plus a timestamp
  header with tolerance window (replay protection).
- Events are persisted to `WebhookEvent` with `signatureVerified` before processing; dedupe by
  `(provider, eventId)` — duplicates are recorded `SKIPPED_DUPLICATE` and change nothing.
- Unverified signatures are logged and rejected with 401; no state change occurs.

## 9. Audit events

`AuditEvent` rows (written in the same transaction as the change) cover: logins/failed logins,
role changes, booking create/cancel, invoice issue/void, payment verify, ledger
adjustment/reversal, AI mode changes, provider key changes (never the key itself), automation
config changes, exports/backups, opt-out changes. Actor is `USER`, `SYSTEM`, or `ASSISTANT`
(with the tool call persisted in the transcript).

## 10. Data export & deletion

- **Export** (`GET /api/admin/backup`): org-scoped JSON of all business tables, streamed with an
  audited `data.export` event. Excludes secrets (encrypted keys are omitted, not exported).
- **Deletion**: org-scoped purge by Owner (customers, conversations, ledger, documents) with a
  confirmation flow; deletion is itself audited (metadata only — no PII in the audit after purge).
- **Backups**: JSON export today; `infra/backup.sh` (SQLite/Postgres snapshot + retention) ships
  with production packaging — **Planned**, not present in this sandbox build.
- Restore procedure: stop app → restore DB snapshot → verify with smoke suite
  ([TEST_PLAN.md](./TEST_PLAN.md) §curl) → re-run provider health checks.

## 11. Local-only mode guarantees

- `local-only` AI mode blocks cloud provider calls at the policy gate before every call — a blocked
  call raises `POLICY_BLOCKED` (audited), never silently reroutes.
- No telemetry, analytics SDKs, font CDNs, or error-reporting services exist in the codebase.
- Outbound-message delivery is not implemented at all (Deferred), so nothing leaves the box except
  what the operator explicitly configures (e.g. automation webhook action).

## 12. Consent & opt-out for outbound messages

- Customers carry consent flags (`consentTransactional`, `consentMarketing`) and per-channel
  opt-outs (`Customer.optedOut_Json`).
- Opt-out is honored at **creation** of an outbound message and re-checked at **send time** by the
  automation runner; suppressed messages are recorded `OPTED_OUT` (visible, auditable — not silent).
- Reminder automations dedupe via `dedupeKey` so an opted-out or already-reminded customer is
  never spammed by rule re-runs.
- Inbound "STOP"-style opt-out processing is modeled on the same tables (**Planned** with the
  delivery integrations).

## 13. Known gaps (honest)

- In-memory rate limiting (per-process) — shared-store limiter Planned.
- No CSRF token: mitigated by `sameSite=strict` + JSON-only, no-cookie-on-third-party design; a
  double-submit token is Planned for defense in depth.
- Session revocation list is in-memory (restart clears); persistent revocation Planned.
- 2FA implemented (TOTP, RFC 6238, SHA1, 30s, ±1 step) via `src/lib/security/totp.ts`; per-user enrollment/disable via `/api/auth/2fa/*`; login requires the current code when enabled; secret stored AES-256-GCM encrypted; disable requires password + a current code. Remaining: SSO (SAML/OIDC) and persistent session revocation.
