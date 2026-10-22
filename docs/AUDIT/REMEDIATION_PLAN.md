# Remediation Plan — AI Secretary

Phased. Each item lists severity, deliverable, and verification. Priority order: unsafe/broken
existing behavior → money/core correctness → requested features → polish.

## Phase 0 — Stop the bleeding (DONE, iteration 1)
- [x] **S4** verifyPayment overpay + void recheck.
- [x] **S5** recordPaymentClaim outstanding guard.
- [x] **S1** role gates on customer create/import/patch/delete.
- [x] **S8** harden `assertReadOnlySql`.
- [x] **S9** SSRF post-DNS resolution check.
- [x] **S13** gitignore + untrack secrets/db/models/backups (rotate historical key if pushed).
- [x] **F7/F8** provider + integration test routes.
- [x] **F9** honest provider defaults; rerank/vision report not-implemented.
- Verification: tsc 0 errors, lint clean, E2E scenarios pass.

## Phase 1 — Correctness & honesty (DONE, iterations 1–2)
- [x] **G6** unify queue-vs-send channel detection (`queueInvoiceReminder` ↔ dispatcher).
- [x] **G7** security headers (implemented centrally in `next.config.ts`; docs corrected).
- [x] **G8/Test** Node `node:test` unit suite (27 cases) + CI (tsc, lint, tests, build).
- [x] Persistent session revocation (`Session.revokedAt`, revoke-all).
- [x] 2FA (TOTP) enrollment, login challenge, disable with password+code.
- [x] API/docs contract corrections (iteration 2).
- [ ] **S11** SSRF-guard outbound `webhook_out` destinations (reuse adapter guard).
- [ ] Rotate `.data/secret.key` / APP_SECRET if the repo or DB was ever exposed.

## Phase 2 — Requested features (mostly delivered)
- [x] **G1 SMS gateway abstraction**: `sms_gateway` kind + TextBee, httpSMS, android-sms-gateway,
      generic HTTP adapters; per-send delivery state that never treats HTTP 200 as "delivered".
- [x] Inbound WhatsApp (Twilio), including signature verification and opt-out.
- [x] Two-way CalDAV (remote cancels/moves applied through the booking service).
- [x] Per-kind integration connection tests exposed over HTTP.
- [ ] **G2 Inbound email**: IMAP poller or provider webhook → conversation/message ingest.
- [ ] **G5 Hardware detection + model catalog**: CPU/RAM/GPU probe + recommended local models.
- [ ] **G3 rerank**: implement via an OpenAI-compatible `/rerank` and wire into `searchKnowledge`.
- [ ] **G4 streaming + native tool-calling** where the provider supports it.
- [ ] **Vision**: image understanding in the receptionist/inbox.

## Phase 3 — Hardening & scale
- [x] **S10 partial**: DNS-aware SSRF check; pinning the resolved IP remains open.
- [x] **S18** per-conversation turn lock for overlapping SMS/web/voice turns.
- [x] **S19** DB worker leases for automation/outbox/data-source sync.
- [x] **S20** SQLite WAL + busy timeout tuning; live reporting in Diagnostics.
- [x] **S21/S22** per-IP login limit; telephony-specific rate limits.
- [x] Docker standalone static/public + provider build arg; OpenSSL installed.
- [ ] Shared-store rate limiter (multi-instance).
- [ ] Role-matrix test hitting every mutating route × every role.
- [ ] RAG vector index for scale; PDF/DOCX ingestion; relevance benchmarks.
- [ ] Voice Console server-side preference persistence.
- [x] Rebuild and smoke-test current Docker images (PostgreSQL + SQLite) — 2026-10-22.

## Definition of done (per item)
Code + `tsc` clean + `lint` clean + E2E evidence (request/response) + audit entry + docs updated.
Nothing marked DONE unless observed working. External-only items marked **BLOCKED_EXTERNAL**.
