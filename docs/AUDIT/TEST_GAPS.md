# Test Gaps — AI Secretary

## Current state
- `tests/` contains **3 shell scripts** (infra/build smoke), **no test framework**.
- Verification today = `npx tsc --noEmit` + `npm run lint` + manual/E2E via the running dev server + `dev.log`.
- No CI configuration.
- `AGENTS.md` forbids test-framework code in this sandbox; verification is behavioral.

## Covered this iteration (manual E2E, live server)
- Provider test route: embedding (384-d ok), rerank (honest not-implemented), unknown capability (404).
- Integration test route: 3 integrations (honest failures when services down), SMTP error now surfaces `code`.
- Payment integrity: claim overpay 409, verify-overpay 409, void claim 409, happy path verified, re-verify idempotent.
- Customer RBAC: viewer GET 200; POST/PATCH/DELETE 403.
- SQL guard: `INTO OUTFILE`/`INTO dumpfile`/`load_file`/`; DROP` rejected; benign + CTE allowed.
- SSRF: loopback literal blocked; `127.0.0.1.nip.io` (DNS→private) blocked.

## Gaps
| Area | Gap | Priority |
|---|---|---|
| Automated tests | No unit/integration harness; no regression net for money logic. | P2 |
| CI | No pipeline running tsc/lint/E2E. | P2 |
| Payments | No test for concurrent double-verify race. | P2 |
| Authz | No matrix test for every role × every mutating route. | P2 |
| SSRF | No test for DNS rebinding (S10). | P3 |
| RAG | No scale/perf test; no relevance benchmarks. | P3 |
| Voice/SMS | No end-to-end telephony test (requires real gateway). | P2 |
| Providers | No test against real Ollama/OpenAI-compatible endpoints (BLOCKED_EXTERNAL). | P2 |
| Data sources | pg/mysql adapters untested against real servers (only sqlite here). | P2 |

## Recommended next
1. Add a lightweight `node:test` suite (kept separate from app build) for pure business functions:
   `invoiceOutstanding`, `recordVerifiedPayment` guards, `assertReadOnlySql`.
2. Add a role-matrix script hitting every mutating route with owner/admin/agent/viewer sessions.
3. Add CI: `tsc --noEmit`, `npm run lint`, and the above scripts.
