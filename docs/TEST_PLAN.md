# Test Plan — AI Secretary

> **Verification model.** This repo uses Node's built-in `node:test` for pure/unit logic
> (`tests/unit/*.mts`, 32 cases), plus `npx tsc --noEmit`, `npm run lint`, CI (`next build`), and
> manual browser/curl E2E against the dev server. There is no committed Vitest/Jest/Playwright suite;
> browser checks are run with a local CDP script. Status: ✅ verified · 📋 specified/future.

## 1. Acceptance matrix

| # | Area | Test | Expected | Priority | Status |
|---|---|---|---|---|---|
| A1 | Setup | Complete the wizard with no external services | Steps autosave; progress survives reload; activation gated on readiness | P0 | ✅ browser |
| A2 | Setup | Reload mid-wizard | Resumes with data intact | P0 | ✅ browser |
| B1 | Auth | Register owner → login → logout; wrong password | Cookie set/cleared; generic 401; session row revoked on logout | P0 | ✅ curl |
| B2 | Auth | Tampered/expired/revoked session cookie | 401; no data leak | P0 | ✅ curl |
| B3 | Auth | TOTP enable/login/disable | Setup returns secret once; missing/wrong code rejected; valid code signs in | P0 | ✅ browser/curl |
| C1 | Org isolation | Read another org's customer/booking/invoice by id | 404, no data leak | P0 | ✅ curl |
| C2 | Org isolation | List endpoints | Filtered by session org | P0 | ✅ curl |
| D1 | Bookings | Create in business hours | 201; end = start + duration + buffers | P0 | ✅ |
| D2 | Bookings | Overlap conflict | 409; no row created | P0 | ✅ curl |
| D3 | Bookings | Two simultaneous creates for one slot | Exactly one 201, one 409 | P0 | ✅ parallel curl (iteration 1) |
| E1 | Assistant | Valid tool chain (availability → create booking) | Tool calls persisted in message meta; booking created | P0 | ✅ browser/curl |
| E2 | Assistant | Invalid tool args/unknown tool | Observation returned; no mutation | P0 | ✅ |
| E3 | Assistant | No provider configured | Explicit error surfaced; no fake reply | P0 | ✅ |
| F1 | Invoices | Issue invoice with lines | Line sums = total; status/ledger correct | P0 | ✅ |
| F2 | Invoices | Partial then full payment | `partial` → `paid`; balance = total − verified | P0 | ✅ curl |
| F3 | Invoices | Void with balance | Voided; further payments rejected; reversal entry | P1 | ✅ |
| G1 | Payments | Idempotency key replay | Same result; single ledger entry | P0 | ✅ curl |
| G2 | Payments | Duplicate webhook event id | Second result duplicate; balance unchanged | P0 | ✅ curl |
| G3 | Payments | Bad webhook signature | Rejected; no state change | P0 | ✅ curl |
| G4 | Payments | Concurrent verify/overpay | At most outstanding settled; 409 overpay | P0 | ✅ curl (iteration 1) |
| H1 | Automations | Due run executes | Run status success; audit recorded | P0 | ✅ |
| H2 | Automations | Retry on failure | Attempts/backoff; error stored | P0 | ✅ forced failure |
| H3 | Automations | Dedupe/opt-out | Skip with explicit reason; no send | P0 | ✅ |
| H4 | Automations | Manual run while lease held | `409 worker_busy`; no duplicate processing | P1 | ✅ iteration 2 |
| I1 | Local-only | External endpoint blocked | Explicit policy error; no request sent | P0 | ✅ |
| J1 | Health | `/api/health`, `/api/health/ready`, `/api/health/detail` | Liveness 200; readiness reflects a real DB query (503 when down); diagnostics report tuning, worker leases and provider state truthfully | P1 | ✅ iteration 2 |
| K1 | Export | Org JSON export | Complete org data; no secrets/hashes | P0 | ✅ curl |
| K2 | Backup/restore | SQLite snapshot + restore; Postgres `pg_dump` | Restored app passes smoke checks | P1 | 📋 (recover on host) |
| L1 | E2E | Minimum vertical slice (spec §7) | Passes with zero cloud AI keys | P0 | ✅ browser+curl |
| M1 | Headers | `curl -I /` | nosniff/frame denial/referrer/permissions present; HSTS+CSP in production | P1 | ✅ |
| M2 | Rate limits | Burst login/telephony | 429 after threshold | P1 | ✅ login; telephony not load-tested |
| N1 | RBAC | Viewer mutation; agent admin action | 403 both | P0 | ✅ curl |
| V1 | Voice | Browser Web Speech test call | Transcript + assistant reply; no audio persisted | P0 | ✅ browser |
| V2 | Telephony | Signed/unsigned voice webhook + gather | Unsigned 403; signed TwiML; gather runs one validated turn | P0 | ✅ curl |
| V3 | SMS/WhatsApp | Opt-out + outbox honesty | Inbound stored, nothing sent; failure queued/skipped with reason | P0 | ✅ curl |
| V4 | CalDAV | Push + pull against Radicale | PROPFIND 207; push idempotent; remote cancel/move applied; deletes reported | P1 | ✅ curl |
| V5 | PABX routing | Unit: least-busy/round-robin/redirect/status | Correct selection and normalization | P1 | ✅ unit |

## 2. Browser verification protocol

1. Start `npm run dev`; confirm `dev.log` has no compile errors and SQLite WAL/busy-timeout boot lines.
2. Open `/`; fail on console errors (known non-fatal: browser password-form warnings for inputs outside forms).
3. Walk the wizard through all steps; reload after each to verify persistence.
4. Vertical slice via UI: customer + service → booking → conflicting booking (expect 409 surface) → invoice → payment (replay idempotency) → ledger.
5. Inbox: text turn with a real configured model; invalid request; verify tool metadata/errors; take over the conversation.
6. Voice Console: mic round-trip or browser speech fallback; confirm no audio stored.
7. Settings → AI Providers: save a key, confirm it is never returned; run connection test; switch `local_only` and verify external endpoint is blocked.
8. Diagnostics: DB tuning + workers + providers render; no fake green states.
9. Check network/log hygiene: no unexpected external origins; no 5xx in `dev.log` beyond documented provider failures.

## 3. curl smoke suite (current endpoints)

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE="${BASE:-http://localhost:3000}"
J='Content-Type: application/json'
H='x-requested-with: ais'   # required on authenticated mutations
CJ=/tmp/ais-smoke-cookies.txt; rm -f "$CJ"

# B1 — first-run owner registration (only while zero users exist)
curl -sf -c "$CJ" -b "$CJ" -H "$J" -H "$H" -X POST "$BASE/api/auth/register-owner" \
  -d '{"orgName":"Smoke Co","businessType":"salon","name":"Owner","email":"owner@example.com","password":"correct-horse-42"}'
curl -sf -c "$CJ" -b "$CJ" "$BASE/api/session" | jq -e '.authenticated==true'

# B2 — tampered cookie
curl -s -o /dev/null -w "B2 expect 401: %{http_code}\n" -H 'Cookie: ais_session=bad.token' "$BASE/api/session"

# A — setup autosave + readiness
curl -sf -b "$CJ" -H "$J" -H "$H" -X PUT "$BASE/api/setup" \
  -d '{"step":"business","data":{"name":"Smoke Co","timezone":"UTC"}}' >/dev/null
curl -sf -b "$CJ" "$BASE/api/setup" | jq -e '.state.business != null'
curl -sf -b "$CJ" "$BASE/api/setup/readiness" | jq -e '.items | type=="array"'

# C/D — customer, service, booking, conflict
CID=$(curl -sf -b "$CJ" -H "$J" -H "$H" -X POST "$BASE/api/customers" \
  -d '{"name":"Dana Reed","phone":"+15551230001","consentContact":true}' | jq -r .id)
SID=$(curl -sf -b "$CJ" -H "$J" -H "$H" -X POST "$BASE/api/services" \
  -d '{"name":"Consultation","durationMin":60,"priceCents":12000}' | jq -r .id)
START=$(date -u -d '+3 days 15:00' +%Y-%m-%dT%H:%M:00Z 2>/dev/null || date -u -v+3d +%Y-%m-%dT15:00:00Z)
BODY="{\"customerId\":\"$CID\",\"serviceId\":\"$SID\",\"startAt\":\"$START\"}"
BID=$(curl -sf -b "$CJ" -H "$J" -H "$H" -X POST "$BASE/api/bookings" -d "$BODY" | jq -r .id)
curl -s -o /dev/null -w "D2 expect 409: %{http_code}\n" -b "$CJ" -H "$J" -H "$H" -X POST "$BASE/api/bookings" -d "$BODY"

# F/G — invoice, payment, idempotent replay, status
IID=$(curl -sf -b "$CJ" -H "$J" -H "$H" -X POST "$BASE/api/invoices" \
  -d "{\"customerId\":\"$CID\",\"items\":[{\"description\":\"Consultation\",\"qty\":1,\"unitPriceCents\":12000}]}" | jq -r .id)
curl -sf -b "$CJ" -H "$J" -H "$H" -X POST "$BASE/api/invoices/$IID/payments" \
  -d '{"amountCents":12000,"method":"manual","reference":"smoke-1"}' >/dev/null
curl -sf -b "$CJ" "$BASE/api/invoices/$IID" | jq -e '.status=="paid" and .paidCents==12000'

# Assistant turn (requires a configured provider; skip if the response is an explicit config error)
CONV=$(curl -sf -b "$CJ" -H "$J" -H "$H" -X POST "$BASE/api/conversations" -d '{"contactName":"Smoke"}' | jq -r .id)
curl -s -b "$CJ" -H "$J" -H "$H" -X POST "$BASE/api/conversations/$CONV/messages" \
  -d '{"content":"What services do you offer?"}' | jq -e 'has("aiUsed") or has("error")'

# Worker lease busy path is covered by the iteration-2 live check, not this script.

# K — export excludes secrets/hashes
curl -sf -b "$CJ" "$BASE/api/admin/export" | jq -e 'has("customers") and has("ledgerEntries") and ((.users[0]|has("passwordHash"))|not)'

# M — headers
curl -sI "$BASE/" | grep -Ei 'x-frame-options|content-security-policy|x-content-type-options'
echo "SMOKE OK"
```

Notes: the suite assumes an empty installation for owner registration; on an existing DB, log in with
known credentials instead. Response status strings are lowercase (`paid`, `partial`, etc.). The
assistant step is provider-dependent and must report an explicit configuration error when no model
is enabled — that is a pass for honesty, not a booking test.

## 4. Voice, telephony and CalDAV

- **Voice Console:** browser mic/speechSynthesis path works without server speech; server STT/TTS
  requires an enabled `openai_compatible` endpoint (`/audio/transcriptions`, `/audio/speech`).
  Confirm `AiLog` metrics rows and no persisted audio.
- **Twilio webhooks:** sign `fullUrl + sorted("Key"+"Value")` with the auth token (HMAC-SHA1,
  base64); unsigned → 403; signed → TwiML. Test incoming, gather (`SpeechResult`), status
  (`CallStatus`, `DialCallStatus`), SMS and WhatsApp. Check `TelephonyCall` rows and line routing.
- **CalDAV:** Radicale (or Nextcloud/Fastmail) → `Sync now`; verify pushed VEVENTs, remote cancel,
  remote move, remote delete reported as `missing`. Per-item results must be truthful.
- **Real provider/gateway tests:** BLOCKED_EXTERNAL here (no Ollama/OpenAI-compatible endpoint,
  pg/mysql, SMS hardware). Use the connection-test buttons on a configured host.

## 5. Future automated suite (outside this environment)

Add DB-backed Vitest/Playwright suites for: conversation-lock contention, worker lease TTL
recovery, concurrent payment verification, role matrix, provider/gateway adapters with mocks, and
browser E2E with a stubbed LLM endpoint. The existing `node:test` unit cases are the regression net
for pure logic and must keep passing.
