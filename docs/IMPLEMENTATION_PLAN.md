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
✅ Strict-JSON tool loop over typed provider adapters (Ollama local / OpenAI-compatible BYOK); tools: list_services, list_staff, check_availability (timezone-correct, returns the exact slot value to book), quote_price, create_booking (slot re-verified), my_bookings, reschedule_booking, cancel_booking (policy-enforced), my_invoices, business_info, search_knowledge, payment_claim (identity-checked), take_message, escalate — every tool validated, every failure reported honestly to the customer.
✅ **Neural RAG retrieval**: built-in local ONNX embedder (all-MiniLM-L6-v2, 384-d) with hybrid dense+BM25 search, per-chunk model tagging, controlled reindex + stale-index detection, boot-time model warm-up, protocol-tolerant tool dispatch. AiLog with latency/usage metrics (no secrets).
✅ Browser-based test calling via Web Speech API (STT + TTS, interruption-safe toggles, honest unsupported-browser fallback). Text inbox with human takeover.

## Phase 5 — Automations + collections
✅ Native engine: triggers (invoice_overdue, booking_created, conversation_escalated), conditions, delays, quiet hours, dedupe keys, daily caps, retries with backoff (5m/30m), test mode, run history, outbox with honest delivery states.
✅ Worker tick every 60s via instrumentation + manual "Run now"; heartbeat surfaced in diagnostics.

## Phase 6 — Security hardening
✅ Session auth (HMAC-signed, httpOnly, SameSite=Strict), RBAC (owner/admin/agent/viewer), org isolation on every query, zod validation, CSRF custom-header check, in-memory rate limiting, encrypted provider keys (never returned after save), webhook HMAC verification, audit events, security-relevant data-mode enforcement.
✅ Security headers set in `next.config.ts` (nosniff, deny framing, referrer policy, permissions policy, COOP) + HSTS and a production CSP.
🟡 Two-factor auth, SSO: not implemented.

## Phase 7 — Verification & docs
✅ tsc + ESLint clean; browser E2E of the golden path; local-only blocking test; duplicate-webhook dedupe; overpay rejection; already-reversed 409; opt-out honored; demo seed idempotent.
✅ This docs set; README/AGENTS guidance.
✅ `npm run test:unit` (node:test, 20 cases): SMS chunking, TTS chunking, read-only SQL guard, RFC 6238 TOTP vectors. CI runs it in `.github/workflows/ci.yml` alongside tsc, eslint, and `next build`.

## Phase 8 — Third-party integration layer (2026-10-14)
✅ Real BYOK connectors: SMTP (nodemailer), Twilio SMS/WhatsApp (Messages API), Stripe (Payment Links + webhook), signed outbound webhooks — secrets AES-256-GCM, never returned.
✅ Outbox dispatcher (30s worker + manual flush): exponential backoff (2^n min, max 5 attempts), 10-min recheck on unconfigured channels, nudge-on-enable, honest statusReason on every row.
✅ Invoice emails (text+HTML, optional Stripe "Pay now" button, per-invoice-per-day dedupe), reminder/direct-send automation actions with template vars, ICS calendar feed + per-booking .ics.
✅ Stripe webhooks (Stripe-Signature t=,v1= HMAC, event dedupe, currency-mismatch/overpay protections) + generic inbound payment webhooks (x-signature HMAC, 202 honest results).
🟡 Self-host packaging delivered-unverified-in-sandbox: infra/ Dockerfile + docker-compose.yml (Postgres/pgvector target) written but no Docker daemon here — smoke test on your host (infra/README.md).

## Honest capability ledger

Updated 2026-10-14 (integration layer delivered — see [INTEGRATIONS.md](./INTEGRATIONS.md)).

| Capability | Status | Notes |
|---|---|---|
| Text AI receptionist (chat) | ✅ | BYOK only: local Ollama or any OpenAI-compatible endpoint (no proprietary AI SDK) |
| Browser voice test call | ✅ | Web Speech API; real telephony (SIP/PSTN) ⏳ deferred |
| Booking engine | ✅ | Transactional conflict checks; conservative pool-capacity model |
| Customers + CSV import | ✅ | Templates downloadable |
| Invoices + verified payments | ✅ | Claims pend verification; webhooks idempotent |
| Ledger + reversals + export | ✅ | Append-only; corrections are reversal entries |
| Knowledge/FAQ retrieval (RAG) | ✅ | Built-in local neural embeddings (MiniLM ONNX, no key, zero egress) + hybrid BM25 fusion; Ollama/OpenAI-compatible BYOK embedders; controlled reindex |
| Automations (overdue reminders, escalation) | ✅ | Test mode, dedupe, retries, quiet hours, daily caps |
| Outbound email sending (SMTP BYOK) | ✅ DELIVERED | nodemailer connector; outbox dispatcher (30s, backoff 2^n min max 5 attempts, 10-min recheck, nudge-on-enable); invoice emails text+HTML with optional Stripe pay button |
| Outbound SMS/WhatsApp (Twilio BYOK) | ✅ DELIVERED | Real Messages API sends; WhatsApp `from` normalization; sanitized Twilio errors in statusReason |
| Payment provider (Stripe BYOK) | ✅ DELIVERED | Real Payment Links (metadata org_slug/invoice_id/invoice_number) + signature-verified webhook (checkout.session.completed, payment_intent.succeeded), event-id dedupe, currency-mismatch & overpay protection |
| Outbound webhooks (Zapier/Make/generic) | ✅ DELIVERED | Per-destination signed POSTs (hex HMAC-SHA256, `x-ais-event`, `none` when unsigned); automation `send_webhook` action |
| ICS calendar | ✅ DELIVERED | Subscribable bookings feed + per-booking .ics (RFC 5545, VALARM −60 min); two-way sync ⏳ deferred |
| Inbound payment webhooks (generic) | ✅ | x-signature HMAC with org secret, 202 honest results, idempotent |
| PostgreSQL + Docker Compose deployment | 🟡 | `infra/` Dockerfile + compose (pgvector/pg16) **delivered-unverified-in-sandbox** — no Docker daemon here; smoke test on your host |
| Backups | ✅ | `VACUUM INTO` file backups + JSON export; scheduled backup scripts are infra work |

## Phase 9 — Receptionist completion sweep (2026-10-19)
✅ Timezone correctness end-to-end: shared fixed-offset helpers (`src/lib/timezone.ts`); `check_availability` speaks the business timezone and returns exact slot values; `create_booking`/`reschedule_booking` only accept real computed slots (no invented times); naive datetimes are interpreted as org wall-clock.
✅ Receptionist depth: `reschedule_booking`, `my_invoices`, `business_info`, `list_staff`; cancellation policy enforced (escalates inside the cut-off window); payment claims identity-checked; latest-N history (not first-N), untrusted-content instructions, escalation audit when the tool loop exhausts.
✅ RBAC closed on every mutating route (staff = owner/admin/agent; settings = owner/admin) + nav-level role gating.
✅ Public web chat channel: `POST/GET /api/public/chat/[slug]` (token session, CORS, rate limits) — the receptionist can now be embedded on any website; conversations land in the Inbox.
✅ Telephony: staff replies are actually delivered over SMS (delivered/queued/failed reported honestly); SMS turns run in `after()`; Twilio `?routed=1` status callbacks verify; escalation events fire only on transition.
✅ Voice: browser Web Speech fallback is fully wired (out-of-the-box mic + speech synthesis); server speech is OpenAI-compatible only (self-hosted Kokoro-FastAPI/faster-whisper allowed in local-only mode); Realtime voice uses the configured endpoint (`sdpUrl`) and persists transcripts.

**Remaining honest gaps** (2026-10-19): SSO (SAML/OIDC), Docker smoke test verified end-to-end on this host (see worklog), Browser E2E of the new public-chat + voice paths needs a stubbed LLM endpoint (no live model in this sandbox).

## Phase 10 — Closing the remaining honest gaps (2026-10-19)
✅ Two-way CalDAV: `POST /api/integrations/caldav-sync` now pulls remote `STATUS:CANCELLED` (cancels the booking) and moved `DTSTART` (reschedules through the validated booking service); remotely deleted events are reported as `missing` and deliberately do not cancel local bookings; `direction` defaults to `both`. Verified live against Radicale (1 cancel + 1 reschedule + 1 out-of-hours failure = honest per-item results).
✅ Inbound WhatsApp: new `POST /api/telephony/whatsapp/incoming` (signature-verified, opt-out + AI-off honored, replies via the Twilio WhatsApp sender with outbox fallback, `conversation_escalated` on transition), plus a webhook URL row in the Integrations UI and a `whatsapp` channel badge in the Inbox. Verified live end-to-end (inbound → AI booking → WhatsApp reply queued for retry on a fake sender).
✅ 2FA: TOTP (RFC 6238, SHA1, 30s, ±1 step) in `src/lib/security/totp.ts`; `User.twoFactorSecret/twoFactorEnabled` columns; setup/enable/disable endpoints; login requires a current code when enabled; `/api/auth/2fa` status; `Security` section in the sidebar (enrollment QR/secret + copy, confirm with live code, disable requires password + code). Verified live: enable, login without/with wrong/correct code, disable with/without code.
✅ Docker: multi-stage image built and run on this host (Debian 3.0.x query-engine target added to `binaryTargets`); register-owner + login + health verified against the running container.
✅ CI: `.github/workflows/ci.yml` runs tsc → eslint → unit tests → build on push/PR.
✅ Docs: API.md/IMPLEMENTATION_PLAN.md updated; worklog appended.
