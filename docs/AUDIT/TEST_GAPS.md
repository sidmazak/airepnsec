# Test Gaps — AI Secretary

## Current state (2026-10-23)
- **Unit suite:** `tests/unit/*.mts` via `npm run test:unit` (Node's built-in `node:test` + `--experimental-strip-types`) — **161 passing cases**:
  - SMS gateway adapters: phone normalization, provider ids, request building (TextBee/httpSMS/generic HTTP), message-id extraction, delivery-state honesty, test probes.
  - TTS chunking (sentence boundaries, hard splits).
  - Read-only SQL guard (benign SELECT/WITH accepted; mutations rejected).
  - TOTP (base32 round-trip, RFC 6238 vectors, ±1 step, URI).
  - Telephony routing (line normalization, disabled/paused exclusion, load by line id, least-busy, round-robin, redirect, Twilio status mapping).
  - Outbound URL/SSRF guard (private IPv4/IPv6 ranges, protocol rejection, explicit private opt-in, public literal IPs).
  - Invoice lifecycle math (draft/paid/partial/refund reopening, derived overdue, outstanding clamp).
  - AI provider adapters (Anthropic, Gemini, Azure), knowledge extraction/crawl policy, email APIs, Square/accounting/commerce payloads, SSO/SCIM helpers, local speech/WAV.
- **Static gates:** `npx tsc --noEmit -p tsconfig.json` and `npm run lint` (ESLint) — clean.
- **CI:** `.github/workflows/ci.yml` runs Prisma generate → tsc → lint → unit tests → `next build` on push/PR.
- **Runtime verification:** manual/browser + curl against the dev server; Diagnostics exposes DB tuning, workers, providers and counts. `node scripts/smoke.mjs` covers 44 checks. Docker Postgres and SQLite profiles built and smoke-tested on 2026-10-22 (health, schema, seed, login, export, backup, SSRF block, ONNX). No committed browser automation suite.

## Covered in iteration 2 (live/structural)
- Dev boot: SQLite WAL + 5000 ms busy timeout; automation/outbox/data-source workers start lease-protected.
- `/api/health/detail`: returns live database tuning and worker lease status.
- Manual automation/outbox endpoints return 200 when idle; holding the automation lease returns `409 worker_busy`.
- PABX: unit coverage for routing/status; call records added for AI and routed calls.
- UI: all sections render; no favicon 404; Radix dialog description warning resolved; credentials dialog form warning resolved for integrations.

## Gaps
| Area | Gap | Priority |
|---|---|---|
| Conversation concurrency | No automated contention test for two simultaneous SMS turns; lock logic is code-reviewed/unit-tested but not load-tested. | P2 |
| Workers | No automated crash/TTL-recovery test for `WorkerLease`. | P2 |
| Payments | No automated concurrent double-verify race test. | P2 |
| Authz | No matrix test for every role × every mutating route. | P2 |
| Telephony | No end-to-end test with real Twilio/SIP/PSTN credentials (BLOCKED_EXTERNAL). | P2 |
| SMS gateways | Adapter unit tests only; no live TextBee/httpSMS/android-sms-gateway hardware tests. | P2 |
| Providers | No test against real Ollama/OpenAI-compatible endpoints (BLOCKED_EXTERNAL). | P2 |
| Data sources | Postgres/MySQL adapters untested against real servers (SQLite is covered locally). | P2 |
| SSRF | No DNS-rebind TOCTOU test (S10 open by design); literal/private-host cases are unit-tested. | P3 |
| RAG | No scale/perf test or relevance benchmark. | P3 |
| Realtime/voice | WebRTC session/tool path needs a live compatible endpoint. | P3 |
| Browser E2E | No committed Playwright/browser suite; verification is manual CDP. | P2 |

## Recommended next
1. Add a marked DB-backed concurrency test: two SMS/web turns on one conversation → one succeeds, one waits or returns `conversation_busy`; no interleaved messages.
2. Add role-matrix script hitting every mutating route with owner/admin/agent/viewer sessions.
3. Add a lease crash test (hold lease, expire TTL, second worker takes over).
4. Optional: promote the CDP smoke script into a committed browser suite with a stubbed LLM endpoint.
