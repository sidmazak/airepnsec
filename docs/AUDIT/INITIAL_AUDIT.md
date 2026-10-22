# Initial Audit — AI Secretary

> **Historical document (iteration 1, 2026-10-15).** Kept as the baseline record. Findings marked
> OPEN there may have been fixed in iteration 2; the current security state is in
> [SECURITY_AUDIT.md](./SECURITY_AUDIT.md) and [ITERATION_LOG.md](./ITERATION_LOG.md).

Generated: 2026-10-15 · Iteration: 1 · Scope: full repo (`src/`, `prisma/`, `docs/`, `infra/`)

## 1. What this system is
Self-hosted AI business assistant. Single Next.js 16 App Router project, one user-visible route `/`
(SPA with client-side sections). All backend logic in `/api/*` route handlers over Prisma/SQLite.
Modules: receptionist (LLM tool loop), bookings, invoices + append-only ledger, payments,
knowledge/RAG, automations, integrations (channels), BYO data sources, voice.

## 2. Method
Five parallel read-only reconnaissance passes over: (a) AI provider + RAG layer, (b) communications
layer, (c) business + security core, (d) frontend/UI/wizard/API surface, (e) tests/infra/docs.
Findings were verified by reading source directly before any change. Runtime facts confirmed by
running E2E requests against the live dev server (`localhost:3000`) with the demo org.

## 3. Runtime facts (verified)
- Node.js v26.8.1 + npm 11.19.0. **Bun fully removed** (iteration 12); `bun.lock` deleted,
  `package-lock.json` is the source of truth, `.npmrc` sets `legacy-peer-deps=true`.
- Prisma 6.19.2 client, SQLite via `DATABASE_URL="file:../db/custom.db"`.
- Dev server runs; demo login `demo@aisecretary.local` / `demo-1234` works; `/api/health` 200.

## 4. Top findings (this iteration)
| # | Sev | Finding | Status |
|---|-----|---------|--------|
| F1 | **P0** | `verifyPayment` had no outstanding/overpay guard and no void re-check → unverified amount could settle an invoice beyond balance. | **FIXED** |
| F2 | **P0** | `recordPaymentClaim` checked void but not outstanding → over-claims accepted. | **FIXED** |
| F3 | **P0** | `PATCH`/`DELETE /api/customers/[id]` (and `POST` create/import) used plain `withAuth` with **no role gate** → viewers could create/edit/delete customers. | **FIXED** |
| F4 | **P0** | Read-only SQL guard omitted `into/copy/call/do/execute/set/load/outfile/...` → `SELECT ... INTO OUTFILE` passed. | **FIXED** |
| F5 | **P0** | SSRF guard checked only the literal hostname → DNS names resolving to private IPs bypassed it. | **FIXED** |
| F6 | **P0** | `.data/secret.key` (AES key), `db/custom.db`, `backups/*.db`, `.models/*`, `.env` were **tracked in git**. | **FIXED (untracked + .env.example)** |
| F7 | **P1** | `POST /api/providers/[capability]/test` route **missing** (`runAndStoreTest` dead code) → AI "Test connection" 404s. | **FIXED** |
| F8 | **P1** | `POST /api/integrations/[id]/test` route **missing** (`testIntegration` dead code) → Integration "Test" 404s. | **FIXED** |
| F9 | **P1** | `rerank`/`vision` capabilities have no implementation, yet defaulted to `browser` and reported "ok". | **FIXED (honest)** |
| G1 | **P2** | SMS hard-coded to Twilio (`sendTwilio`); no gateway abstraction (TextBee/httpSMS/Android SMS Gateway unsupported). | OPEN |
| G2 | **P2** | Inbound email not implemented (outbound SMTP only). | OPEN |
| G3 | **P2** | `rerank` and `vision` capabilities unimplemented (declared in CAPABILITIES). | OPEN (now honest) |
| G4 | **P2** | No streaming/native tool-calling (prompt-based JSON). | OPEN |
| G5 | **P2** | No hardware detection / model catalog / auto model selection. | OPEN |
| G6 | **P2** | Queue-vs-send mismatch: `queueInvoiceReminder` keys off `AppSetting`, dispatcher off `Integration`. | OPEN |
| G7 | **P2** | No security headers / `middleware.ts`, though README/TEST_PLAN claim they exist. | OPEN |
| G8 | **P3** | `tests/` = 3 shell scripts, no real test framework; no CI. | OPEN |

## 5. Honesty invariants confirmed
- Queued ≠ sent: outbox rows are distinct from provider dispatch; dispatcher is the only sender.
- Claim ≠ paid: `recordPaymentClaim` writes `pending_verification`; only owner/admin verify.
- Test-mode ≠ executed: integrations expose `testMode`; test routes now perform **real** network checks.

## 6. Deliverables in this folder
FEATURE_MATRIX, PROVIDER_MATRIX, MODEL_COMPATIBILITY_MATRIX, RAG_AUDIT, SECURITY_AUDIT,
LICENSING_AUDIT, TEST_GAPS, REMEDIATION_PLAN, ITERATION_LOG.
