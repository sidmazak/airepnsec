# Implementation Plan & Status

Phased execution with goal + acceptance criteria per phase, and a live status table.
**Status key:** ✅ implemented & verified in this build · 🟡 partially implemented (honest gaps listed) · ⏳ deferred (not built)

## Phase 0 — Discovery
✅ Inspected the existing repo (Next.js 16 scaffold, Prisma+SQLite, shadcn/ui set), preserved scaffold conventions, produced the docs set.

## Phase 1 — Data foundation
✅ Prisma schema with **30 models**, organization-scoped from day one, money as integer cents, portable across SQLite/Postgres.
✅ Crypto primitives (AES-256-GCM secret encryption, scrypt passwords, hashed session tokens), auth wrapper with RBAC + CSRF header + rate limiting, append-only audit trail.

## Phase 2 — Business services + APIs
✅ Booking engine: availability computation (working hours, buffers, holidays, capacity), conflict validation **inside serialized transactions**.
✅ Invoices (line items, sequential numbering, void-with-reversal), payments (idempotent by idempotencyKey + externalEventId), claims never auto-settle, HMAC-verified webhooks with event dedupe.
✅ Append-only ledger (charge/payment/refund/adjustment/reversal), account balances, CSV export, statements.
✅ **97 API route files / 122 exported handlers** under `src/app/api/**`; contract in [API.md](./API.md).

## Phase 3 — UI shell, wizard, sections
✅ Single-page app: auth screen, demo entry, **18 sidebar sections**, mobile top bar + desktop sidebar, sticky footer.
✅ 8-step autosaving setup wizard with back/continue, CSV templates, plain-language AI config, and a **real end-to-end test runner** (customer → service → availability → booking → invoice → verified payment → balanced ledger check) before activation.

## Phase 4 — AI receptionist + voice test
✅ Strict-JSON tool loop over typed provider adapters (Ollama local / OpenAI-compatible BYOK); every tool validated, every failure reported honestly.
✅ **Neural RAG retrieval**: built-in local ONNX embedder (all-MiniLM-L6-v2, 384-d) with hybrid dense+BM25 search, per-chunk model tagging, controlled reindex + stale-index detection, boot-time model warm-up.
✅ Browser-based test calling via Web Speech API. Text inbox with human takeover.

## Phase 5 — Automations + collections
✅ Native engine: triggers (invoice_overdue, booking_created, booking_reminder, conversation_escalated, manual), conditions, delays, quiet hours, dedupe keys, daily caps, retries, test mode, run history, outbox with honest delivery states.
✅ Worker tick every 60s via instrumentation + manual "Run now"; heartbeat and worker status surfaced in Diagnostics.

## Phase 6 — Security hardening
✅ Session auth (hashed random tokens, DB-backed revocation), RBAC (owner/admin/agent/viewer), org isolation on every query, zod validation, CSRF custom-header check, in-memory rate limiting, encrypted provider keys (never returned after save), webhook signature verification, audit events, data-mode enforcement.
✅ Optional TOTP 2FA (RFC 6238, SHA1, 30s, ±1 step) with encrypted secret, login challenge, and password+code disable.
✅ Security headers set in `next.config.ts` (nosniff, deny framing, referrer policy, permissions policy, COOP, HSTS in production, CSP). No `middleware.ts`; headers are configured centrally.
✅ SSO (SAML/OIDC): SP-initiated SAML 2.0 with metadata endpoint, ACS with signature verification + InResponseTo binding + base64 normalization; OIDC auth code flow with PKCE, nonce, JWKS verification; SCIM 2.0 provisioning; encrypted secret storage; admin UI; audit logging.

## Phase 7 — Verification & docs
✅ tsc + ESLint clean; browser E2E of the golden path; local-only blocking test; duplicate-webhook dedupe; overpay rejection; already-reversed 409; opt-out honored; demo seed idempotent.
✅ `npm run test:unit` (Node's built-in `node:test`, **43 cases**): SMS gateway adapters, TTS chunking, read-only SQL guard, TOTP vectors, telephony routing/status mapping, outbound URL guard, Google Calendar token/event helpers.
✅ CI (`.github/workflows/ci.yml`) runs Prisma generate → tsc → eslint → unit tests → `next build` on push/PR.
✅ Docs refreshed in iteration 2 (2026-10-22): API, architecture, data model, security, self-hosting, audits.

## Phase 8 — Third-party integration layer (2026-10-14)
✅ Real BYOK connectors: SMTP (nodemailer), Twilio SMS/WhatsApp/Voice, Stripe (Payment Links + webhook), signed outbound webhooks, CalDAV — secrets AES-256-GCM, never returned.
✅ Outbox dispatcher (30s worker + manual flush) with exponential backoff, honest `statusReason`, and a webhook-unconfigured recheck.
✅ Invoice emails (text+HTML, optional Stripe "Pay now" button), reminder/direct-send automation actions, ICS feed + per-booking `.ics`, calendar two-way sync.
✅ Per-kind connection tests exposed at `POST /api/integrations/[id]/test`.
✅ Docker packaging: iteration 2 fixed standalone static/public copying, added `DATABASE_PROVIDER=sqlite|postgresql`, additive schema boot, healthcheck and Compose profiles. On 2026-10-22 both images were rebuilt and smoke-tested; fixes included ONNX runtime files in the standalone trace, a Postgres-safe demo seed upsert, and a Postgres backup guard.

## Phase 9 — Receptionist completion sweep (2026-10-19)
✅ Timezone correctness end-to-end; `check_availability` returns exact slot values; booking tools only accept real computed slots.
✅ Receptionist depth: reschedule, invoices, business info, staff; cancellation policy; identity-checked payment claims; latest-N history; escalation audit.
✅ RBAC on every mutating route + nav-level role gating.
✅ Public web chat channel (`POST/GET /api/public/chat/[slug]`) with token sessions, CORS, rate limits.
✅ Telephony: staff replies delivered over SMS/WhatsApp with honest delivery states; SMS turns run in `after()`; Twilio status callbacks verify; escalation fires on transition only.
✅ Voice: browser Web Speech fallback; server speech is OpenAI-compatible only; realtime voice uses the configured endpoint.

## Phase 10 — Closing the remaining honest gaps (2026-10-19)
✅ Two-way CalDAV pull (remote cancels/moves applied through the booking service; remote deletes reported, not auto-cancelled).
✅ Inbound WhatsApp webhook with signature verification, opt-out/AI-off handling, Twilio replies, and outbox fallback.
✅ 2FA, Docker image build/boot verification (both profiles, 2026-10-22), CI, docs.

## Phase 11 — Concurrency, telephony routing, deployment hardening (2026-10-22)
✅ **Worker single-flight:** `WorkerLease` + `runWithWorkerLease` for automation, outbox, and data-source sync. Manual endpoints return `409 worker_busy`/`sync_busy` instead of racing the worker; crashed holders recover after the lease TTL.
✅ **Conversation turn lock:** DB-backed per-conversation lock with a stale TTL; overlapping SMS/chat/voice turns serialize instead of interleaving; busy turns surface `409 conversation_busy`.
✅ **SQLite tuning:** WAL journal mode, 5s busy timeout, `synchronous=NORMAL` at boot; health/detail reports live database tuning and worker leases.
✅ **PABX routing:** pure, unit-tested helpers for least-busy, round-robin (CAS cursor), redirect and status normalization; disabled/paused lines excluded; real active-call load; every call recorded as `TelephonyCall`; Twilio `DialCallStatus` preferred.
✅ **Rate limiting:** per-route limits configurable; telephony webhooks raised to 300/600 per minute; per-IP login limit alongside per-email.
✅ **Docker/static assets:** `DATABASE_PROVIDER` build arg, `.next/static` + `public/` copied into standalone, OpenSSL installed; `ignoreBuildErrors` disabled and React strict mode enabled.
✅ **UI correctness:** favicon 404 fixed; Radix dialog description IDs no longer overridden; credentials dialog form semantics fixed.
✅ **Verification:** tsc clean, lint clean, 43/43 unit tests; live health checks, lease-busy 409, SSRF rejection, and browser section/dialog checks; both Docker profiles smoke-tested 2026-10-22.

## Phase 12 — Google Calendar sync + receptionist lifecycle control (2026-10-22)
✅ **Google Calendar integration** (`google_calendar`): OAuth 2.0 authorization-code flow with a one-time server-side `state` nonce, refresh tokens stored encrypted and never returned; real connection test against the configured calendar.
✅ **Two-way sync** (`POST /api/integrations/google-calendar/sync`): free/busy windows become `CalendarBlock` rows (so busy diary time is never offered), bookings are pushed as Google events with a private extended property (idempotent re-push), remote cancellations/moves are pulled back through the validated booking service, and events of locally cancelled bookings are removed remotely.
✅ **Availability honours external busy time**: `computeSlots` and the transactional `assertSlotAvailable` both subtract `CalendarBlock` rows; manual blocks are manageable through `/api/calendar/blocks`.
✅ **Receptionist runtime switch**: org-wide `running | paused | stopped` (`Organization.receptionistStatus`) with a dashboard control card, an audited `PATCH /api/settings/receptionist`, a global banner while not running, and hard gates on inbound SMS, WhatsApp, voice calls, the speech gather loop, public web chat, realtime sessions and the receptionist turn runner. Calls routed to a human agent line are unaffected.
✅ **Smoke test**: `scripts/smoke.mjs` runs 24 checks against a live instance (health, session bootstrap + owner-registration guard, pause/resume, block → availability, Google Calendar create/authorize/sync failure).

## Phase 13 — Multi-user team management + shared-store rate limiting (2026-10-22)
✅ **Team API** (`src/lib/users.ts` + `/api/users*`): member list (never the password hash or the TOTP secret), one-time invitations (7-day TTL, hashed token, emailed through the outbox, link returned once to the inviter), invitation lookup + acceptance (sets the password, signs the new member in), invitation revocation, role change (`owner | admin | agent | viewer`), deactivation (never a hard delete) and per-member session revocation.
✅ **Password flows**: owners/admins can issue a one-time reset link (1-hour TTL, hashed token) for a member; members can change their own password with the current password — every session of the account (including the current one) is revoked and the cookie is cleared.
✅ **Guard rails**: only owners manage owners or promote somebody to owner; admins manage agents/viewers only; nobody may deactivate or demote their own account; the last active owner can never be demoted or deactivated; a deactivated account cannot sign in.
✅ **UI**: Team section (owner/admin) with members, roles, 2FA/last-login state, pending invitations, invite/role/deactivate/revoke-sessions/reset actions, and a "change my password" card; public Join and Reset-password screens driven by the emailed hash link (`#?join=<token>`, `#/reset-password?token=<token>`).
✅ **Shared-store rate limiting**: `RateBucket` rows replace the in-memory sliding window for the login limiter, so the limit survives a restart and is shared between replicas.
✅ **Verification**: tsc clean, lint clean, 43/43 unit tests, 33/33 smoke checks (invite → accept → replay rejected → role change → deactivate → last-owner guard). The smoke suite now runs **44 checks** in total (Microsoft 365 create/authorize/sync-failure, local speech catalog + model validation, backup list/schedule).

## Phase 14 — Streaming, native tool calling, rerank, vision, hardware probe (2026-10-22)
✅ **Server-side streaming** (`POST /api/ai/stream`): SSE with `delta` / `tool` / `done` / `error` events; the protocol helpers live in `src/lib/ai/llm-protocol.ts` (pure, unit-tested). Providers that cannot stream answer in one `delta` + `done` — never a fake stream.
✅ **Native provider tool calling**: `toolSpecs` + `supportsNativeTools` in `src/lib/ai/receptionist.ts`; when the endpoint supports `tools` the model calls the validated tools directly, otherwise the strict JSON tool loop is used. Fragmented tool arguments are merged before parsing.
✅ **Reranking** (`src/lib/ai/rerank.ts`): second-stage ranking of the hybrid retrieval against a real `/rerank` endpoint (optional capability, off by default, real connection test).
✅ **Vision** (`src/lib/ai/vision.ts` + `/api/ai/vision`): real multimodal call with a real connection test (1x1 PNG probe).
✅ **Hardware probe + model catalog** (`src/lib/system/hardware.ts` + `/api/system/hardware`): CPU/RAM/GPU/disk detection and a catalog that explains which model fits the machine.

## Phase 15 — Scheduled backups and retention (2026-10-22)
✅ **Snapshot engine** (`src/lib/backup.ts`): SQLite `VACUUM INTO` snapshots into `backups/` (file mode 0600), snapshot listing and a retention policy that prunes the oldest snapshots.
✅ **Scheduler**: the background worker (`src/instrumentation.ts`) checks the hourly schedule (`AppSetting backup_schedule`: `enabled`, `hour`, `retention`), creates a snapshot when due and prunes old ones; `backup_last_run` records the last run.
✅ **API + UI**: `/api/admin/backups` (GET list + POST create), `/api/admin/backups/schedule` (PUT), and a Diagnostics card showing the schedule, the snapshot list and the manual trigger. Audited.

## Phase 16 — Microsoft 365 / Graph calendar sync (2026-10-22)
✅ **Graph integration** (`microsoft_calendar`): OAuth 2.0 authorization-code flow against the Microsoft identity platform (one-time server-side `state` nonce, encrypted refresh token, real connection test through the Graph calendar view).
✅ **Two-way sync** (`POST /api/integrations/microsoft-calendar/sync`): free/busy windows become `CalendarBlock` rows (source `microsoft_calendar`) so busy diary time is never offered, bookings are pushed as Graph events with an `ais-booking-id:` marker (idempotent re-push), remote cancellations/moves are pulled back through the validated booking service and events of cancelled bookings are removed remotely.
✅ **UI**: the Microsoft 365 card in Integrations (connect, sync now, last-sync summary, tenant/mailbox configuration) next to the Google Calendar card.

## Phase 17 — Local speech models (2026-10-22)
✅ **Model manager** (`src/lib/ai/localSpeech.ts`): a small catalog of ONNX models (MMS-TTS for speech, Whisper tiny/base for transcription) that are downloaded on demand into `.models/` (the same folder the built-in embedding model uses), with honest install state, download and delete actions (`/api/ai/speech/models`).
✅ **Real inference**: transformers.js (ONNX Runtime) runs the models on the server — Whisper transcribes 16 kHz mono PCM (WAV decoded in-process, compressed browser recordings converted with ffmpeg when installed), MMS-TTS synthesises WAV. Audio never leaves the machine.
✅ **Provider kind** `local_speech` for the `stt`/`tts` capabilities, with catalog validation (`422 bad_model`) and a real connection test that actually runs inference.
✅ **Voice Console**: recordings are converted to 16 kHz mono WAV in the browser when the local provider is active, so the server needs no ffmpeg for the common case.

**Remaining honest gaps (2026-10-22):** inbound email, an automated per-role endpoint sweep, live third-party provider E2E (BLOCKED_EXTERNAL — no provider credentials in this environment), and Kokoro/Piper voices in the local catalog (transformers.js v4 cannot run their model type — use an OpenAI-compatible Kokoro/Piper server instead). See [TODO.md](../TODO.md). Docker rebuilding is verified; live external provider tests remain BLOCKED_EXTERNAL (no provider credentials in this environment).

## Phase 18 — File imports, AI provider breadth, knowledge import (2026-10-23)
✅ **File inputs restored across the SPA**: customer CSV upload, setup-wizard customer/service CSV uploads, knowledge document import (PDF/DOCX/HTML/Markdown/TXT/CSV/JSON), voice-console audio-file transcription, and SAML IdP certificate upload. Shared browser helpers live in `src/lib/client/files.ts` (25 MB document cap, 5 MB CSV cap, base64/text readers, size formatting).
✅ **Knowledge extraction** (`src/lib/knowledge/extract.ts` + `POST /api/knowledge/extract`): dependency-free text/HTML/CSV/JSON plus `unpdf` PDF and `mammoth` DOCX extraction, whitespace normalization, 40 MB base64 / 2 MB text caps, owner/admin only.
✅ **Website crawl import** (`src/lib/knowledge/crawl.ts` + `POST /api/knowledge/crawl`): same-origin BFS with depth/page caps, robots.txt and sitemap handling, asset filtering, timeouts, SSRF validation through `assertOutboundUrl`, optional per-page AI cleanup with deterministic fallback, upsert by `orgId + source:'website' + externalId:url`, re-index + audit. Requires an active LLM (`409 ai_not_configured`).
✅ **AI provider breadth**: Anthropic, Google Gemini and Azure OpenAI adapters over raw HTTP (no vendor SDK), provider presets/model discovery (`POST /api/providers/[capability]/models`), native tool flags per provider, and UI controls in the AI section.
✅ **Verification**: tsc clean, lint clean, 132/132 unit tests at the end of this phase.

## Phase 19 — Email/SMS providers, Square, accounting and commerce connectors (2026-10-23)
✅ **Email provider APIs** (`email_api`): SendGrid, Mailgun, Postmark, Resend and Brevo over raw HTTP, per-provider request builders, read-only connection tests, message-id extraction, secret redaction. The outbox dispatcher prefers `email_api` over SMTP and does not double-send after an API failure.
✅ **More SMS carriers**: Telnyx, Vonage, MessageBird and Plivo added to `sms_gateway` alongside TextBee/httpSMS/Android SMS Gateway/generic HTTP, with real send/test/id-extraction and Vonage status checks. The Integrations UI now exposes provider-specific credential fields.
✅ **Square** (`square`): payment links for outstanding invoices (Stripe preferred when both are enabled) and a signature-verified webhook that resolves the order, reads invoice metadata, and records a verified payment through the idempotent `processWebhook` path.
✅ **Inbound Email (IMAP)** (`imap`): IMAP polling with per-folder config, poll interval, message caps, and `allowPrivate` for LAN servers; webhook endpoint (`/api/telephony/imap/webhook`) for real-time provider notifications (Mailgun/Postmark/SendGrid) authenticated with a per-integration `webhookSecret`; background worker with lease protection; SSRF guard (metadata endpoints always blocked, LAN opt-in) for both polling and connection tests; `mailparser` MIME decoding with HTML→text fallback; Integrations UI with full config dialog and integration-specific webhook URL. Email ingestion creates/finds customers by email, threads by `message-id` + `In-Reply-To`/`References`, persists inbound messages, triggers AI receptionist turns, and queues replies as `email` outbox messages.
✅ **Accounting push** (`quickbooks`, `xero`, `myob`): refresh-token OAuth2 with automatic token rotation stored encrypted; customer create/match + invoice posting (`POST /api/invoices/[id]/push-accounting`); provider document numbers reuse the invoice number and a prior push is refused to avoid duplicates.
✅ **Commerce/CRM sync** (`shopify`, `woocommerce`, `wix`, `mailchimp`): one-page contact pull into org-scoped Customers (`POST /api/integrations/[id]/sync`), matched by external ref/email/phone, tags unioned, SSRF guard for self-hosted WooCommerce.
✅ **UI**: new integration cards with config/credential forms, row summaries, "Sync customers" and "Push to accounting" actions, and a Square webhook URL helper.
✅ **Verification**: tsc clean, lint clean, 161/161 unit tests, 44/44 smoke checks, 11/11 IMAP security/API checks; new routes compile against the running dev server.

## Phase 20 — Invoice lifecycle and refunds (2026-10-23)
✅ **Drafts**: `POST /api/invoices {draft:true}` saves without a ledger charge; `PATCH {action:'issue'}` posts the charge exactly once and makes the invoice collectible. Payments, claims, sends, payment links and accounting pushes refuse drafts.
✅ **Issue dates and overdue**: the API accepts `issueDate`; `overdue` is derived from `dueDate` + outstanding (never stored), so it cannot go stale. The list filter and badges use the same derived state.
✅ **Refunds**: `POST /api/payments/[id]/refund` refunds a verified payment partially or fully. The original payment stays verified, a linked `source:'refund'` row + append-only `refund` ledger entry reduce `paidCents`, and the invoice reopens. Idempotent by `refund:<paymentId>:<key>`; over-refunds are rejected.
✅ **UI**: draft checkbox, issue-date input, "Issue invoice" and per-payment "Refund" actions with honest toasts.
✅ **Verification**: tsc clean, lint clean, 161/161 unit tests, 18/18 invoice lifecycle E2E checks, 44/44 smoke checks.

## Phase 21 — Telephony PABX/voicemail, notification routing and inbound SMS (2026-10-26)
✅ **PABX routing**: `twilio_voice` config gained `routingStrategy` (`receptionist`, `least_busy`, `round_robin`, `redirect`, `simultaneous`), `agentLines` (up to 20), `ringTimeoutSec`, voicemail and after-hours fields. The incoming/gather/status routes ring agents or the AI receptionist, exclude disabled/paused lines, and enforce opening hours/holidays.
✅ **Voicemail**: signature-verified `<Record>` + transcription callback (`/api/telephony/voice/voicemail`) stores recording/transcript, updates the call, notifies staff in-app/email, and can queue a caller acknowledgement SMS. Paused AI, after-hours, routed-call misses and repeated no-input all fall back to voicemail when enabled.
✅ **Notification routing** (`src/lib/notifications/policy.ts`, `/api/settings/notifications`): org-wide customer event × channel matrix (service/booking/invoice/reminder/marketing), staff alerts (missed call, voicemail, escalation, integration failure), silent quiet hours with deferral for reminders/marketing, and consent requirements. The outbox dispatcher enforces it before delivery and records `status:'skipped'` honestly when suppressed.
✅ **Per-customer preferences**: `Customer.commPrefs` JSON (partial opt-ins, marketing default off) exposed through the customers API and edit dialog, with channel badges in the customer detail view.
✅ **Inbound SMS**: shared `ingestInboundSms`/`replyToInboundSms` pipeline for Twilio and all `sms_gateway` providers (`/api/telephony/sms/gateway-incoming`, org slug + timing-safe webhook secret). STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT opt out and acknowledge; START/UNSTOP/RESUME opt in. Handles dedupe, AI pause, escalation and queued replies.
✅ **Provider breadth**: Mailjet, SparkPost and Elastic Email for `email_api`; Sinch, Infobip and ClickSend for `sms_gateway` (request builders, tests, credential fields, readiness).
✅ **Demo seed**: writes the default notification config and varied customer channel prefs.
✅ **Verification**: tsc clean, lint clean, 177/177 unit tests.

## Phase 22 — Receptionist schedule, direct Meta WhatsApp and staff alert wiring (2026-10-27)
✅ **Receptionist weekly schedule**: `src/lib/receptionist/schedule.ts` (pure, unit-tested) + `runtime.ts` combine the operator switch with per-day windows in the org fixed-offset timezone. `GET/PATCH /api/settings/receptionist` read and save the `receptionist_schedule` AppSetting (no schema change), audit both actions, and return `status`, `baseStatus`, `scheduledOff`, `nextOpenAt` and the normalized schedule. Every inbound channel uses `resolveReceptionistStatus`; outside hours behaves like `paused` (inbound recorded, no AI reply). `/api/session` includes the effective state and schedule, and the dashboard has a Monday–Sunday editor with closed-day switches, overnight support, and an explicit "the running/paused switch always wins" note.
✅ **Direct Meta WhatsApp Cloud API** (`meta_whatsapp`): phone-number-ID lookup, real Graph `GET` connection test, text sends with Meta message ids, `x-hub-signature-256` HMAC verification, GET challenge handshake, idempotent inbound text ingestion, AI replies, and outbox fallback. The outbox `whatsapp` channel prefers Twilio then Meta; readiness/UI/config/credentials and the exact callback URL are wired.
✅ **Staff alert wiring**: `notifyStaffEvent`/`notifyEscalation` in `src/lib/notifications/staff.ts` make the staff notification matrix real for missed calls, voicemail, escalations and permanently failed outbox deliveries. In-app and email rows honour the configured channels instead of always being created; voicemail/missed-call alerts now use `telephony_call` context so the voicemail policy applies.
✅ **Provider docs in the UI**: every catalog kind has an official documentation URL, and email/SMS dialogs link to the selected provider's setup docs (SendGrid, Mailgun, Postmark, Resend, Brevo, Mailjet, SparkPost, Elastic Email, TextBee, httpSMS, Android SMS Gateway, Telnyx, Vonage, MessageBird, Plivo, Sinch, Infobip, ClickSend, generic HTTP).
✅ **Seed**: demo org writes the disabled default weekly schedule alongside notification routing and customer preferences.
✅ **Verification**: tsc clean, lint clean, 187/187 unit tests (10 new schedule tests), 44/44 smoke checks.
