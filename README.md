# AI Secretary

A self-hosted, local-first AI business assistant: an AI receptionist (text + browser voice test calls), bookings, customers, invoices, verified payments, an auditable ledger, approved knowledge/FAQs, and a native automations engine — with bring-your-own-key or fully local AI.

**Designed for:** apartment rentals, car rentals, salons, clinics, contractors — one shared core platform with configurable business profiles.

## Highlights

- **Real operations, not demos** — the assistant books through the actual booking engine (transactional conflict checks), quotes real prices, and can never silently settle an invoice: customer "I paid" claims are recorded as *pending verification*.
- **Auditable money** — append-only double-entry ledger; corrections are reversal entries; payments are idempotent (duplicate webhooks never double-count).
- **Local-first AI** — works without any cloud key. Data modes: `local_only` (hard-blocks cloud calls), `hybrid`, `cloud_first`. Ollama and OpenAI-compatible adapters included; provider API keys are encrypted at rest and never returned to the client.
- **Honest states everywhere** — queued messages say *queued (no channel configured)*; failed tool calls are surfaced; nothing fakes success.
- **Native automations** — triggers, conditions, delays, quiet hours, dedupe, retries, daily caps, test mode, run history.

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

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) · [docs/DATA_MODEL.md](docs/DATA_MODEL.md) · [docs/SECURITY.md](docs/SECURITY.md) · [docs/LICENSING.md](docs/LICENSING.md) · [docs/SETUP_WIZARD.md](docs/SETUP_WIZARD.md) · [docs/TEST_PLAN.md](docs/TEST_PLAN.md) · [docs/API.md](docs/API.md) · [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)

## Honest limitations

- Outbound email/SMS: the outbox queues and displays messages with honest statuses; no SMTP/SMS sender is wired in this build.
- Telephony (SIP/PSTN), external calendar sync, and specific payment-processor integrations are deferred; a generic HMAC-signed webhook adapter + labeled test harness are included.
- Automated test suites are specified in TEST_PLAN.md; this sandbox build was verified with browser E2E instead (test-framework code is out of scope here).
- Production packaging (Postgres + Docker Compose in `infra/`) is documented but not part of this sandbox build.

## Security

Passwords: scrypt. Sessions: HMAC-signed, httpOnly, SameSite=Strict cookies. Provider keys: AES-256-GCM with a server-held key. Webhooks: HMAC-SHA256 verified, event-deduplicated. Every consequential action lands in an append-only audit trail. In `local_only` mode, cloud model calls are blocked at the provider layer.
