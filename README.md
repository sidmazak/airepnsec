# AI Secretary

A self-hosted, local-first AI business assistant: an AI receptionist for chat, SMS, WhatsApp and
phone calls; real bookings; customers; invoices; verified payments; an append-only ledger; approved
knowledge/RAG; and native automations — with **BYOK** cloud models or fully local AI.

Designed for a **single organization** deployment: salons, clinics, contractors, apartment rentals,
car rentals, and similar appointment/rental businesses.

[Quick start](#quick-start-development) · [Self-hosting](#self-hosting-production) ·
[Architecture](#architecture) · [Operations](#reliability--operations) ·
[Security](#security) · [Docs](#documentation-map)

> **Production honesty.** The business core, auth, ledger, outbox, workers and unit suite are
> verified in this environment. Both Docker profiles (PostgreSQL and SQLite) were built and
> smoke-tested on 2026-10-22 (health/readiness, schema boot, demo seed, login, ONNX embeddings).
> External services (Twilio/Stripe/SMTP/CalDAV/pg/mysql) still require your own credentials. See
> [Known limitations](#known-limitations) and [docs/TEST_PLAN.md](docs/TEST_PLAN.md). This is not a
> multi-tenant SaaS: one organization per install, but it has team roles, invitations and
> SAML/OIDC SSO + SCIM in this build.

## What it does

| Area | Capability |
|---|---|
| Receptionist | Text chat, public web chat, browser voice console, inbound SMS, WhatsApp, Twilio Voice; one validated tool loop for all channels |
| Bookings | Real availability engine (hours, staff, buffers, capacity, holidays), transactional conflict detection, reschedule/cancel/status |
| Money | Invoices with line items, verified payments vs. customer claims, idempotent webhooks, append-only ledger, reversals, statements |
| Knowledge | Approved FAQ/docs, hybrid semantic + BM25 retrieval, built-in local ONNX embeddings, BYO databases/JSON, PDF/DOCX/HTML/Markdown import, and a robots/SSRF-aware website crawler |
| Automations | Triggers, conditions, delays, quiet hours, dedupe, retries, caps, test mode, run history, leased worker |
| Integrations | SMTP or 5 email APIs, Twilio SMS/WhatsApp/Voice, 8 SMS gateways, Stripe/Square Payment Links + signed webhooks, QuickBooks/Xero/MYB accounting push, Shopify/WooCommerce/Wix/Mailchimp contact sync, signed outbound webhooks, CalDAV + Google Calendar + Microsoft 365 two-way sync |
| Operations | Dashboard, audit trail, outbox status, AI usage/cost estimates, diagnostics, encrypted secrets, 2FA, scheduled backups with retention |

### AI providers (no proprietary SDK)

- **LLM:** local Ollama, any OpenAI-compatible endpoint (OpenAI, Groq, Together, vLLM, LM Studio,
  llama.cpp server, …), Anthropic, Google Gemini, or Azure OpenAI. Credentials are configured in
  the UI, encrypted at rest, and model discovery is per capability.
- **Embeddings:** built-in local neural model (`all-MiniLM-L6-v2`, 384-d ONNX) by default; optional
  Ollama or OpenAI-compatible embeddings.
- **Speech:** browser Web Speech fallback, OpenAI-compatible `/audio/transcriptions` and
  `/audio/speech` for server STT/TTS, or fully local ONNX models (Whisper / MMS-TTS) that are
  downloaded on demand into `.models/` and never send audio off the machine.
- **Also:** server-side streaming (SSE), provider-native tool calling with a JSON-protocol
  fallback, optional reranking and vision, a hardware probe with a model catalog, and provider
  presets for the common cloud endpoints.
- **Policy:** `local_only` blocks cloud endpoints; `hybrid` and `cloud_first` permit configured
  endpoints. There is no bundled cloud account and no silent deterministic fallback.

## Architecture

Single Next.js 16 App Router project. UI and API ship together; the background worker runs in the
same Node process through the instrumentation hook, protected by DB leases.

```mermaid
flowchart LR
  subgraph Clients
    B[Admin SPA<br/>browser]
    C[Public web chat<br/>visitor]
    T[Twilio<br/>voice / SMS / WhatsApp]
    P[Payment providers]
  end

  subgraph "Next.js application"
    API[Route handlers<br/>/api/**]
    AUTH[Session · RBAC · CSRF<br/>rate limits · zod]
    SVC[Business services<br/>bookings · invoices · payments · ledger]
    AI[Receptionist tool loop<br/>validated tools only]
    INT[Integration adapters<br/>SMTP/email APIs · Twilio/SMS · Stripe/Square · accounting · commerce · CalDAV · webhooks]
    WK[Workers<br/>automation · outbox · datasource sync]
  end

  DB[(Prisma<br/>SQLite or PostgreSQL)]
  LLM[Ollama / OpenAI-compatible / Anthropic / Gemini / Azure]
  EXT[SMTP/email APIs · Twilio/SMS<br/>Stripe/Square · accounting · commerce<br/>CalDAV · webhook targets]

  B --> API
  C --> API
  T --> API
  P --> API
  API --> AUTH --> SVC
  AUTH --> AI
  AUTH --> INT
  SVC --> DB
  AI --> DB
  AI --> LLM
  INT --> DB
  INT --> EXT
  WK --> SVC
  WK --> INT
  WK --> DB
```

### Request lifecycle

```mermaid
sequenceDiagram
  participant C as Client
  participant R as Route handler
  participant A as Auth / RBAC
  participant S as Business service
  participant D as Database
  C->>R: HTTPS request (cookie + CSRF header)
  R->>R: Rate limit, parse JSON, zod validate
  R->>A: Resolve session, org and role
  A-->>R: Context or 401/403
  R->>S: Typed service call
  S->>D: Prisma transaction (org-scoped)
  S->>D: Audit event
  D-->>S: Result
  S-->>R: Domain result
  R-->>C: JSON (typed status/code)
```

### Inbound message / call flow

```mermaid
sequenceDiagram
  participant P as Provider or visitor
  participant W as Webhook / public route
  participant L as Conversation lock
  participant AI as Receptionist
  participant T as Validated tools
  participant O as Outbox / provider
  P->>W: Signed webhook or chat message
  W->>W: Verify signature / rate limit
  W->>L: Acquire per-conversation turn lock
  alt lock busy
    L-->>W: 409 conversation_busy
  else acquired
    W->>AI: Run turn with org context
    AI->>T: Check availability / create booking / claim payment
    T-->>AI: Tool observation
    AI-->>W: Reply or escalation
    W->>O: Immediate reply or queued outbox row
    W->>L: Release lock
  end
```

### Background workers

```mermaid
flowchart TD
  I[instrumentation.register] --> A[Automation tick<br/>every 60s]
  I --> O[Outbox dispatch<br/>every 30s]
  I --> D[Datasource auto-sync<br/>every 5m]
  A --> L{WorkerLease<br/>single-flight}
  O --> L
  D --> L
  L -->|acquired| J[Do work + record result]
  L -->|busy| S[Skip this tick]
  J --> DB[(Database)]
```

Workers recover after a crash when their lease TTL expires. Manual `Run now` endpoints use the same
leases and return `409 worker_busy` instead of racing. Set `AIS_DISABLE_WORKERS=1` on web-only
replicas and run one worker-enabled instance.

## Quick start (development)

Requirements: **Node.js 24+**, npm, and SQLite (built in through Prisma).

```bash
npm install
cp .env.example .env        # defaults work for a first run
npm run db:push
npm run dev                 # http://localhost:3000
```

First run: create the owner account, or click **Try the demo workspace**
(`demo@aisecretary.local` / `demo-1234`, clearly labeled demo data). The 8-step setup wizard covers
business profile, services/staff, imports, knowledge, AI provider, channels, collections, and an
end-to-end test before activation.

Verify the install:

```bash
curl -s http://localhost:3000/api/health          # liveness
curl -s http://localhost:3000/api/health/ready    # DB readiness
npx tsc --noEmit -p tsconfig.json
npm run lint
npm run test:unit
node scripts/smoke.mjs     # 24 end-to-end checks against the running dev server
```

### Minimum useful flow (no cloud AI key required)

Create a customer + service → book through the real engine → create an invoice → record a
**verified** payment → inspect the ledger. This flow works with the AI disabled. Then configure a
model under AI Providers and chat in the Inbox; the assistant uses the same booking and payment
services as the UI.

## Self-hosting (production)

Full guide: **[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)** and **[infra/README.md](infra/README.md)**.

### Docker Compose with PostgreSQL (recommended)

```bash
cd infra
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD and APP_SECRET (openssl rand -hex 32)
docker compose up -d --build
docker compose ps                 # wait for app + db healthy
curl -fsS http://localhost:3000/api/health/ready
```

The stack runs the app + PostgreSQL 16, applies additive schema changes on boot, and serves the
standalone Next.js server. The app container has a readiness healthcheck (`/api/health/ready`) that
includes a real DB round-trip.

### Single-box Docker Compose with SQLite

```bash
cd infra
cp .env.example .env              # set APP_SECRET
docker compose -f docker-compose.sqlite.yml up -d --build
```

SQLite is appropriate for one app container. Do not run multiple replicas against one SQLite file;
use the Postgres profile for horizontal scaling. Back up the `app_db`, `app_data` and `app_backups`
volumes.

### First-boot checklist

1. `docker compose ps` shows both services healthy; `/api/health/ready` returns 200.
2. Open the app over HTTPS (behind Caddy/nginx), create the owner account, complete the wizard.
3. Configure the AI provider and run its connection test.
4. Configure integrations only when needed; run each **Test** button.
5. Trigger a backup and copy it off the host before entering real data.
6. Set up external monitoring against `/api/health` (liveness) and `/api/health/ready` (DB).

TLS: put Caddy/nginx in front of port 3000. A ready-to-edit Caddy example is
[`infra/Caddyfile.example`](infra/Caddyfile.example). Never expose port 3000 directly in production.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | `file:/abs/path/custom.db` or `postgresql://user:pass@host:5432/db?schema=public` |
| `APP_SECRET` | strongly recommended | AES-256-GCM key material for stored credentials. If unset, a generated `.data/secret.key` is used. Rotating it invalidates existing encrypted credentials. |
| `NODE_ENV` | production | `production` enables `Secure` cookies and quieter logging. |
| `PUBLIC_BASE_URL` | for Twilio webhooks | Public HTTPS origin used as a Twilio signature fallback |
| `DATABASE_PROVIDER` | Docker build arg | `sqlite` or `postgresql` selected at image build time |
| `AIS_DISABLE_WORKERS` | no | `1` disables all in-process workers on a replica |
| `AIS_WORKER_AUTOMATION` / `AIS_WORKER_OUTBOX` / `AIS_WORKER_DATASOURCES` | no | `0` disables one worker |

AI keys are **not** environment variables; enter them in Settings → AI Providers. There is no AI
credential bundled in the repo.

## Reliability & operations

Reliability mechanisms implemented in the product:

- **DB-backed leases** for automation, outbox and datasource workers — safe across replicas; TTL
  recovery after a crash.
- **Per-conversation turn lock** — overlapping chat/SMS/voice turns serialize instead of
  interleaving; callers receive `409 conversation_busy`.
- **Transactional business rules** — booking conflicts, payment/invoice updates and ledger entries
  are validated inside transactions; financial history is append-only.
- **Idempotency** — payment `idempotencyKey`, webhook `externalEventId`/event IDs, outbox dedupe keys,
  CalDAV booking UIDs.
- **Honest outbox** — `queued ≠ sent`, exponential backoff, attempt counts, machine-readable reasons;
  failures are visible in the UI and logs.
- **SQLite hardening** — WAL, `busy_timeout=5000`, `synchronous=NORMAL` at boot; use Postgres for
  concurrent multi-replica deployments.
- **Health checks** — `/api/health` (liveness) and `/api/health/ready` (DB); `/api/health/detail`
  (authenticated) reports DB tuning, worker leases, provider tests and counts.
- **Bounded external calls** — provider/connector HTTP calls have explicit timeouts; provider errors
  are surfaced, never replaced with fake success.
- **Structured audit trail** — logins, bookings, payments, settings, integrations and automation
  actions are recorded (metadata only; secrets never entered).
- **Backups** — SQLite `VACUUM INTO` via the admin API; `pg_dump` for Postgres; secrets-free JSON
  export. Back up the encryption key separately.

### Operations runbook

| Task | Command / action |
|---|---|
| Liveness | `curl -fsS https://host/api/health` |
| Readiness | `curl -fsS https://host/api/health/ready` |
| Logs | `docker compose logs -f app` (log rotation is configured in compose) |
| SQLite backup | `POST /api/admin/backup` (owner/admin), then copy `app_backups` off-host |
| Postgres backup | `docker compose exec -T db pg_dump -U ais ais > backup-$(date +%F).sql` |
| Restore Postgres | Stop app, restore into a fresh DB, start app, verify readiness + smoke test |
| Upgrade | Back up, `git pull`, `docker compose up -d --build`, watch logs/readiness |
| Rollback | Back up current state, check out the previous tag/commit, rebuild. Destructive schema changes require a deliberate migration; boot refuses them by default. |
| Worker issue | Check `/api/health/detail` leases; restart the app or wait for TTL recovery |
| Queue not delivering | Inspect Outbox status reason; configure/test the channel; flush via the UI |

No Prometheus/Grafana integration is bundled. Use your host/reverse-proxy monitoring against the
health endpoints and ship container logs through your normal collector.

## Security

- Passwords: scrypt with per-user salt; sessions are random tokens stored as SHA-256 hashes,
  httpOnly + SameSite=Strict, `Secure` in production; logout/revoke-all is persistent.
- Optional TOTP 2FA; per-email and per-IP login throttles.
- CSRF: custom `x-requested-with: ais` header on authenticated mutations plus SameSite cookies.
- Secrets: provider keys and integration credentials are AES-256-GCM encrypted and never returned.
- Webhooks: Twilio, Stripe, Square and generic HMAC signatures are verified timing-safely; events
  are deduplicated.
- Org scoping on business queries; role checks on every guarded route.
- Security headers in `next.config.ts` (nosniff, frame denial, referrer policy, permissions policy,
  COOP, HSTS + CSP in production).
- `local_only` data mode blocks cloud AI calls at the provider layer.

Read [docs/SECURITY.md](docs/SECURITY.md) for the threat model, RBAC matrix and accepted risks.

## Testing & CI

```bash
npx tsc --noEmit -p tsconfig.json
npm run lint
npm run test:unit        # Node built-in node:test, 161 cases
node scripts/smoke.mjs   # 44 end-to-end checks against the running dev server (scripts/smoke.mjs)
```

CI (`.github/workflows/ci.yml`) runs Prisma generate → typecheck → lint → unit tests → production
build. Browser and curl acceptance scenarios are documented in [docs/TEST_PLAN.md](docs/TEST_PLAN.md).
No `npm run build` is run in this development environment (the dev server is shared); CI owns the
build check.

## Known limitations

- **Single-org.** One organization per install; team roles/invitations and SAML/OIDC SSO + SCIM are
  implemented, but there is no multi-tenant SaaS control plane.
- **No payment custody** and no proprietary AI SDK; Stripe/Square/accounting/provider onboarding is BYOK.
- **No inbound email** (IMAP/webhook) and no outbound PSTN dialing/voice broadcast.
- **Token streaming, native provider tool-calling, reranking and vision are implemented** for
  providers that support them; others fall back to the strict JSON tool loop.
- **No automated SQLite→Postgres data migration.** Schema is portable; export/import
  (or a custom script) is required.
- **Rate limiting** is in-memory per process except the DB-backed login limiter; with multiple
  replicas use a proxy-level limiter if you need a global limit. The app trusts the first
  `x-forwarded-for` hop.
- **No bundled TLS/monitoring.** Put a reverse proxy and your monitoring stack in front.
- **External connector tests require real credentials.** Docker packaging was built and smoke-tested
  for both profiles on 2026-10-22; rerun the documented smoke test after upgrading.
- **CalDAV pull is conservative:** remote deletes are reported as `missing`, not auto-cancelled;
  locally cancelled bookings are not deleted remotely.
- Scheduled backups now ship with an hourly worker and a retention policy; a one-click
  restore script is still not included (use `VACUUM INTO`/`pg_dump` snapshots from SELF_HOSTING).

## Project layout

```
src/app/                 Next.js App Router: / SPA + /api route handlers
src/components/sections/ 18 client-side sections (dashboard, inbox, bookings, …)
src/lib/business/        Booking, invoice, payment, ledger, collections services
src/lib/ai/              Providers, policy, embeddings, receptionist tool loop, speech, local speech models
src/lib/integrations/    SMTP, Twilio, SMS gateways, Stripe, CalDAV, Google Calendar, Microsoft 365 Graph, outbox dispatcher
src/lib/datasources/     BYO DB/JSON ingestion + SSRF-guarded adapters
src/lib/telephony/       TwiML, PABX routing, no-input state
src/lib/automation/      Trigger/condition/action engine
src/lib/concurrency.ts   Worker leases + conversation turn locks
src/instrumentation.ts   Worker/embedding startup
prisma/schema.prisma     30 models, org-scoped, integer cents
tests/unit/              node:test regression suite
infra/                   Dockerfile, Postgres + SQLite Compose profiles, Caddy example
docs/                    Product, architecture, API, security, operations and audit docs
```

## Documentation map

| Document | Contents |
|---|---|
| [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) | Requirements, Compose/Node deployment, env, upgrades, backups, restore, TLS, troubleshooting |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Diagrams, module boundaries, request/worker lifecycle, AI and telephony design |
| [docs/API.md](docs/API.md) | Endpoint contract, auth/CSRF, error codes, payloads |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | 30-model schema and invariants |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, RBAC, secrets, webhooks, accepted risks |
| [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) | Every integration kind, setup, signatures, outbox semantics |
| [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) | Product scope, profiles, roles, status and non-goals |
| [docs/TEST_PLAN.md](docs/TEST_PLAN.md) | Acceptance matrix, browser/curl E2E, future automated coverage |
| [docs/SETUP_WIZARD.md](docs/SETUP_WIZARD.md) | 8-step onboarding behavior |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Phase-by-phase status and remaining gaps |
| [docs/AUDIT/](docs/AUDIT/) | Feature/provider matrices, security audit, remediation, test gaps, iteration log |
| [docs/LICENSING.md](docs/LICENSING.md) | Dependency licenses and repository-license note |

## Troubleshooting

| Symptom | Check |
|---|---|
| App container unhealthy | `docker compose logs app`; `/api/health/ready`; DB credentials/`DATABASE_URL` |
| `/api/health/ready` 503 | Database unreachable, wrong URL, or Postgres not ready; check `docker compose ps` |
| Login loop / 401 | Cookies require HTTPS in production; proxy must forward `Host`/`x-forwarded-for`; session may be revoked |
| 409 `conversation_busy` | Another turn is processing the same conversation; retry after it finishes |
| 409 `worker_busy` | Worker lease is held; wait for the tick/TTL or use the UI after it clears |
| Messages stuck `queued` | No enabled channel, missing credentials, or provider failure; read the outbox status reason |
| Stripe webhooks rejected | Wrong `webhookSecret`, raw body changed by proxy, or clock-skewed signature |
| Twilio signature failures | Set the integration `publicBaseUrl`/`PUBLIC_BASE_URL` to the exact public URL |
| Embeddings/ONNX fails | First boot needs outbound access to download the model; search should degrade honestly to lexical |
| Schema boot failure after upgrade | A destructive change was refused; restore backup and apply a deliberate migration |

No license file is currently shipped; see [docs/LICENSING.md](docs/LICENSING.md) before redistribution.
