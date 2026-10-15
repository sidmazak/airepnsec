# Security Audit — AI Secretary

Severity: **P0** critical/money/secret, **P1** high, **P2** medium, **P3** low.
Status: **FIXED** = remediated + E2E-verified this iteration; **OPEN** = tracked in REMEDIATION_PLAN.

## Authn / Authz
| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| S1 | P0 | Customer `PATCH`/`DELETE` (and `POST` create / `import`) had **no role gate** → a `viewer` could create, edit, and delete customers. | `src/app/api/customers/[id]/route.ts`, `customers/route.ts`, `customers/import/route.ts` now pass `{ roles }`. | **FIXED** — viewer E2E: GET 200; POST/PATCH/DELETE 403. |
| S2 | P3 | Custom session cookies: `HttpOnly; SameSite=Strict`, `Secure` only in production. | `src/lib/api.ts` `sessionCookie()`. | OK |
| S3 | P2 | No `middleware.ts` / global security headers, despite README + TEST_PLAN claiming them. | repo-wide absence. | OPEN (G7) |

## Financial integrity
| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| S4 | P0 | `verifyPayment` did not re-check invoice **void** status and had **no outstanding/overpay guard** → a pending claim could settle beyond balance. | `src/lib/business/payments.ts` `verifyPayment`. | **FIXED** — E2E: verify after settlement → 409 `overpay` (outstanding 0). |
| S5 | P0 | `recordPaymentClaim` checked void but **not outstanding** → over-claims accepted. | `src/lib/business/payments.ts` `recordPaymentClaim`. | **FIXED** — E2E: claim 20000 on 10000 invoice → 409 `overpay`. |
| S6 | P1 | Webhook path relies on HMAC; `verifyWebhookSignature` returns false on empty secret (fails closed). | `payments.ts`. | OK (review) |
| S7 | P3 | Idempotency keys respected for payments + webhook events. | `recordVerifiedPayment`, `processWebhook`. | OK |

## Injection / SSRF
| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| S8 | P0 | Read-only SQL guard blocklist omitted `into, copy, call, do, execute, set, load, outfile, dumpfile, load_file, load_extension, reindex, detach` → `SELECT ... INTO OUTFILE` bypassed. | `src/lib/datasources/adapters.ts` `assertReadOnlySql`. | **FIXED** — E2E: `INTO OUTFILE`/`INTO dumpfile`/`load_file`/`; DROP` all rejected; benign + CTE allowed. |
| S9 | P0 | SSRF guard checked only the literal hostname → `127.0.0.1.nip.io` resolved privately but passed. | `adapters.ts` `assertUrlAllowed`. | **FIXED** — now resolves via `node:dns/promises` and rejects any private resolved address; E2E confirmed distinct "resolves to a private/local address" message. |
| S10 | P2 | TOCTOU: DNS can rebind between the resolution check and the fetch. | `adapters.ts`. | OPEN (documented limitation). |
| S11 | P2 | `testWebhookOut` / outbound `webhook_out` POST to an admin-supplied URL without SSRF guard. | `src/lib/integrations/connectors.ts`. | OPEN (owner/admin-configured; lower risk). |
| S12 | P3 | SQL guard fails closed on string literals containing keywords (e.g. `LIKE '%delete%'`). | `adapters.ts`. | Accepted tradeoff (safe). |

## Secrets / data-at-rest
| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| S13 | P0 | `.data/secret.key` (AES-256-GCM key), `db/custom.db`, `backups/*.db`, `.models/*`, and `.env` were **tracked in git**. | `git ls-files`. | **FIXED** — added to `.gitignore` + `git rm --cached` (files kept on disk). Added `.env.example` (with `!.env.example` negation) so fresh clones still configure. Key remains in prior history → **rotate if repo was pushed**. |
| S14 | P1 | Provider/integration secrets AES-256-GCM encrypted; never returned after save. | `src/lib/crypto.ts`, `providers.ts`, `kinds.ts`. | OK |
| S15 | P2 | Error messages sanitized against secret values + truncated. | `connectors.ts` `sanitizeMessage`. | OK (SMTP non-Error fallback improved to surface `code`). |

## Policy
| ID | Sev | Finding | Status |
|---|---|---|---|
| S16 | P1 | `assertAiPolicy` blocks cloud providers under `local_only`. | OK |
| S17 | P3 | Fewer than expected rate-limit distinctions; single 120/min/IP/route bucket. | OK for single-tenant. |

## Test artifacts
- Temporary viewer user/session and the guard test suite were removed; test SQLite files live under the OS temp dir, not the repo.
