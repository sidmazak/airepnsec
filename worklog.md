# AI Secretary — Build Worklog

Single shared worklog. Each agent appends a section (never overwrite) using the template:

```
---
Task ID: <id>
Agent: <name>
Task: <task>

Work Log:
- ...

Stage Summary:
- ...
```

## Environment facts (read this first)

- Next.js 16 App Router + TypeScript + Tailwind 4 + shadcn/ui (New York) at `/home/z/my-project`.
- Prisma 6 + **SQLite** (`file:/home/z/my-project/db/custom.db`). The product spec targets PostgreSQL for self-hosted production; in this sandbox we build on SQLite and keep the schema portable (no enums, no native Json columns, money as integer cents). This is documented in `/docs/ARCHITECTURE.md`.
- Single user-visible route: `/` (single-page app with client-side sections). All backend logic via `/api/*` route handlers (no server actions).
- Dev server runs on port 3000 (`bun run dev`, logs in `/home/z/my-project/dev.log`). Never run `bun run build`.
- AI: `z-ai-web-dev-sdk` (backend only). BYOK/local adapters (Ollama, OpenAI-compatible) implemented server-side. Local-only mode must block cloud calls.
- Do not write test framework code. Verify via lint, dev.log, and Agent Browser.
- shadcn/ui components already exist in `src/components/ui/*`. Use them; do not rebuild.
- Append to this file with `cat >> worklog.md << 'EOF' ... EOF` (Bash), or careful Edit at end-of-file.
---
Task ID: 3-b
Agent: full-stack (AI/platform APIs)
Task: AI, payments, ledger, automation, platform API routes

Work Log:
- Read worklog.md, docs/API.md, and all lib files (api.ts, ai/providers.ts, ai/llm.ts, ai/embeddings.ts, ai/receptionist.ts, automation/engine.ts, business/payments.ts, business/collections.ts, audit.ts, org.ts, db.ts, crypto.ts, business/ledger.ts) before writing code.
- Created 38 route files under src/app/api/: setup (GET/PUT, complete, readiness), knowledge (GET/POST, [id] PATCH/DELETE, search), conversations (GET/POST, [id] GET/PATCH, [id]/messages POST, [id]/agent-reply POST), providers (GET, [capability] PUT, [capability]/test POST), ai/logs GET, settings (data-mode PUT, channels GET/PUT), webhook-secret PUT, payments (webhook PUBLIC, simulate-webhook, GET queue, [id]/verify, [id]/reject), invoices/[id]/payments + /claims POST, ledger (GET, export CSV, [id]/reverse), automations (GET/POST, [id] PATCH/DELETE, [id]/runs GET, run POST), outbox GET, audit GET, health PUBLIC + health/detail, dashboard GET, admin/backup POST + admin/export GET.
- Readiness + dashboard use REAL DB checks only (counts, provider lastTestOk, AppSetting presence, setupState.business.done for timezone honesty). Dashboard readiness logic duplicated inline (no HTTP self-call, no cross-route imports).
- Conversations messages POST: captures status before/after handleReceptionistTurn, emits `conversation_escalated` via emitEvent only on open→waiting_human transition during that turn; catches generic turn errors and returns honest {reply:'', aiUsed:false, error} body.
- Payments webhook (public): raw text body, org resolved from org_slug/orgSlug in payload, 401 on unparseable JSON, 400 missing org_slug, 404 unknown org, HMAC verify via getWebhookSecret+verifyWebhookSignature, processWebhook in try/catch — invoice_not_found/overpay return real statuses, everything else 202 {result:'error'}; never 500 on business outcomes.
- simulate-webhook: requires org secret (403 with guidance message otherwise), builds real signed payload (event_id sim-<randomToken(12)>, org_slug), verifies its own signature before processing (end-to-end same path), audits 'webhook.simulated'.
- webhook-secret PUT stores RAW string in AppSetting 'webhook_secret' (not JSON-wrapped, matches getWebhookSecret's plain read); returned once; audited.
- admin/backup: VACUUM INTO backups/backup-<ts>.db (mkdir recursive, quote-escaped path), returns {file, bytes}; honest 500 on failure. admin/export: full org JSON attachment; providerConfig/appSettings/sessions omitted, passwordHash stripped (verified: no apiKeyEnc/webhook_secret value/passwordHash/tokenHash in output).
- Settings channels use AppSetting presence as source of truth; PUT true→setSetting, false→delete row.
- Verified end-to-end against the running dev server with a temporary owner + viewer login: AI receptionist turn (managed gateway, tool calls, honest reply), knowledge index/search, providers PUT/test (real gateway test ok), webhook rotate→simulate→processed→overpay 409, unsigned webhook→rejected, unparseable→401, claim→queue→verify→ledger entries, CSV export, reverse + already-reversed 409, automations create→tick (invoice_overdue fired notify_inapp)→runs→delete, outbox, audit, health/detail (db:true, heartbeat healthy), dashboard (outstanding/overdue/readiness 7/9), backup (430080 bytes), role 403s for viewer on owner/admin routes, CSRF 403 without x-requested-with. Temp test users + scripts deleted afterwards; test automations cleaned up.
- Verification: `npx tsc --noEmit` filtered → ZERO errors; `bun run lint` → clean; dev.log shows all routes 200/201/202 with correct 4xx for guard cases.

Stage Summary:
- All 3-b scope endpoints implemented per docs/API.md + task notes: /api/setup*, /api/knowledge*, /api/conversations*, /api/providers*, /api/ai/logs, /api/settings/*, /api/webhook-secret, /api/payments* (webhook, simulate-webhook, queue, verify, reject), /api/invoices/[id]/payments + /claims, /api/ledger* (GET/export/reverse), /api/automations* (+ run, [id]/runs), /api/outbox, /api/audit, /api/health(/detail), /api/dashboard, /api/admin/backup + /api/admin/export.
- Deviations (small, documented): (1) messages POST returns {reply, assistantReply (alias), toolCalls, aiUsed, error?} — assistantReply kept for API.md shape compatibility alongside the task-specified `reply`; (2) messages POST returns an honest no-AI reply ({reply:'', aiUsed:false, error:'AI is disabled…'}) when conversation.aiEnabled=false instead of silently running the AI after a human takeover; (3) GET /api/setup/complete and POST /api/setup/complete restricted to owner/admin (setup is an owner task); (4) providers test POST restricted to owner/admin (it stores state); (5) readiness items include a `timezoneSet` detail that treats 'UTC' as unset unless setupState.business.done — per task note; (6) dashboard readiness returns {okCount, total, items} (superset of contract).
- Note for 3-a: POST /api/invoices initially 500'd (ledgerEntry FK violation inside createInvoice transaction) — later observed working (201) after that agent's own fix; no 3-b files touched their scope.
- Note for 3-c (frontend): webhook secret is only visible in the PUT /api/webhook-secret response — show it once with copy UI; channels GET/PUT shape {email, sms}; outbox messages carry honest status + statusReason; readiness items have {key,label,ok,detail} for rendering.
---
Task ID: 4-a
Agent: frontend (dashboard/settings/diagnostics)
Task: Dashboard, Business Profile, Diagnostics sections

Work Log:
- Read worklog.md, docs/API.md, client api.ts/store.ts, auth-screen/sidebar conventions; inspected live response shapes of /api/dashboard, /api/setup, /api/health/detail, /api/admin/backup before writing UI (no guessed fields).
- Rewrote dashboard-section.tsx: 4 KPI stat cards as real buttons (Today's appointments, Outstanding balance via formatMoney+session currency, Overdue count, Inbox waiting-human) each setActiveSection to bookings/invoices/inbox; "Today & upcoming" card (today+upcoming deduped by id, sorted, capped 8 with "+N more"); "Overdue invoices" card with clickable rows (handles backend `customer` string field plus task-spec customerName fallback); Setup readiness card with Progress(okCount/total) + item list + setup-wizard link; Recent activity (audit with guarded meta JSON summary) and Outbox card (honest statuses: amber queued / destructive failed / emerald sent, statusReason shown for queued+failed, fixed note that no email/SMS sender is wired in this build). Skeletons for load, destructive Alert+Retry on error, aria-live "Updated HH:MM", Refresh button, 30s polling cleared on unmount.
- Rewrote business-section.tsx: loads GET /api/session (role) + GET /api/setup; guarded JSON.parse helpers for openingHours/policies/aiIdentity/collectionsCfg strings. 5 groups, each with explicit Save button → PUT /api/setup {step, data}: (1) business profile (name, businessType Select, fixed-offset timezone Select labelled "Fixed offset (no DST)" with dynamic option if current value outside list, locale, currency Select USD/EUR/GBP/INR/AED/SGD, address, phone, email — after name change refreshes store session via GET /api/session → setSession); (2) opening hours per weekday (0=Sun..6=Sat) Switch + single start/end time window stored as openingHours JSON keyed "0".."6" → [["HH:MM","HH:MM"]], holidays comma-separated YYYY-MM-DD → JSON array (client validates format + start<end with destructive toasts); (3) policies (autoConfirmBookings, cancellation.minHoursBefore, deposit.requiredForBooking, quietHours start/end) saved as nested policies JSON matching seed shape; (4) AI identity (tone Select professional/friendly/concise, greeting/closing/escalationNote); (5) collections (reminderDays parsed→sorted number[], maxTouchesPerInvoice, quietStart/End, templates first/second/final textareas with {{customer_name}}/{{invoice_number}}/{{amount_due}}/{{due_date}}/{{business_name}} placeholders shown). Non owner/admin get read-only Alert (Eye icon) + all inputs disabled + Save buttons hidden. Per-group saving state, success/destructive toasts, skeletons + retry.
- Rewrote diagnostics-section.tsx: GET /api/health/detail with optional-field guards ("render what exists" → unknown state uses muted CircleHelp). Core health rows with CheckCircle2/XCircle + human explanations (db round-trip, encryption key at rest, webhook secret verification, worker heartbeat "ticked recently" + last tick detail). Unhealthy heartbeat → amber warning Alert explaining what's paused with "Run automations now" button (POST /api/automations/run → toast → silent refresh; verified the warning clears after a tick). Provider cards (LLM + embedding: enabled/lastTestOk → ok/fail/unknown + provider detail) with link to AI Providers section. Data privacy panel: dataMode badge + per-mode explanation (local_only/hybrid/cloud_first) + link to AI Providers. Counts table (Table). Backup card: role-gated (owner/admin) "Create backup" → POST /api/admin/backup showing file+formatBytes honestly, "Export data (JSON)" window.open('/api/admin/export'), non-admin sees explanatory note instead. 20s auto-refresh cleared on unmount, aria-live updated label, skeletons + retry.
- Verified live with Agent Browser (demo login): dashboard KPIs/overdue rows render real data and navigate on click; business forms hydrate from demo org; toggled Sunday → Save → toast + backend openingHours["0"]=[["09:00","17:00"]] → reverted → []; diagnostics showed honest failing webhook-secret/heartbeat/provider tests, "Run automations now" ticked (outbox queued 0→2 in counts table) and cleared the warning, backup created (backup-<ts>.db, emerald result box), export API 200. Zero page/console errors.
- Verification: `npx tsc --noEmit` filtered → ZERO errors in my three files (remaining repo errors are in bookings-section/inbox-section owned by other agents); `bun run lint` → no issues in my files (only pre-existing inbox-section errors + bookings warning); did not touch any other section, page.tsx, sidebar, or backend files; dev server untouched.

Stage Summary:
- All three sections consume real API shapes: dashboard.overdue rows use `customer` (string) — other agents rendering overdue data should read `customer`, not customerName; readiness items include key/label/ok/detail.
- Business saves go through PUT /api/setup {step:'business'|'policies'|'ai_identity'|'collections', data:{...}} — JSON columns (openingHours/policies/aiIdentity/collectionsCfg) must be passed as nested OBJECTS (backend stringifies); openingHours shape is {"0..6": [["HH:MM","HH:MM"]]} with [] for closed, holidays is a string[] under step 'business'. collectionsCfg.templates now holds {first,second,final} (optional — automations still use their own action cfg.template default).
- Diagnostics roles: session.user.role in {owner,admin} gates backup/export; /api/admin/export opens in a new tab as a JSON attachment.
- Polling: dashboard 30s, diagnostics 20s, both cleared on unmount; business does not poll (single load + manual retry).
- Known honest states in demo org: webhookSecret unconfigured, worker heartbeat can be stale (warning + run-now provided), outbox stays 'queued' (no sender wired) — UI states all of this explicitly.
---
Task ID: 4-b
Agent: frontend (operations sections)
Task: Bookings, Customers, Invoices & Payments, Ledger sections

Work Log:
- Read worklog.md, docs/API.md, client api.ts/store.ts, auth-screen/sidebar conventions; verified every endpoint shape LIVE before/while building (login via demo cookie): {bookings|services|staff|customers|invoices|payments|entries+balances|events} wrapper objects, booking includes customer/service/staff, invoice list carries customer + outstandingCents, payments queue carries invoiceNumber/customerName, ledger entries carry invoiceNumber, customer detail = {customer, bookings(+service/staff), invoices, summary}, statement = {customer, invoices, totalOutstandingCents, ledgerRows}.
- bookings-section.tsx: Tabs Upcoming | Calendar | New booking | All. Upcoming grouped by day (date-fns, Today/Tomorrow labels) with status + source badges and per-row Confirm/Complete/No-show (PATCH {action}) plus Reschedule Dialog (date input → GET /api/availability real slots as selectable 44px buttons → PATCH {action:'reschedule',startAt}) and Cancel AlertDialog with reason (PATCH {action:'cancel',reason}). Calendar = next-7-days grid (honest day buttons + counts) filtering a full list below with actions. New booking form: customer Select with "+ New customer…" inline name/phone (POST /api/customers first), service Select (duration+price), staff Select filtered by staff.serviceIds, real SlotPicker (auto-loads availability, retry + honest empty state), notes; 409 conflict shown verbatim in destructive Alert inside form ("That time conflicts with an existing appointment."). All tab: status filter + client-side search table, row click → detail Dialog (notes, price, created, cancel reason, all actions).
- customers-section.tsx: Tabs Directory | Import. Directory: search (name/email/phone), table with tags Badges + opt-out icon; View Dialog (fetches /api/customers/[id] + /statement in parallel; internal Tabs Details/Bookings/Invoices/Statement with total outstanding prominent + ledger rows); Edit Dialog (fields + consentContact Switch + optOut Switch with plain-language "Opt out stops ALL automated reminders and messages"); Delete AlertDialog surfacing 409 verbatim (verified: "Customer has outstanding invoices and cannot be deleted"); New customer Dialog. Import tab: CSV paste textarea, client-generated template download (Blob, header name,email,phone,notes,tags + 2 example rows), POST /api/customers/import → honest report {created, errors:[{row,message}]} including partial-result bodies on 4xx.
- invoices-section.tsx: Tabs Invoices | Payments to verify | New invoice. Invoices table (number/customer/issue/due/total/paid/outstanding/status) + status filter; row → Detail Dialog (GET /api/invoices/[id]): line items, totals, payment history (status badge + source), Record verified payment Dialog (amount prefilled with outstanding, dollars→Math.round(*100) cents, method Select, reference; 409 overpay verbatim), TEST HARNESS-labeled Simulate webhook Dialog (POST /api/payments/simulate-webhook {invoiceNumber, amountCents} → processed/duplicate/rejected + explanation that real providers POST /api/payments/webhook with HMAC x-signature), Void AlertDialog → PATCH {action:'void'}; all gated to owner/admin via session role with honest "restricted" note. Verify tab: policy banner ("A customer claim is never auto-settled…"), queue table with Verify (POST /api/payments/[id]/verify) and Reject AlertDialog+reason (owner/admin). New invoice: customer Select, line-items editor (qty + dollars → cents, add/remove, live subtotal), tax, dueInDays, rental period dates, notes → POST /api/invoices → toast with created number.
- ledger-section.tsx: Tabs Entries | Balances | Audit trail. Entries: /api/ledger?limit=200 table (date, type Badge, debit → credit, amount, memo, invoiceNumber button → jumps to invoices section, "reversal" Badge) + Export CSV (window.open('/api/ledger/export')) + owner/admin Reverse per row (AlertDialog + memo → POST /api/ledger/[id]/reverse; 409 "This entry has already been reversed" verbatim). Balances: highlight cards (accounts_receivable = money owed to you, cash = money received, revenue = invoiced value) + full debit/credit/net table. Audit: /api/audit?limit=100 with actorType Badge, entity + short id, meta JSON pretty-printed; max-h-96 scroll.
- Global rules honored everywhere: Skeleton loading, empty CTAs, Alert+retry errors, toasts on outcomes, p-4/p-6 cards, max-h-96 overflow lists, min-h-[44px] targets, aria-labels on icon buttons, status badge map (confirmed/paid/verified=emerald, pending/partial/pending_verification=amber, cancelled/void/sent=muted, completed=neutral-700, no_show/overdue=rose), zero blue/indigo/sky.
- Verification: live E2E via curl on the running dev server — booking create→duplicate-slot 409 (verbatim conflict msg)→confirm→reschedule→cancel; invoice create→verified payment 201→overpay 409 verbatim; ledger reverse 201→second reverse 409 verbatim; void invoice → status void; CSV import {created:1, errors:[{row:3,message:'name is required'}]}; delete-with-invoices 409 verbatim. `npx tsc --noEmit` filtered → ZERO errors from my four files (remaining errors are inbox/knowledge sections owned by other agents). `bun run lint` → zero problems in my files (2 remaining errors are inbox-section.tsx, not my scope). GET / → 200, dev.log clean.

Stage Summary:
- Sections now live: #bookings, #customers, #invoices, #ledger all call only the documented API shapes; list endpoints wrap in {bookings|services|staff|customers|invoices|payments|entries+balances|events} — do not change wrappers without updating these files.
- Shared client helpers used: api.get/post/patch/delete, formatMoney/formatDateTime/formatDate, useAppStore session.user.role for owner/admin gating (payments record/void/simulate, ledger reverse, verify/reject hidden for non-admins with honest note).
- 409s are surfaced verbatim in-dialog (slot conflict, overpay, already-reversed, delete-with-invoices) — keep those messages stable.
- Local type extensions (BookingRow.createdAt/cancelReason, ledger invoiceNumber, queue payment invoiceNumber/customerName) are additive over @/lib/client/api types; if api.ts gains these fields the local intersections stay compatible.
- Demo data note: a "QA Probe 4b" customer (paid + voided invoice, cancelled booking, reversed ledger entry) intentionally remains as evidence of the E2E run; DELETE refused by design (has invoices).
- For other agents: page.tsx/sidebar untouched; toast = useToast from @/hooks/use-toast; SlotPicker pattern (GET /api/availability with from/to as local-midnight ISO) is reusable for any booking UI.
---
Task ID: 4-c
Agent: frontend (AI sections) — worklog entry recorded by coordinator after agent timeout (all files were completed before deadline)
Task: Inbox+voice test, Knowledge, Automations, AI Providers, Setup wizard

Work Log:
- All 5 section files completed: inbox-section.tsx (812 lines, two-pane inbox, voice test via Web Speech API + speechSynthesis), knowledge-section.tsx (415), automations-section.tsx (796), ai-section.tsx (531), setup-section.tsx (1587, 8-step wizard with autosave + real E2E test runner).
- Full-project `npx tsc --noEmit` reports ZERO errors; `bun run lint` clean.

Stage Summary:
- Frontend complete: 12 sections + auth screen + sidebar wired into single-page app at /.
- Voice test uses browser SpeechRecognition/SpeechSynthesis with honest unsupported-browser fallback.
---
Task ID: 5-6
Agent: coordinator (Z.ai Code)
Task: Integration fixes + browser E2E self-verification of the golden path

Work Log:
- Fixed availability pool-model gap: pool bookings (no staff) now count ALL overlapping bookings (staff-specific included) in both computeSlots and assertSlotAvailable — conservative shared-resource model, prevents staff/pool double-booking. Documented in code.
- Fixed db.ts query-log noise (log: ['error','warn']).
- Fixed data-flow label for local_lexical provider (was "Disabled — no data is sent anywhere", now "Built-in local retriever — indexing and search run entirely on this machine").
- Rebuilt demo seed robustness (timezone-aware booking times via nthBusinessDay/wallClockAt); cleaned leftover test orgs; re-seeded demo org (5 customers, 4 bookings, 3 invoices, 3 payments incl. 1 pending claim, 5 ledger entries, 4 approved knowledge docs + chunks, 2 automations, 1 conversation).
- Fixed mobile layout: MobileTopBar extracted from Sidebar into normal flow above the content row (sidebar mobile header was a flex-row sibling squeezing main content). Verified main width = viewport width on 390px.
- Browser E2E (agent-browser): auth screen → demo login → dashboard (real KPIs: 5 appointments, USD 175.40 outstanding, overdue list) → Inbox AI receptionist (tool badges shown; booking created via check_availability + create_booking; honest failure path also verified earlier) → Bookings (AI-chat-sourced booking visible with lifecycle actions) → Invoices (recorded verified payment USD 129.60 on INV-2026-0003 → status paid, outstanding 0.00; pending customer claim shown honestly) → Ledger (double-entry: cash→AR payment entry present; reversal entries render) → AI Providers (data-mode radio, capability cards, honest data-flow labels) → Automations (rules + run history) → Setup Wizard step 8 real E2E test (availability 148 slots → booking → invoice INV-2026-0007 → verified payment → 2 balanced ledger entries — ALL PASS) → Knowledge retrieval ("can I cancel my appointment" → Cancellation policy score 0.285).
- Local-only mode test: PUT data-mode local_only → chat message → cloud call blocked with honest error, conversation degraded gracefully; reverted to hybrid.
- Footer behavior verified: long pages push footer to document bottom exactly (footerBottom == scrollH, no gap); mt-auto guarantees stickiness on short pages. Mobile top bar + drawer verified.
- Final: bun run lint clean; tsc zero errors (project code).

Stage Summary:
- Golden path acceptance criteria MET: install → sign in → wizard → customer + service → real booking → invoice → verified payment → ledger inspect, without cloud AI keys; AI chat + browser voice test paths implemented; all 12 sections functional with honest states.
- Remaining honest gaps documented in docs/IMPLEMENTATION_PLAN.md (email/SMS senders, telephony, PSP integrations, Postgres/Docker packaging, Vitest suites outside sandbox).
---
Task ID: 7
Agent: coordinator (Z.ai Code)
Task: Worker startup fix + final docs + delivery

Work Log:
- Diagnosed automation worker not registered: instrumentation.ts was created after dev-server boot (loads at startup only). Restarted dev server cleanly (single instance) → "[worker] automation worker started (60s interval)" logged; verified lastTick auto-updates (10:43:02) and heartbeat healthy without manual triggers.
- Created docs/IMPLEMENTATION_PLAN.md (phases + live status table + honest capability ledger), README.md, AGENTS.md, src/agent.md, docs/agent.md.
- Final checks: bun run lint clean, tsc zero project errors, GET / 200, /api/health ok, /api/health/detail honest, browser sanity pass with zero console errors.

Stage Summary:
- DELIVERED: AI Secretary vertical slice — auth+RBAC, setup wizard with real E2E test runner, customers/services/staff/availability, transactional booking engine, invoices/payments/claims/webhooks, append-only ledger, knowledge+retrieval, AI receptionist (text + browser voice test), native automations with worker, diagnostics/backups/export, demo mode. Honest gaps documented (email/SMS senders, telephony, PSPs, Postgres+Docker packaging, Vitest suites) in docs/IMPLEMENTATION_PLAN.md.
