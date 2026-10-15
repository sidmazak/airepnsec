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
