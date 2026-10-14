# Implementation Plan & Status

Phased execution with goal + acceptance criteria per phase, and a live status table.
**Status key:** ✅ implemented & verified in this build · 🟡 partially implemented (honest gaps listed) · ⏳ deferred (not built in this sandbox build)

## Phase 0 — Discovery
✅ Inspected existing repo (Next.js 16 scaffold, Prisma+SQLite, shadcn/ui set), preserved scaffold conventions, produced the docs set.

## Phase 1 — Data foundation
✅ Prisma schema with 26 models, organization-scoped from day one, money as integer cents, portable across SQLite/Postgres.
✅ Crypto primitives (AES-256-GCM secret encryption, scrypt passwords, HMAC sessions), auth wrapper with RBAC + CSRF header + rate limiting, append-only audit trail.

## Phase 2 — Business services + APIs
✅ Booking engine: availability computation (working hours, buffers, holidays, capacity model), conflict validation **inside serialized transactions**.
✅ Invoices (line items, sequential numbering, void-with-reversal), payments (idempotent by idempotencyKey + externalEventId), claims never auto-settle, HMAC-verified webhooks with event dedupe.
✅ Append-only ledger (charge/payment/refund/adjustment/reversal), account balances, CSV export, statements.
✅ 38 API route handlers verified live (tsc clean, lint clean, curl + browser E2E).

## Phase 3 — UI shell, wizard, sections
✅ Single-page app: auth screen, demo entry, 12 sections, mobile top bar + desktop sidebar, sticky footer.
✅ 8-step autosaving setup wizard with back/continue, CSV templates, plain-language AI config, and a **real end-to-end test runner** (customer → service → availability → booking → invoice → verified payment → balanced ledger check) before activation.

## Phase 4 — AI receptionist + voice test
✅ Strict-JSON tool loop over typed provider adapters (managed gateway / Ollama / OpenAI-compatible); tools: list_services, check_availability, quote_price, create_booking, my_bookings, cancel_booking, search_knowledge, payment_claim, take_message, escalate — every tool validated, every failure reported honestly to the customer.
✅ Local lexical knowledge retrieval (approved docs only),AiLog with latency/usage metrics (no secrets).
✅ Browser-based test calling via Web Speech API (STT + TTS, interruption-safe toggles, honest unsupported-browser fallback). Text inbox with human takeover.

## Phase 5 — Automations + collections
✅ Native engine: triggers (invoice_overdue, booking_created, conversation_escalated), conditions, delays, quiet hours, dedupe keys, daily caps, retries with backoff (5m/30m), test mode, run history, outbox with honest delivery states.
✅ Worker tick every 60s via instrumentation + manual "Run now"; heartbeat surfaced in diagnostics.

## Phase 6 — Security hardening
✅ Session auth (HMAC-signed, httpOnly, SameSite=Strict), RBAC (owner/admin/agent/viewer), org isolation on every query, zod validation, CSRF custom-header check, in-memory rate limiting, encrypted provider keys (never returned after save), webhook HMAC verification, audit events, security-relevant data-mode enforcement.
🟡 CSP/security headers: Next defaults only — add explicit headers in production config.
🟡 Two-factor auth, SSO: not implemented.

## Phase 7 — Verification & docs
✅ tsc + ESLint clean; browser E2E of the golden path; local-only blocking test; duplicate-webhook dedupe; overpay rejection; already-reversed 409; opt-out honored; demo seed idempotent.
✅ This docs set; README/AGENTS guidance.
⏳ Automated test suite (Vitest): the sandbox build forbids test-framework code — TEST_PLAN.md documents the full case matrix to add outside the sandbox.
⏳ Docker Compose production packaging: infra/ scripts and compose file are the next step outside the sandbox (SQLite dev here; Postgres target documented).

## Honest capability ledger

| Capability | Status | Notes |
|---|---|---|
| Text AI receptionist (chat) | ✅ | Managed gateway default in sandbox; Ollama/BYOK adapters included |
| Browser voice test call | ✅ | Web Speech API; real telephony (SIP/PSTN) ⏳ deferred |
| Booking engine | ✅ | Transactional conflict checks; conservative pool-capacity model |
| Customers + CSV import | ✅ | Templates downloadable |
| Invoices + verified payments | ✅ | Claims pend verification; webhooks idempotent |
| Ledger + reversals + export | ✅ | Append-only; corrections are reversal entries |
| Knowledge/FAQ retrieval | ✅ | Local lexical engine; neural embeddings via BYOK adapters |
| Automations (overdue reminders, escalation) | ✅ | Test mode, dedupe, retries, quiet hours, daily caps |
| Outbound email/SMS sending | 🟡 | Outbox queues with honest status; no SMTP/SMS sender wired in this build |
| External calendar sync | ⏳ | Optional connector design documented |
| Payment-provider integrations | 🟡 | Generic signed-webhook adapter + test harness; no specific PSP wired |
| PostgreSQL + Docker Compose deployment | ⏳ | Sandbox runs SQLite; schema portable; production packaging documented |
| Backups | ✅ | `VACUUM INTO` file backups + JSON export; scheduled backup scripts are infra work |
