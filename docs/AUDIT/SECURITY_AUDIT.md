# Security Audit — AI Secretary

Severity: **P0** critical/money/secret, **P1** high, **P2** medium, **P3** low.
Status: **FIXED** = remediated and verified; **OPEN** = tracked in REMEDIATION_PLAN.

## Authn / Authz
| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| S1 | P0 | Customer `PATCH`/`DELETE` (and create/import) had **no role gate** → a `viewer` could mutate customers. | `customers/[id]/route.ts`, `customers/route.ts`, `customers/import/route.ts` pass `{ roles }`. | **FIXED** — viewer E2E: GET 200; POST/PATCH/DELETE 403. |
| S2 | P3 | Session cookie flags. | Random token, SHA-256 hash in `Session`; `HttpOnly; SameSite=Strict`, `Secure` in production. | OK |
| S3 | P2 | No global security headers despite docs claiming them. | `next.config.ts` now sets nosniff, frame denial, referrer policy, permissions policy, COOP, HSTS (production) and CSP. No `middleware.ts` is needed. | **FIXED** (iteration 2) |
| S17 | P3 | Single coarse rate-limit bucket. | `withAuth` default 120/min; `withPublic` accepts per-route `rateLimit`; login adds per-IP 30/min and per-email 10/min; telephony webhooks 300–600/min. | **FIXED** (iteration 2) |

## Financial integrity
| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| S4 | P0 | `verifyPayment` did not re-check void and had no outstanding/overpay guard. | `src/lib/business/payments.ts`. | **FIXED** — verify after settlement → 409 `overpay`. |
| S5 | P0 | `recordPaymentClaim` accepted over-claims. | `src/lib/business/payments.ts`. | **FIXED** — claim 20000 on 10000 invoice → 409. |
| S6 | P1 | Webhook path relies on HMAC; empty secret fails closed. | `payments.ts`. | OK |
| S7 | P3 | Payment/webhook idempotency. | `recordVerifiedPayment`, `processWebhook`. | OK |

## Injection / SSRF
| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| S8 | P0 | Read-only SQL blocklist bypass (`SELECT ... INTO OUTFILE`, etc.). | `src/lib/datasources/adapters.ts` `assertReadOnlySql`. | **FIXED** — E2E rejects INTO OUTFILE/dumpfile/load_file/multi-statement. |
| S9 | P0 | SSRF guard checked literal hostname only (`127.0.0.1.nip.io` passed). | Shared `src/lib/security/outbound.ts` resolves DNS via `node:dns/promises` and rejects private addresses. | **FIXED** — E2E verified. |
| S10 | P2 | DNS-rebind TOCTOU between resolution and fetch. | `src/lib/security/outbound.ts`. | OPEN (documented limitation; no IP pinning). |
| S11 | P2 | Outbound `webhook_out` POST to an admin-supplied URL without SSRF guard. | `connectors.ts` test/delivery + `dispatcher.ts` call `assertOutboundUrl`; private targets require explicit `allowPrivate` opt-in. | **FIXED** — unit tests + live API check blocked `127.0.0.1`. |
| S12 | P3 | SQL guard fails closed on string literals containing keywords. | `adapters.ts`. | Accepted tradeoff. |

## Concurrency / availability
| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| S18 | P1 | Overlapping SMS/web/voice turns for the same conversation could interleave (double booking/tool races). | `src/lib/concurrency.ts` `withConversationTurnLock` wraps the receptionist turn; DB token + stale TTL; busy turns return `409 conversation_busy`. | **FIXED** (iteration 2) |
| S19 | P2 | Automation/outbox/data-source workers and manual "run now" could duplicate work across instances. | `WorkerLease` + `runWithWorkerLease` with TTL recovery; manual routes return `409 worker_busy`/`sync_busy`. | **FIXED** (iteration 2); busy path live-verified. |
| S20 | P2 | SQLite `database is locked` under concurrent writes. | `src/lib/db-tuning.ts` sets WAL, `busy_timeout=5000`, `synchronous=NORMAL`; health/detail reports live values. | **FIXED** (iteration 2) |
| S21 | P3 | Login had no per-IP limit. | `/api/auth/login` adds `login-ip:<ip>` 30/min alongside per-email 10/min. | **FIXED** (iteration 2) |
| S22 | P3 | Telephony webhook buckets too low for call storms. | Voice incoming 300/min; gather/status 600/min; SMS/WhatsApp 300/min. | **FIXED** (iteration 2) |

## Secrets / data-at-rest
| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| S13 | P0 | `.data/secret.key`, DB, backups, models and `.env` were tracked in git. | `git ls-files`. | **FIXED** — gitignored + untracked; **rotate if the repo was ever pushed** (history still contains old key material). |
| S14 | P1 | Provider/integration secrets encrypted; never returned after save. | `src/lib/crypto.ts`, providers, integrations. | OK |
| S15 | P2 | Error messages sanitized against secret values + truncated. | `connectors.ts` `sanitizeMessage`. | OK |

## Policy
| ID | Sev | Finding | Status |
|---|---|---|---|
| S16 | P1 | `assertAiPolicy` blocks external OpenAI-compatible endpoints under `local_only`; private/LAN endpoints remain allowed. | OK |
| S23 | P3 | Session revocation was in-memory only. | **FIXED** — `Session.revokedAt`, logout revokes row, revoke-all endpoint; survives restarts. |

## Iteration 2 verification (2026-10-22)
- tsc clean; ESLint clean; 32/32 unit tests (telephony routing, SMS adapters, TTS chunking, SQL guard, TOTP, outbound URL guard).
- `/api/health/detail` shows `database: {kind:sqlite, journalMode:wal, busyTimeoutMs:5000}` and live worker lease status.
- Holding the automation lease manually made `POST /api/automations/run` return `409 worker_busy`; released cleanly afterwards.
- Browser pass: all sections render; favicon 404 fixed; Radix dialog description warning fixed; integration credentials dialog wrapped in a form.
- Not live-tested in this environment: conversation-lock contention under real concurrent SMS, external provider credentials. Docker images for both profiles were rebuilt and smoke-tested on 2026-10-22.

## Test artifacts
Temporary viewer/session fixtures were removed; test SQLite files live under the OS temp dir, not the repo.
