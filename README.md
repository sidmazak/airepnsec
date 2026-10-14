# AI Secretary

A self-hosted, local-first AI business assistant: an AI receptionist (text + browser voice test calls), bookings, customers, invoices, verified payments, an auditable ledger, approved knowledge/FAQs, and a native automations engine — with bring-your-own-key or fully local AI.

**Designed for:** apartment rentals, car rentals, salons, clinics, contractors — one shared core platform with configurable business profiles.

## Highlights

- **Real operations, not demos** — the assistant books through the actual booking engine (transactional conflict checks), quotes real prices, and can never silently settle an invoice: customer "I paid" claims are recorded as *pending verification*.
- **Auditable money** — append-only double-entry ledger; corrections are reversal entries; payments are idempotent (duplicate webhooks never double-count).
- **Local-first AI** — works without any cloud key. Data modes: `local_only` (hard-blocks cloud calls), `hybrid`, `cloud_first`. Ollama and OpenAI-compatible adapters included; provider API keys are encrypted at rest and never returned to the client.
- **Honest states everywhere** — queued messages say *queued (no channel configured)*; failed tool calls are surfaced; nothing fakes success.
- **Native automations** — triggers, conditions, delays, quiet hours, dedupe, retries, daily caps, test mode, run history.

## Integrations (BYOK, all optional)

- **Email (SMTP)** — any relay incl. anonymous local ones; real invoice emails (text + HTML) with an optional Stripe "Pay now" button.
- **SMS + WhatsApp (Twilio)** — real Messages API sends; per-message sids; sanitized Twilio errors.
- **Stripe payments** — real Payment Links per invoice (metadata-bound) + signature-verified webhooks with event dedupe, currency-mismatch and overpay protection.
- **Outbound webhooks** — per-destination HMAC-signed POSTs (`x-signature`, `x-ais-event`; `none` when unsigned); Zapier/Make/generic; automation `send_webhook` action.
- **ICS calendar** — subscribable bookings feed + per-booking `.ics` (RFC 5545).
- **Honest outbox** — every outbound message is an outbox row with attempts, exponential backoff (2^n min, max 5), and a plain-language status reason; flush anytime.
- Credentials are AES-256-GCM encrypted at rest and never returned. See [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

## Quick start (development)

```bash
bun install
# .env: DATABASE_URL=file:/abs/path/to/db/custom.db
bun run db:push
bun run dev          # http://localhost:3000
```

First run: create the owner account (or click **Try the demo workspace** — seeds `demo@aisecretary.local` / `demo-1234` with clearly-labeled demo data). The setup wizard walks through business profile → services/staff → imports → knowledge → AI → channels → collections → end-to-end test → activation.

## The minimum vertical slice (works today)

Install → sign in → wizard → create a customer + service → book via the real engine → create an invoice → record a **verified** payment → inspect the ledger — **all without any cloud AI key**. Then chat with the AI receptionist in the Inbox (managed gateway in this sandbox build, or Ollama via AI Providers) and try a browser voice test call.

## Architecture (sandbox build)

Single Next.js 16 app (App Router): UI at `/` (single-page, section-based) + API under `/api/*`; business services in `src/lib/business`, AI provider layer in `src/lib/ai`, automations in `src/lib/automation`, worker tick via `src/instrumentation.ts`. Dev database is SQLite via Prisma; the schema is kept portable (no enums/native JSON columns; money = integer cents) for the PostgreSQL production target.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) · [docs/DATA_MODEL.md](docs/DATA_MODEL.md) · [docs/SECURITY.md](docs/SECURITY.md) · [docs/LICENSING.md](docs/LICENSING.md) · [docs/SETUP_WIZARD.md](docs/SETUP_WIZARD.md) · [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) · [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) · [docs/TEST_PLAN.md](docs/TEST_PLAN.md) · [docs/API.md](docs/API.md) · [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)

## Self-hosting (production)

`infra/` ships a multi-stage Docker build (Bun, Next standalone) and a compose stack with **PostgreSQL 16 + pgvector**. Honest status: packaging is **delivered but not verified inside the build sandbox** (no Docker daemon) — smoke-test it on your host. See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) for requirements, env vars, SQLite→Postgres notes, `APP_SECRET` rotation caveats, and backups.

## Honest limitations

- Real inbound telephony (voice/SMS phone numbers) is deferred — calls today are browser-based test calls; two-way calendar sync (CalDAV/Google OAuth) is deferred — read-only ICS feed + per-booking .ics are live.
- Integration connection tests run in the connector layer but are not exposed as an HTTP endpoint yet; the rich booking-confirmation email template is not wired to an endpoint yet (booking confirmations go through `booking_created` automations).
- Automated test suites are specified in TEST_PLAN.md; this sandbox build was verified with browser E2E instead (test-framework code is out of scope here).
- Docker packaging (Postgres + Compose in `infra/`) is delivered but **not verified in this sandbox** (no Docker daemon); verify on your host.

## Security

Passwords: scrypt. Sessions: HMAC-signed, httpOnly, SameSite=Strict cookies. Provider keys: AES-256-GCM with a server-held key. Webhooks: HMAC-SHA256 verified, event-deduplicated. Every consequential action lands in an append-only audit trail. In `local_only` mode, cloud model calls are blocked at the provider layer.
