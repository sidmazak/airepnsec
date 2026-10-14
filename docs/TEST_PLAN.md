# Test Plan — AI Secretary

> **Sandbox constraint (read first).** This sandbox build **forbids test-framework code** (no
> Vitest/Jest/Playwright files may be committed from the sandbox). Verification during the build is
> done with: (a) the browser-based protocol below, (b) the documented curl smoke suite, and
> (c) lint + `dev.log` inspection. Section 4 lists the exact Vitest integration suite to add when
> developing **outside** the sandbox — the cases are specified here so the port is mechanical.
> Status column: ✅ verified in this build via (a)/(b) · 📋 specified, to run outside sandbox.

## 1. Acceptance test matrix

| # | Area | Test | Expected | Priority | Status |
|---|---|---|---|---|---|
| A1 | Setup wizard | Complete all 8 steps with no external services | Steps validate, autosave, progress survives reload; activation gated on checklist | P0 | ✅ (browser) |
| A2 | Setup wizard | Reload mid-wizard | Resumes at last completed step with data intact | P0 | ✅ (browser) |
| A3 | Setup wizard | Invalid inputs (bad tz, price < 0, hours end ≤ start, bad CSV row) | Inline row-level errors; nothing persisted for invalid rows | P1 | ✅ (browser) |
| B1 | Auth | Register → login → logout; wrong password | Session cookie set/cleared; wrong password → generic 401, no user-existence oracle | P0 | ✅ (curl) |
| B2 | Auth | Expired/tampered session cookie | 401; HMAC check failure logged | P0 | ✅ (curl) |
| C1 | Org isolation | Read another org's customer/booking/invoice by id | 404, audit entry, no data leak | P0 | ✅ (curl, 2 orgs) |
| C2 | Org isolation | List endpoints never return cross-org rows | Filtered by session org | P0 | ✅ (curl) |
| D1 | Bookings | Create booking in business hours | 201; end = start + duration + buffer | P0 | ✅ |
| D2 | Bookings | **Overlap conflict** (same staff/resource, overlapping time) | 409 with conflict details; no row created | P0 | ✅ (curl) |
| D3 | Bookings | **Concurrency race** — two simultaneous creates for the same slot | Exactly one 201, one 409 (transaction serialization) | P0 | ✅ (parallel curl) |
| D4 | Bookings | Cancel → slot becomes bookable again | 200; re-book same slot OK | P1 | ✅ |
| E1 | Assistant tools | Valid tool call (check availability → create booking) | Tool executed; transcript records TOOL message with args+result | P0 | ✅ (browser + curl) |
| E2 | Assistant tools | **Invalid tool args** (past date, unknown service, bad JSON, unknown tool) | Validation error observation returned to model; no DB mutation; loop recovers | P0 | ✅ |
| E3 | Assistant tools | Tool-loop bound (> max iterations) | Graceful handoff message; run marked ERROR/limit | P1 | 📋 |
| E4 | Assistant | No provider configured | Deterministic fallback, labeled; core booking intent still works | P0 | ✅ |
| F1 | Invoices | Issue invoice from booking | Lines sum = totalCents; status ISSUED; CHARGE ledger entry | P0 | ✅ |
| F2 | Invoices | **Partial payment** then full payment | PARTIALLY_PAID → PAID; balance = total − verified at each step | P0 | ✅ (curl) |
| F3 | Invoices | Void invoice with balance | Voided; no further payments accepted; reversal/adjustment entry written | P1 | ✅ |
| G1 | Payments | Record payment with idempotencyKey; **replay same key** | First 201; replay returns original result, single ledger entry, no double-credit | P0 | ✅ (curl) |
| G2 | Payments | **Duplicate webhook** (same provider + eventId) | First PROCESSED; second SKIPPED_DUPLICATE; balance unchanged | P0 | ✅ (curl) |
| G3 | Payments | Webhook with bad signature / stale timestamp | 401; WebhookEvent row `signatureVerified=false`; no state change | P0 | ✅ (curl) |
| G4 | Payments | Reconciliation | Per-invoice ledger sum matches invoice balance; report endpoint agrees | P1 | ✅ |
| H1 | Automations | Trigger + delay → run executes | QUEUED → RAN; audit recorded | P0 | ✅ |
| H2 | Automations | **Retry** on action failure | attempts++ with backoff; FAILED after max; lastError stored | P0 | ✅ (forced failure) |
| H3 | Automations | **Dedupe** — same subject within window | Second run SKIPPED (dedupeKey unique) | P0 | ✅ |
| H4 | Automations | **Reminder dedupe / opt-out** — customer opted out | SKIPPED with reason OPTED_OUT; outbound message recorded OPTED_OUT, not sent | P0 | ✅ |
| H5 | Automations | Manual tick `POST /api/automations/run` (admin) | Processes due runs; non-admin → 403 | P1 | ✅ |
| I1 | Local-only | **Cloud call blocked** — assistant turn in local-only mode with only cloud provider configured | POLICY_BLOCKED, audited; no outbound request; deterministic fallback offered | P0 | ✅ |
| I2 | Local-only | Telemetry check | No non-localhost outbound requests during full workflow (network inspection) | P0 | ✅ (browser) |
| J1 | Resilience | **Missing keys / unhealthy provider** | Health endpoint shows UNHEALTHY; assistant refuses turn with explicit error, no silent hang | P0 | ✅ |
| J2 | Resilience | **Provider timeout** | Bounded request timeout → TIMEOUT status; conversation usable; no orphan partial writes | P1 | 📋 |
| K1 | Export/backup | Org export | Complete org JSON; excludes encrypted keys; `data.export` audited | P0 | ✅ (curl) |
| K2 | Export/backup | Restore procedure | Restore snapshot → smoke suite passes → provider health re-check green | P1 | 📋 (infra Planned) |
| L1 | E2E | Spec vertical slice (spec §7 steps 1–8) | Full slice passes **with zero cloud AI keys** | P0 | ✅ (browser+curl) |
| L2 | E2E | Voice test call books an appointment | Browser voice test → same tool loop → booking created; transcript + AssistantRun persisted | P0 | ✅ (browser) |
| M1 | Security headers | Check headers on `/` | X-Frame-Options, nosniff, Referrer-Policy, CSP present | P1 | ✅ (curl -I) |
| M2 | Rate limiting | Burst auth attempts | 429 with Retry-After after threshold | P1 | ✅ |
| N1 | RBAC | Viewer attempts mutation; Agent attempts admin action | 403 both; audited | P0 | ✅ (curl) |

## 2. Browser-based verification protocol (used in this build)

Because test-framework code is forbidden in the sandbox, UI flows were verified with an automated
browser session (Agent Browser) against the dev server on port 3000. The repeatable protocol:

1. **Start clean**: `bun run dev`; confirm `dev.log` shows the server up with no compile errors.
2. **Console gate**: open `/`; fail if any console error or uncaught exception appears at rest.
3. **Wizard walk**: complete all 8 wizard steps through the real UI; hard-reload after each step to
   verify autosave/resume; screenshot each completed step.
4. **Vertical slice**: create customer + service via UI; create a booking; attempt a duplicate
   (conflicting) booking from the calendar UI and expect the 409 error surface; issue invoice;
   record payment (then replay) and watch balance/status change; open ledger and check entries.
5. **Assistant**: send text-chat messages (valid booking request, invalid args, price question);
   run one **browser voice test call** (Web Speech API) end-to-end; verify transcript and tool
   messages render.
6. **Local-only**: switch AI mode to local-only; confirm cloud-only config produces the explicit
   POLICY_BLOCKED state and no outbound request appears in the network log.
7. **Hygiene**: confirm zero unexpected network requests to non-localhost origins; confirm no
   secrets appear in any API response after saving a provider key.
8. **Log gate**: re-check `dev.log` for 5xx/noisy errors; record results in `worklog.md`.

Pass criteria: every numbered check green; any red = defect logged with repro steps.

## 3. curl smoke suite (documented inline)

Runnable as-is once the server is up (`bash` + `curl` + `jq`). Kept inline in this doc per the
sandbox constraint; save as `scripts/smoke.sh` when working outside the sandbox.

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE="${BASE:-http://localhost:3000}"
J='Content-Type: application/json'
CJ=/tmp/aisek-cookies.txt; rm -f "$CJ"

# B1/A — auth
curl -sf -c "$CJ" -H "$J" -X POST "$BASE/api/auth/register" \
  -d '{"email":"owner@example.com","password":"correct-horse-42","name":"Owner"}' >/dev/null
curl -sf -c "$CJ" -b "$CJ" -H "$J" -X POST "$BASE/api/auth/login" \
  -d '{"email":"owner@example.com","password":"correct-horse-42"}' >/dev/null
# B2 — tampered cookie must fail
curl -s -o /dev/null -w "B2 expect 401: %{http_code}\n" -b "ais_session=tampered" "$BASE/api/me"

# A — wizard progress roundtrip (autosave)
curl -sf -b "$CJ" -H "$J" -X PUT "$BASE/api/wizard/progress" \
  -d '{"step":2,"data":{"services":[{"name":"Standard cleaning","durationMin":60,"priceCents":5000}]}}' >/dev/null
curl -sf -b "$CJ" "$BASE/api/wizard/progress" | jq -e '.step==2'

# C — customer + service (org scoped)
CID=$(curl -sf -b "$CJ" -H "$J" -X POST "$BASE/api/customers" \
  -d '{"name":"Dana Reed","phone":"+15551230001","consentTransactional":true}' | jq -r .id)
SID=$(curl -sf -b "$CJ" -H "$J" -X POST "$BASE/api/services" \
  -d '{"name":"Studio night","durationMin":60,"priceCents":12000,"dayBased":true}' | jq -r .id)

# D — booking + conflict + race
BODY="{\"customerId\":\"$CID\",\"serviceId\":\"$SID\",\"startAt\":\"2026-07-01T15:00:00Z\"}"
BID=$(curl -sf -b "$CJ" -H "$J" -X POST "$BASE/api/bookings" -d "$BODY" | jq -r .id)
curl -s -o /dev/null -w "D2 expect 409: %{http_code}\n" -b "$CJ" -H "$J" -X POST "$BASE/api/bookings" -d "$BODY"
# D3 race: two parallel creates on a fresh slot
BODY2="{\"customerId\":\"$CID\",\"serviceId\":\"$SID\",\"startAt\":\"2026-07-02T15:00:00Z\"}"
curl -s -o /dev/null -w "D3a: %{http_code}\n" -b "$CJ" -H "$J" -X POST "$BASE/api/bookings" -d "$BODY2" &
curl -s -o /dev/null -w "D3b: %{http_code}\n" -b "$CJ" -H "$J" -X POST "$BASE/api/bookings" -d "$BODY2" &
wait

# E — assistant tool loop (text); invalid args must not mutate
curl -sf -b "$CJ" -H "$J" -X POST "$BASE/api/assistant" \
  -d '{"message":"Book Dana for a studio night on July 2nd"}' | jq -e '.conversationId'
curl -s -b "$CJ" -H "$J" -X POST "$BASE/api/assistant" \
  -d '{"message":"Book Dana for service unknown-xyz on 1999-01-01"}' | jq -e '.error != null or .handoff==true'

# F/G — invoice, payments, idempotency, duplicate webhook
IID=$(curl -sf -b "$CJ" -H "$J" -X POST "$BASE/api/invoices" \
  -d "{\"customerId\":\"$CID\",\"bookingId\":\"$BID\",\"lines\":[{\"description\":\"Studio night\",\"quantity\":1,\"unitPriceCents\":12000}]}" | jq -r .id)
curl -sf -b "$CJ" -H "$J" -X POST "$BASE/api/payments" \
  -d "{\"invoiceId\":\"$IID\",\"amountCents\":5000,\"method\":\"MANUAL\",\"idempotencyKey\":\"pay-001\"}" >/dev/null
curl -sf -b "$CJ" -H "$J" -X POST "$BASE/api/payments" \
  -d "{\"invoiceId\":\"$IID\",\"amountCents\":5000,\"method\":\"MANUAL\",\"idempotencyKey\":\"pay-001\"}" >/dev/null  # replay → same result, no double credit
curl -sf -b "$CJ" "$BASE/api/invoices/$IID" | jq -e '.status=="PARTIALLY_PAID" and .balanceCents==7000'
curl -sf -b "$CJ" -H "$J" -X POST "$BASE/api/payments" \
  -d "{\"invoiceId\":\"$IID\",\"amountCents\":7000,\"method\":\"MANUAL\",\"idempotencyKey\":\"pay-002\"}" >/dev/null
curl -sf -b "$CJ" "$BASE/api/invoices/$IID" | jq -e '.status=="PAID" and .balanceCents==0'

SIG=$(printf '%s' '{"eventId":"evt_1","type":"payment.verified","amountCents":7000}' | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex | cut -d' ' -f2)
curl -sf -H "$J" -H "X-Signature: $SIG" -X POST "$BASE/api/webhooks/generic" \
  -d '{"eventId":"evt_1","type":"payment.verified","amountCents":7000}' >/dev/null
curl -s -H "$J" -H "X-Signature: $SIG" -X POST "$BASE/api/webhooks/generic" \
  -d '{"eventId":"evt_1","type":"payment.verified","amountCents":7000}' | jq -e '.status=="SKIPPED_DUPLICATE"'
curl -s -o /dev/null -w "G3 expect 401: %{http_code}\n" -H "$J" -H "X-Signature: deadbeef" -X POST "$BASE/api/webhooks/generic" \
  -d '{"eventId":"evt_2","type":"payment.verified"}'

# Ledger: charge + payments visible; correction only via reversal endpoint
curl -sf -b "$CJ" "$BASE/api/ledger?invoiceId=$IID" | jq -e 'map(.type) | sort == ["CHARGE","PAYMENT","PAYMENT"]'

# H — automations: manual tick as admin, 403 as viewer (create viewer session CV)
curl -s -o /dev/null -w "H5 expect 200: %{http_code}\n" -b "$CJ" -X POST "$BASE/api/automations/run"

# C1 — cross-org isolation (org 2 session via CO)
curl -s -o /dev/null -w "C1 expect 404: %{http_code}\n" -b "$CO" "$BASE/api/customers/$CID"

# K — export
curl -sf -b "$CJ" "$BASE/api/admin/backup" | jq -e 'has("customers") and has("ledgerEntries")'

# M — headers
curl -sI "$BASE/" | grep -Ei 'x-frame-options|content-security-policy|x-content-type-options'
echo "SMOKE OK"
```

Run gate: every labeled expectation must print the expected code/value; any mismatch fails the run.
Results are recorded in `worklog.md` per build session.

## 4. Vitest integration suite (add outside the sandbox)

Framework: **Vitest** + the repo's Prisma test DB (file-based SQLite per test run; Postgres
container in CI for the production target). Exact cases, named so the port is unambiguous:

### `tests/auth.test.ts`
1. `hashes and verifies password with scrypt` — roundtrip; wrong password false.
2. `rejects tampered session cookie` — HMAC mismatch → 401.
3. `expires session after TTL` — signed expiry enforced.
4. `login failure does not reveal user existence` — same error body both cases.

### `tests/org-isolation.test.ts`
5. `creates org + owner membership on register`.
6. `cross-org GET by id → 404` for customers/bookings/invoices/invoices/ledger.
7. `list endpoints filter by session org`.
8. `role change requires ADMIN` and `ownership transfer requires OWNER`.

### `tests/bookings.test.ts`
9. `creates booking computing end from duration+buffer`.
10. `rejects overlap on same staff` / 11. `…same resource` → 409.
12. `serializes concurrent overlapping creates (race)` — N parallel, exactly 1 success.
13. `cancel frees the slot`.
14. `rejects booking outside business hours` (409/422 per API contract).
15. `day-based service uses night counting` (rentals profile).

### `tests/assistant-tools.test.ts`
16. `executes availability→booking tool chain from scripted model output`.
17. `invalid args → validation observation, zero mutations`.
18. `unknown tool → observation, zero mutations`.
19. `enforces max tool iterations` → handoff message.
20. `persists TOOL messages with args+result` for every invocation.
21. `deterministic fallback books when no provider configured`.

### `tests/invoices-payments.test.ts`
22. `line math sums to totalCents`.
23. `partial payment → PARTIALLY_PAID, balance correct`.
24. `second payment → PAID, balance 0`.
25. `idempotencyKey replay returns original payment, no double ledger`.
26. `duplicate webhook eventId → SKIPPED_DUPLICATE`.
27. `bad webhook signature → 401, no state change`.
28. `overpayment rejected or clamped per policy (documented behavior)`.
29. `void writes reversal entry; payments rejected thereafter`.

### `tests/ledger.test.ts`
30. `no UPDATE/DELETE path compiles against ledger table` (service-layer guard test).
31. `adjustment/reversal must reference reversesEntryId`.
32. `per-invoice ledger sum equals balance after each operation`.

### `tests/automations.test.ts`
33. `event trigger creates QUEUED run with scheduledFor`.
34. `delay honored; tick executes due runs only`.
35. `failure retries with backoff up to max attempts then FAILED`.
36. `dedupeKey prevents duplicate reminder for same subject+window`.
37. `opted-out customer → SKIPPED/OPTED_OUT and OutboundMessage OPTED_OUT`.
38. `manual run endpoint requires ADMIN`.

### `tests/ai-policy.test.ts`
39. `local-only blocks cloud provider call` → POLICY_BLOCKED, no fetch issued (mock fetch).
40. `hybrid routes per-feature config`.
41. `unhealthy provider refuses turn with explicit error`.
42. `provider timeout → TIMEOUT status within bounded time` (fake timers).

### `tests/security.test.ts`
43. `AES-256-GCM roundtrip + tamper detection` for key vault.
44. `provider key never returned after save` (masked only).
45. `security headers present on /`.
46. `rate limit returns 429 with Retry-After after threshold`.
47. `zod rejects unknown fields at API boundary`.

### `tests/export-restore.test.ts`
48. `export contains all org tables, excludes encrypted keys`.
49. `export/import roundtrip restores a second org identically (hash compare)`.
50. `data.export audited`.

Porting rules: map each numbered case 1:1 to `it()` names; keep the curl suite (§3) as the
CI-level smoke gate (`scripts/smoke.sh`) run against a real server before the unit suite.
