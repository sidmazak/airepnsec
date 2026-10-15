# Remediation Plan — AI Secretary

Phased. Each item lists severity, deliverable, and verification. Priority order: unsafe/broken
existing behavior → money/core correctness → requested features → polish.

## Phase 0 — Stop the bleeding (DONE this iteration)
- [x] **S4** verifyPayment overpay + void recheck.
- [x] **S5** recordPaymentClaim outstanding guard.
- [x] **S1** role gates on customer create/import/patch/delete.
- [x] **S8** harden `assertReadOnlySql`.
- [x] **S9** SSRF post-DNS resolution check.
- [x] **S13** gitignore + untrack secrets/db/models/backups.
- [x] **F7/F8** add provider + integration test routes (restore advertised functionality).
- [x] **F9** honest provider defaults; rerank/vision report not-implemented.
- Verification: tsc 0 errors, lint clean, all E2E scenarios above pass.

## Phase 1 — Correctness & honesty (next)
- [ ] **G6** unify queue-vs-send channel detection (`queueInvoiceReminder` ↔ dispatcher).
- [ ] **G7** add `middleware.ts` security headers; correct README/TEST_PLAN claims if not added.
- [ ] **S11** SSRF-guard outbound `webhook_out` destination (reuse adapter guard).
- [ ] Rotate `.data/secret.key` if the repo was ever pushed (S13 history).
- [ ] Payload/response contract diff vs `docs/API.md`; update docs to match code.

## Phase 2 — Requested features (high value)
- [ ] **G1 SMS gateway abstraction**: `SmsGatewayProvider` interface + adapters:
      Twilio (existing), generic HTTP (`gateway base URL + api key + method`), TextBee, httpSMS,
      Android SMS Gateway. Per-org selection; real test per gateway; status callbacks.
      *License-check each reference first (LICENSING_AUDIT).*
- [ ] **G2 Inbound email**: IMAP poller or provider webhook → conversation/message ingest.
- [ ] **G5 Hardware detection + model catalog**: `/api/system/capabilities` (CPU/RAM/GPU probe) +
      recommended local model list + one-click Ollama model pull guidance.
- [ ] **G3 rerank**: implement via `openai_compatible /rerank` and wire into `searchKnowledge`.
- [ ] **G4 streaming + native tool-calling** where provider supports it.
- [ ] **Vision**: image understanding path in receptionist/inbox.

## Phase 3 — Hardening & scale
- [ ] **S10** pin resolved IP for outbound fetch (close DNS-rebind TOCTOU).
- [ ] **G8/Test** add `node:test` suite + role-matrix script + CI.
- [ ] RAG: vector index for scale; PDF/DOCX ingestion; relevance benchmarks.
- [ ] Voice Console server-side preference persistence.

## Definition of done (per item)
Code + `tsc` clean + `lint` clean + E2E evidence (request/response) + audit entry + docs updated.
Nothing marked DONE unless observed working. External-only items marked **BLOCKED_EXTERNAL**.
