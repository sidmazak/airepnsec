# Iteration Log — AI Secretary

Append-only. Newest at the bottom.

---

## Iteration 1 — 2026-10-15 — Full audit + Phase 0 remediation

### Objective
First pass of the master audit/implement loop: establish an evidence-based audit and fix the
highest-severity (P0) correctness/security/integrity issues without regressing the product.

### Recon
Five parallel read-only passes (AI/RAG, communications, business+security, frontend/API, tests/infra).
Findings verified by direct source reading before changes. Deliverables written to `docs/AUDIT/`.

### Changes
- **Added** `src/app/api/providers/[capability]/test/route.ts` — wires the previously dead
  `runAndStoreTest`; real per-capability connectivity/model test; stores `lastTest*`; audited.
- **Added** `src/app/api/integrations/[id]/test/route.ts` — wires the previously dead
  `testIntegration`; real authenticated test; stores `lastTest*`; audited.
- **Fixed** `src/lib/business/payments.ts`:
  - `recordPaymentClaim`: reject when already paid or amount > outstanding (`overpay`).
  - `verifyPayment`: re-check void + reject when amount > outstanding (`overpay`).
- **Fixed** RBAC: `{ roles }` on customers create/import/patch/delete
  (create/patch → owner/admin/agent; import/delete → owner/admin).
- **Fixed** `src/lib/datasources/adapters.ts`:
  - `assertReadOnlySql`: expanded blocklist (`into, copy, call, do, execute, set, load, outfile,
    dumpfile, load_file, load_extension, reindex, detach, ...`).
  - `assertUrlAllowed`: now async, resolves hostname via `node:dns/promises` and rejects any private
    resolved address (SSRF / DNS-to-private). Caller awaits.
- **Fixed** `src/lib/ai/providers.ts`: capability-aware default providers; `rerank`/`vision` default
  `none` and `testProvider` reports not-implemented honestly.
- **Fixed** `src/lib/integrations/connectors.ts`: SMTP test surfaces `err.code` when message empty.
- **Hardening** `.gitignore`: ignore `/.data/ /db/ /backups/ /.models/ *.db *.sqlite *.sqlite3`;
  `git rm -r --cached` those (files kept on disk). **Rotate `.data/secret.key` if repo was pushed.**

### Verification (live dev server, demo org)
- `npx tsc --noEmit` → 0 project errors. `npm run lint` → clean.
- Provider test: embedding ok (384-d), rerank honest not-implemented, unknown cap 404.
- Integration test: honest failures for down services (CalDAV/SMTP/webhook).
- Payments: claim overpay 409; verify-overpay 409 (outstanding 0); void claim 409; happy path verified; re-verify idempotent.
- RBAC: viewer GET 200; POST/PATCH/DELETE 403.
- SQL guard: `INTO OUTFILE`/`INTO dumpfile`/`load_file`/`; DROP` rejected; benign + `WITH` allowed.
- SSRF: loopback literal blocked; `127.0.0.1.nip.io` DNS→private blocked.
- Note: a stale Turbopack dev compile masked the payments guard initially; resolved by touching the
  route file. No source defect.

### Known limitations surfaced (OPEN)
SMS gateway abstraction (G1), inbound email (G2), rerank/vision (G3), streaming/native tools (G4),
hardware detection/catalog (G5), queue/channel mismatch (G6), security headers/middleware (G7),
no automated tests/CI (G8), DNS-rebind TOCTOU (S10), outbound-webhook SSRF (S11).

### Blocked (external)
Real Ollama/OpenAI-compatible endpoints, pg/mysql servers, SIP/PSTN telephony, real SMS gateways,
Docker daemon — not available in this environment; documented, not faked.

---

## Iteration 2 — 2026-10-22 — Concurrency, PABX routing, deployment hardening, docs refresh

### Objective
Close production-readiness gaps around concurrent turns/workers, telephone routing, static/Docker
packaging, and bring the documentation set back in line with the shipped code.

### Changes
- **Worker leases:** added `WorkerLease` and `src/lib/concurrency.ts` (`runWithWorkerLease`,
  TTL recovery, status reporting). Automation tick, outbox dispatch and data-source sync are
  single-flight across instances; manual endpoints return `409 worker_busy` / `sync_busy`.
- **Conversation turn lock:** DB-backed per-conversation lock with token + stale TTL wraps the
  receptionist turn; overlapping SMS/web/voice turns serialize; busy → `409 conversation_busy`.
- **SQLite tuning:** WAL, 5000 ms busy timeout and `synchronous=NORMAL` at boot; `/api/health/detail`
  now returns live `database` tuning plus `workers` statuses.
- **PABX routing:** new pure helpers (`normalizeAgentLines`, `buildLineCandidates`,
  `pickLeastBusy`, `pickRoundRobin`, `pickRedirect`, `normalizeCallStatus`) and shared no-input
  state. Incoming/status/gather routes route by least-busy/round-robin/redirect, honor
  disabled/paused lines, count real active calls, record `TelephonyCall` for every call, and
  prefer Twilio `DialCallStatus`.
- **Rate limiting/auth:** per-IP login limit (30/min) beside per-email (10/min); configurable
  `withPublic` limits; telephony webhooks raised to 300–600/min; exported `clientIp`.
- **Docker:** `DATABASE_PROVIDER` build arg (`sqlite|postgresql`), standalone `.next/static` and
  `public/` copies, OpenSSL; compose sets Postgres. Build-time placeholders keep `next build`
  independent of runtime secrets.
- **Next config:** `typescript.ignoreBuildErrors: false`, `reactStrictMode: true`.
- **UI:** favicon fixed (`/logo.svg`), Radix dialog description IDs removed from six sections,
  integrations credentials dialog wrapped in a real form. Remaining low-priority DOM warning for
  password fields outside forms in AI Providers/Security is tracked.
- **Provider truthfulness:** server STT no longer advertises an Ollama kind it cannot serve (browser
  or OpenAI-compatible only).
- **Tests:** `tests/unit/telephony-routing.test.mts` added; suite is now 27/27.
- **Docs:** README, implementation plan, feature/provider matrices, audits, security, architecture,
  API, data model, integrations, self-hosting, test plan and infra README refreshed for 30 models,
  97 route files / 122 handlers, 18 sections and the current gaps.

### Verification
- `npx tsc --noEmit` → clean; `npm run lint` → clean; `npm run test:unit` → 27/27 pass.
- Live dev server: SQLite WAL/busy timeout confirmed; health detail shows DB + workers; manual
  automation/outbox 200 when idle; manual automation 409 `worker_busy` while the lease is held.
- Browser CDP pass: sections render, favicon 404 gone, dialog description warning gone; expected
  console noise limited to password-form semantics (non-integration inputs) and an honest SMTP
  test failure.
- Docker images: both PostgreSQL and SQLite profiles rebuilt and smoke-tested on 2026-10-22.

### Remaining honest gaps
SSO (SAML/OIDC), inbound email, rerank/vision, streaming/native tool calling, hardware/model
catalog, shared-store rate limiting, committed browser/role-matrix suites, live gateway/provider
credential tests. Docker rebuild verification completed 2026-10-22.

### Blocked (external)
Real Ollama/OpenAI-compatible endpoints, pg/mysql servers, SIP/PSTN and SMS hardware, Docker daemon —
not available here; behavior is documented, not faked.

## 2026-10-26 — Phase 21: PABX/voicemail, notification routing, inbound SMS
- Added Twilio voice PABX strategies (incl. simultaneous ring), ring timeout, after-hours actions, voicemail `<Record>` + transcript callback, missed-call staff alerts and caller ack SMS.
- Added org notification routing (`/api/settings/notifications`) with customer event × channel matrix, staff alerts, quiet hours/deferral and consent requirements; dispatcher now records `skipped` honestly.
- Added `Customer.commPrefs` per-channel preferences (API + customer dialog + detail badges); bumped Prisma client version to 7.
- Added inbound SMS for all `sms_gateway` providers via signed `/api/telephony/sms/gateway-incoming`; shared STOP/START consent pipeline with Twilio inbound.
- Added email providers Mailjet/SparkPost/Elastic Email and SMS providers Sinch/Infobip/ClickSend (builders, tests, credential UI, readiness).
- Updated demo seed, docs and backlog. Verification: tsc clean, lint clean, 177/177 unit tests.

## 2026-10-27 — Phase 22: schedule, Meta WhatsApp, staff alert wiring
- Added a weekly receptionist schedule stored in the `receptionist_schedule` AppSetting; every inbound channel now resolves an effective `paused` state outside hours, and `/api/session` + the dashboard expose/edit it.
- Added direct Meta WhatsApp Cloud API (`meta_whatsapp`): Graph send/test, HMAC-verified webhook handshake, idempotent ingestion, AI replies, outbox fallback and full UI credentials.
- Wired staff alerts for real: `notifyStaffEvent`/`notifyEscalation` honour the staff channel matrix for missed calls, voicemail, escalations and permanently failed deliveries; removed the unconditional in-app rows.
- Added official documentation links for every catalog kind and each email/SMS provider in the configuration dialog.
- Demo seed writes the default schedule; docs (API, integrations, data model, matrices, plan) updated.
- Verification: tsc clean, lint clean, 187/187 unit tests, 44/44 smoke checks.

## 2026-10-27 — Phase 23: delivery receipts (DLR)
- Added `OutboxMessage` provider/delivery fields (`providerKind`, `providerMessageId`, `deliveryStatus`, `deliveryDetail`, `deliveryUpdatedAt`) with an org/provider/message-id index; bumped the Prisma global client to v9.
- Stored Twilio `sid`, Meta message ids and SMS-gateway ids when sending; direct AI replies and consent acks are recorded as sent delivery rows.
- Added signature-verified Twilio status callbacks (`/api/telephony/sms/status`) and signed carrier DLRs (`/api/telephony/sms/dlr`) parsing Infobip/ClickSend/Sinch/generic payloads; Meta `statuses[]` handled in the existing webhook.
- Delivery states are monotonic and honest: `accepted → delivered → read`, `failed` terminal; a late lower-rank receipt cannot regress a row. UI shows provider delivery detail; docs/API/integration matrices updated.
- Verification: tsc clean, lint clean, 193/193 unit tests (6 new delivery-receipt tests), 44/44 smoke checks.
