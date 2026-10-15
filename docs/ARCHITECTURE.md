# Architecture — AI Secretary

> This document describes the architecture as built. Where a component is deferred, it is labeled
> **Deferred**/**Planned** — see [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) for the live status table.

## 1. Conceptual modules → physical layout

The product is designed as four apps plus shared packages. In this build the whole thing is one
Next.js 16 App Router deployment; the conceptual boundaries map to directories:

| Conceptual module | Physical location | Responsibility |
|---|---|---|
| **apps/web** — admin dashboard + setup wizard | `src/app/page.tsx` (single-page app, client sections), `src/components/**` | Owner/admin UI: dashboard, wizard, customers, bookings, invoices, ledger, settings, Voice Console, text chat |
| **apps/api** — HTTP API | Next.js route handlers under `src/app/api/**` (no server actions) | Auth/session, RBAC, zod validation, org scoping, orchestration of business services |
| — business services (part of api boundary) | `src/lib/business/**` | Booking engine, invoice/payment math, ledger rules, customer service, automation service. Pure-ish TypeScript over Prisma; transactions live here |
| **apps/worker** — automation tick | `src/instrumentation.ts` (`register()` starts the interval) + manual `POST /api/automations/run` | Periodic automation processing (due runs, retries); the manual endpoint allows operators/cron to trigger a tick |
| **apps/voice** — voice channel | Voice Console section (`src/components/sections/voice-section.tsx`), STT/TTS lib (`src/lib/ai/speech.ts`), telephony lib (`src/lib/telephony/twiml.ts`); routes `src/app/api/ai/{asr,tts}` + `src/app/api/telephony/**` | Browser voice console (real STT/TTS) + true phone/SMS receptionist via Twilio (see §9) |
| package: db | `src/lib/db.ts` (Prisma client singleton) | Data access; schema in `prisma/schema.prisma` |
| package: ai | `src/lib/ai/**` | Provider adapters (sandbox SDK, Ollama, OpenAI-compatible), embeddings, policy gate (local-only/hybrid/cloud) |
| package: datasources — bring-your-own DB into RAG | `src/lib/datasources/**` (registry, adapters, sync) + routes `src/app/api/datasources/**` + UI `src/components/sections/data-sources-section.tsx` | Connect an external relational DB (postgres/mysql/sqlite) or JSON HTTP endpoint; normalize rows → `KnowledgeDoc`s → the shared chunk/embed pipeline. Read-only SQL enforcement, SSRF guard, encrypted credentials, idempotent re-sync, worker auto-sync |
| package: integrations | `src/lib/integrations/**` | SMTP/Twilio/Stripe/CalDAV adapters, outbox dispatcher, ICS feed + CalDAV push sync, generic signed-webhook adapter |

Boundary rules:

- Route handlers never touch Prisma directly for business mutations; they call `src/lib/business` services.
- Client components never import `src/lib/db`, `src/lib/ai`, or `src/lib/integrations`; those are server-only.
- The worker (instrumentation hook) reuses the same business services — no separate business logic path.
- `src/components/ui/**` is the shadcn/ui component set; app-specific components build on it and do not restyle primitives ad hoc.

## 2. Sandbox vs production delta (stated honestly)

| Concern | This build (sandbox) | Self-hosted production target |
|---|---|---|
| Runtime | Next.js dev server (`npm run dev`, port 3000; Node.js + npm — no Bun) | Docker Compose in `infra/` (**Planned** — not in this build): web + postgres + optional ollama |
| Database | **SQLite** via Prisma (`file:.../db/custom.db`) | **PostgreSQL** (+ **pgvector** for embeddings) |
| Migrations | `prisma db push` (sandbox convenience) | `prisma migrate deploy` with committed migrations |
| Embeddings | Stored in-app; lexical/cosine fallback (SQLite has no vector index) | pgvector index |
| AI provider | none built-in — **BYOK only**: Ollama (local) or any OpenAI-compatible endpoint | Keys AES-256-GCM encrypted server-side, never returned |
| Rate limiting | In-memory per-process | DB/Redis-backed (multi-instance) |
| TLS/headers termination | Caddy in sandbox routes to :3000 | Caddyfile in `infra/` with HSTS |

**Schema portability rules** (enforced by review, checked in [DATA_MODEL.md](./DATA_MODEL.md)):

- No Prisma `enum` types — role/status fields are `String` validated by zod unions at the boundary.
- No native `Json` columns — structured blobs are `String` columns holding JSON, parsed/validated in services.
- Money is always `Int` cents. Never floats, never decimals.
- No DB-specific types (no SQLite-only pragmas in schema, no Postgres-only column types in the shared schema).
These rules keep the SQLite→PostgreSQL switch a datasource-provider change, not a rewrite.

## 3. Request lifecycle

```
Browser (SPA)
  │  fetch (JSON, session cookie)
  ▼
Route handler  src/app/api/**/route.ts
  1. Rate limit check (per IP + per session)
  2. Auth: verify HMAC-signed session cookie → user
  3. Org scope: resolve membership + role for target orgId
  4. Parse & validate body/query with zod schema (unknown keys rejected)
  5. RBAC assertion for the action
  6. Call business service (src/lib/business) — may open a Prisma $transaction
  7. Service writes consequential AuditEvent rows inside the same transaction
  8. Handler returns JSON; errors map to typed status codes (400/401/403/404/409/429/500)
```

Automation tick lifecycle (apps/worker): `instrumentation.ts register()` starts an interval →
claims due `AutomationRun` rows (status QUEUED, `scheduledFor <= now`) → executes actions via
business/integration services → records result, schedules retry with backoff or dedupe-skips →
writes audit. `POST /api/automations/run` (admin) triggers the same processing synchronously for
operators and cron setups.

## 4. AI receptionist tool-loop design

The LLM is a **planner, never an actor**. It cannot write to the database. Every effect goes
through server-side validated tools.

```
┌────────────┐  user msg   ┌─────────────────────────────┐
│ Browser    │────────────▶│ /api/assistant (route)      │
│ chat/voice │             │  policy gate (mode check)   │
└────────────┘             │  build context (org, FAQ)   │
                           ▼                             │
                     ┌───────────┐  strict JSON tool call │
                     │ LLM via   │──────────────────────▶ tools: {name, args}
                     │ provider  │◀────────────────────── tool result JSON
                     └───────────┘   validated in route
                           │  final assistant message
                           ▼
                 Conversation + Message rows persisted (incl. every tool call)
```

Protocol rules:

1. **Strict JSON tool protocol.** The model must respond with either a final message or a tool
   object `{ "tool": "<name>", "args": {…} }`. Malformed JSON or unknown tool names are returned to
   the model as an error observation, not executed.
2. **Server-side validation.** Every tool has a zod schema in `src/lib/ai/tools`; args are parsed
   before execution. Invalid args produce an observation the model can recover from; they never
   partially mutate state.
3. **LLM never writes the DB directly.** Tools call the same `src/lib/business` services the UI
   uses — booking conflict rules, org scoping, and audit apply identically.
4. **Loop bounds.** Max tool iterations per turn (default 6); exceeded → graceful handoff message
   ("I'll hand this to a human").
5. **Tool categories.** Read: availability, customer lookup, service/price lookup, FAQ search.
   Write: create booking, create invoice draft, record payment intent. Destructive tools
   (cancel/void) require explicit confirmation token from the user in-thread.
6. **Auditability.** Each tool invocation is persisted as a `Message` row (role TOOL) with args and
   result, plus `AssistantRun` metadata (provider, model, mode, latency, error).
7. **Deterministic fallback.** If no provider is healthy, a rule-based responder handles the core
   intents and is labeled as such in the transcript.

## 5. AI provider policies: local-only / hybrid / cloud

| Mode | Allowed providers | Enforcement |
|---|---|---|
| **local-only** (default for self-hosters) | Ollama / local endpoints only | Policy gate in `src/lib/ai` checked before **every** provider call; cloud endpoint → hard error (not silent fallback). Also blocks outbound telemetry paths |
| **hybrid** | Local preferred; configured cloud allowed for specific features | Gate routes per-feature config |
| **cloud** | BYOK cloud endpoints | Keys stored AES-256-GCM encrypted, server-side only |

- The mode is an org-level setting, default **local-only**; changing it is an admin action that is audited.
- The sandbox SDK adapter counts as a *cloud* provider and is therefore disabled in local-only mode.
- **RAG embeddings** follow the same gate. Default is the **built-in local neural embedder**
  (`Xenova/all-MiniLM-L6-v2`, 384-d, ONNX via transformers.js, cached in `.models/`) — real
  semantic vectors with no API key and zero data egress. Alternatives: local Ollama
  (`/api/embeddings`) or an OpenAI-compatible `/embeddings` endpoint (BYOK, blocked in
  local-only mode by the policy gate). A legacy hashed keyword embedder is the last-resort
  fallback so search never breaks.
- Retrieval is **hybrid**: dense cosine (only when chunk.model === active model) fused with
  BM25 lexical scoring (72/28). Chunks store their embedding model + dimension, so switching
  models marks the index stale (`needsReindex`) and `POST /api/knowledge/reindex` re-embeds
  under the new model with an audited, observable run. The embedding model is pre-warmed at
  server boot (`instrumentation.ts`) so the first search is fast.
- On PostgreSQL production, chunk vectors should move to **pgvector**; the JSON-vector layout
  (SQLite build) is documented as the portable intermediate representation.
- Health checks (`/api/ai/providers` status) mark providers HEALTHY/UNHEALTHY; the assistant
  refuses to start a turn with an unhealthy configured provider rather than silently failing.

## 6. Automation engine

Model: **trigger → (conditions) → (delay) → actions**, executed by the worker tick.

| Aspect | Design |
|---|---|
| Triggers | Event-based: `booking.created`, `booking.cancelled`, `invoice.issued`, `invoice.overdue`, `payment.verified`, `message.received`. Schedule-based: due-date ticks (e.g. daily overdue scan) |
| Conditions | Field predicates on the subject (e.g. `status == CONFIRMED`, `balanceCents > 0`, `consentMarketing == true`), AND-composed |
| Delay | `delaySeconds` between trigger and execution; run is persisted as QUEUED with `scheduledFor`, so restarts don't lose it |
| Actions | Create task/reminder, flag customer, draft message (queued — delivery **Deferred**), call automation webhook (generic signed POST), write audit note |
| Retry | Exponential backoff, max attempts (default 3), `lastError` recorded per run |
| Dedupe | `dedupeKey` (rule, subject, calendar window) unique — prevents duplicate reminders for the same booking/invoice |
| Audit | Every run persisted (`AutomationRun`) with status QUEUED/RAN/SKIPPED/FAILED/CANCELLED + error; skipped-by-dedupe and skipped-by-opt-out are explicit statuses, not silent drops |

Consent & opt-out are checked at run time, not just creation time: a customer with a channel opt-out
makes the action SKIPPED with reason OPTED_OUT (see [SECURITY.md](./SECURITY.md) §Consent).

## 7. Data & money rules (summary)

- Every business row carries `organizationId`; queries are always org-scoped (see
  [DATA_MODEL.md](./DATA_MODEL.md) invariants).
- Money: `Int` cents; balances are computed from verified payments only.
- Ledger is append-only; corrections are adjustment/reversal entries that reference the original.
- Multi-step writes (booking insert + conflict check; payment + invoice status; ledger entries) run
  inside Prisma interactive transactions.

## 8. Observability & operations

- `dev.log` captures dev server output; API failures log structured messages server-side.
- `/api/health` returns basic liveness + provider/db status summary.
- Audit trail (`AuditEvent`) is the primary "what happened" record; dashboard ledger view is the
  financial record.
- Backups: JSON export via `/api/admin/backup` (implemented); binary snapshot script `infra/backup.sh`
  ships with the production packaging (**Planned**).

## 9. Voice, telephony & calendar sync

Three voice surfaces share ONE receptionist brain (`handleReceptionistTurn` — the same validated
tools, audit trail, and data-mode policy gate as text chat):

| Surface | Speech path | Auth |
|---|---|---|
| **Voice Console** (browser, `#voice` section) | Browser records audio → `POST /api/ai/asr` (real STT: OpenAI-compatible `/audio/transcriptions`, or the device's own Web Speech API) → receptionist turn → `POST /api/ai/tts` (real TTS: OpenAI-compatible MP3; text chunked ≤ 1000 chars) → browser playback. Per-turn STT/AI/TTS latency badges. | Session cookie (CSRF-protected) |
| **Phone** (Twilio Voice) | Twilio does the speech recognition (`<Gather input="speech">`); the app runs the full turn and answers with TwiML `<Say>`; escalation → `<Dial>` transfer or message-taken hangup; status callbacks close the call. | Twilio signature |
| **SMS** (Twilio) | Webhook threads one conversation per sender number, records the inbound message instantly, answers asynchronously via the Twilio Messages API; send failures land in the outbox with honest status + retry/backoff. | Twilio signature |

**Transcripts.** The dialogue lives in `Conversation` + `Message` rows exactly like web chat
(customer/assistant/tool messages; `Conversation.externalRef` carries the telephony thread key —
CallSid for calls, `sms:{digits}` for SMS threads). **No audio is persisted anywhere**: STT audio
is decoded, transcribed, and dropped; TTS audio is returned as base64 for playback and never
stored; on phone calls the media never touches this server at all (Twilio's own `<Say>/<Gather>`
handle speech). Inbound SMS bodies are additionally captured verbatim in `WebhookEvent` payloads.

**Calendar sync — push design.** `src/lib/integrations/caldav.ts` is a raw-HTTP CalDAV client:
`PROPFIND` health check (207/200), `PUT {uid}.ics` idempotent upsert, `DELETE`; HTTP Basic auth;
a real RFC 5545 VEVENT builder (line folding, escaping, UTC stamps, `X-AIS-ORG` org marker).
`POST /api/integrations/caldav-sync` (owner/admin, "Sync now" in the UI) pushes upcoming
`pending|confirmed` bookings (default 45 days) as `booking-{id}@{orgslug}.ics` with per-item
results and a persisted last-sync summary — verified live against Radicale. **Pull/two-way sync
is documented future work** (external-event ingestion, conflict handling, Google OAuth); the
read-only ICS feed remains the subscription path for now.
