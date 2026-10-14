# API Contract (v1)

All handlers live in `src/app/api/**/route.ts`. Single-page frontend at `/` calls these with relative URLs.

## Conventions (mandatory)

- Import auth wrapper: `import { withAuth, withPublic, json, fail, parseBody, ApiError } from '@/lib/api'`.
- `withAuth(handler, { roles?: string[] })` → handler receives `(req, ctx, params)` where `ctx = { user, org, role }`. GET+HEAD skip CSRF; mutations require header `x-requested-with: ais` (frontend api helper sends it).
- Validate every body with `parseBody(req, zodSchema)` → throws 422 with field details.
- Money: integer cents everywhere (`priceCents`, `amountCents`, `totalCents`).
- Every consequential mutation calls `audit({ orgId, actorType:'user', actorId: ctx.user.id, action, entity, entityId, meta })` from `@/lib/audit`.
- Business rules live in `src/lib/business/*` — route handlers are thin.
- Errors: throw `new ApiError(status, message, code)` or return `fail(status, message)`. Never leak stack traces.
- All queries MUST scope by `ctx.org.id` (organization isolation).
- Route params in Next 16 are async: `{ params }: { params: Promise<{ id: string }> }` — `withAuth`/`withPublic` already await them for you (handler gets plain object).

## Existing library functions (do NOT reimplement)

- Booking: `createBooking(orgId, {timezone,holidays}, input, actor)`, `rescheduleBooking(...)`, `cancelBooking(...)`, `setBookingStatus(...)` in `@/lib/business/booking`
- Availability: `computeSlots(orgId, {serviceId, staffId?, from, to}, timezone, holidays)` in `@/lib/business/availability`
- Invoice: `createInvoice(orgId, input, actor)`, `voidInvoice`, `recalcInvoiceStatus`, `invoiceOutstanding(total,paid)` in `@/lib/business/invoice`
- Payments: `recordVerifiedPayment(orgId, input, actor)` (idempotent), `recordPaymentClaim`, `verifyPayment`, `rejectPayment`, `verifyWebhookSignature`, `parseWebhookPayload`, `processWebhook`, `getWebhookSecret` in `@/lib/business/payments`
- Ledger: `postEntry`, `reverseEntry`, `accountBalances`, `outstandingReceivables` in `@/lib/business/ledger`
- Collections: `queueInvoiceReminder` in `@/lib/business/collections`
- Knowledge: `indexDocument(orgId, docId, content)`, `searchKnowledge(orgId, q, k)` in `@/lib/ai/embeddings`
- Receptionist: `handleReceptionistTurn(org, conversationId, userMessage)` in `@/lib/ai/receptionist`
- Providers: `getProviderRow`, `getActiveProvider`, `saveProvider`, `runAndStoreTest`, `toPublicConfig`, `CAPABILITIES`, `CAPABILITY_INFO` in `@/lib/ai/providers` — never return `apiKeyEnc`
- Automations: `tick(orgId?)`, `emitEvent`, `workerHeartbeat` in `@/lib/automation/engine`
- Integrations: `getEnabledIntegration`, `getUsableIntegration`, `decryptSecrets`, `sanitizeMessage`, `sendEmail`, `sendTwilio`, `signWebhookPayload`, `testIntegration` in `@/lib/integrations/connectors`; `dispatchOutbox`, `nudgeChannel` in `@/lib/integrations/dispatcher`; `createStripePaymentLink`, `verifyStripeSignature` in `@/lib/integrations/stripe`; `renderInvoiceEmail` in `@/lib/integrations/templates`; `buildIcs` in `@/lib/integrations/ics`; `publicIntegration` in `@/lib/integrations/kinds` — never return `secretsEnc`
- Demo: `seedDemo()` in `@/lib/demo/seed`
- Org helpers: `parseJson`, `getSetting`, `setSetting`, `updateOrgField` in `@/lib/org`

## Endpoints

### Session / auth (public unless noted)
- `GET /api/session` → `{ needsSetup: boolean }` if no users exist, else `{ authenticated: boolean, user?: {id,name,email,role}, org?: {id,name,slug,demo,setupComplete,dataMode,timezone,currency,businessType}, demoAvailable: boolean }` (demoAvailable = whether a demo org with credentials exists; do NOT leak hashes)
- `POST /api/auth/login` `{email,password}` → sets session cookie (`sessionCookie` helper + `createSession`). Compare with `verifyPassword`. Audit `auth.login`.
- `POST /api/auth/logout` (auth) → clear cookie, delete session row.
- `POST /api/auth/register-owner` — only when zero users exist: `{orgName, businessType, name, email, password}` → create org (slug from name, unique-ified) + owner + default working hours Mon–Fri 9–17 + default provider rows. Audit `setup.owner_registered`.
- `POST /api/demo/seed` — public, rate-limited: idempotent `seedDemo()` → `{orgId, email, password}` (demo credentials for login).

### Setup wizard (auth)
- `GET /api/setup` → `{ state: parsed setupState, org }`
- `PUT /api/setup` `{step: string, data: Record<string,unknown>}` → merge into `org.setupState` + apply business fields (name/timezone/openingHours/policies/aiIdentity per step). Return updated state. Audit `setup.step_saved`.
- `POST /api/setup/complete` → set `setupComplete=true`. Audit `setup.completed`.
- `GET /api/setup/readiness` → live checks: `{ items: [{key,label,ok,detail}] }` — hasServices, hasWorkingHours, hasKnowledge(approved docs ≥1), llmConfigured&tested, customerCount, timezone set, webhookSecret, automationDefined. NEVER fake checks.

### Customers (auth)
- `GET /api/customers?query=` → search name/email/phone (take 100, order by updatedAt desc). Return `{customers:[{id,name,email,phone,tags,parsed, optOut, consentContact, createdAt}]}`.
- `POST /api/customers` `{name, email?, phone?, notes?, tags?}` → audit `customer.created`.
- `GET /api/customers/[id]` → customer + bookings + invoices summary.
- `PATCH /api/customers/[id]` any subset incl. `optOut`, `consentContact`. Audit `customer.updated`.
- `DELETE /api/customers/[id]` — refuse if invoices with outstanding balance exist (409). Audit `customer.deleted`.
- `POST /api/customers/import` `{csv: string}` → parse header `name,email,phone,notes,tags`; per-row errors reported `{created, errors:[{row, message}]}`. Audit `customer.imported`.

### Services / staff (auth)
- `GET /api/services`, `POST /api/services` `{name, description?, category?, durationMin, priceCents, bufferBeforeMin?, bufferAfterMin?, maxPerSlot?, requiresDeposit?, depositCents?}`, `PATCH /api/services/[id]`, `DELETE /api/services/[id]` (refuse if bookings exist → suggest `active:false`).
- `GET /api/staff` → staff + serviceLinks + workingHours. `POST /api/staff` `{name, role?, email?, phone?}`. `PATCH /api/staff/[id]`. `PUT /api/staff/[id]/services` `{serviceIds:[]}`. `PUT /api/staff/[id]/hours` `{hours: [{dow,startMin,endMin}]}` (replace set). Org-wide hours: `PUT /api/staff/hours` (staffId null).
- `GET /api/availability?serviceId=&from=ISO&to=ISO&staffId=` → `{slots:[{startAt,endAt,staffId}]}` via computeSlots.

### Bookings (auth)
- `GET /api/bookings?from&to&status&customerId` → include customer{name}, service{name}, staff{name}; ordered by startAt.
- `POST /api/bookings` `{customerId, serviceId, staffId?, startAt, notes?}` → calls createBooking. Audit done inside service.
- `PATCH /api/bookings/[id]` `{action:'reschedule'|'cancel'|'confirm'|'complete'|'no_show', startAt?, reason?}`.
- `POST /api/bookings/[id]/remind` → queue a booking reminder to outbox (honest states).

### Invoices & payments (auth)
- `GET /api/invoices?status&customerId` → include customer name, computed `outstandingCents`.
- `POST /api/invoices` `{customerId, items:[{description,qty,unitPriceCents}], taxCents?, dueInDays?, rentalPeriod?, notes?}`.
- `GET /api/invoices/[id]` → invoice + items + payments.
- `PATCH /api/invoices/[id]` `{action:'void'|'mark_uncollectible'}` (owner/admin only).
- `POST /api/invoices/[id]/payments` `{amountCents, method?, reference?}` (owner/admin) → recordVerifiedPayment (verified immediately; audited).
- `POST /api/invoices/[id]/claims` `{amountCents, method?, reference?, note?}` → pending_verification.
- `POST /api/invoices/[id]/send` (owner/admin) → queues the REAL invoice email: renders text+HTML (`renderInvoiceEmail`), best-effort Stripe payment link when stripe is enabled (`paymentLinkError` reported honestly on failure), opt-out/consent enforced, deduped per invoice per calendar day → `{queued: true, outboxId, channel: 'email', recipient, paymentLink?, paymentLinkError?}`. Errors: `404 not_found`, `409 invoice_void`, `422 no_email`, `409 opt_out`, `409 already_queued` (extra `outboxId` of the existing row). Audit `invoice.sent`.
- `POST /api/invoices/[id]/payment-link` (owner/admin) → REAL Stripe Payment Link for the outstanding balance → `{url, id}`. Errors: `503 stripe_not_enabled`, `409 invoice_void`, `409 already_paid`, `502 stripe_error` (sanitized Stripe message). Audit `invoice.payment_link_created`.
- `GET /api/payments?status=pending_verification` → verification queue (join invoice+customer).
- `POST /api/payments/[id]/verify` (owner/admin), `POST /api/payments/[id]/reject` `{reason}` (owner/admin).
- `POST /api/payments/webhook` — PUBLIC. Reads raw body + `x-signature` header; secret from `getWebhookSecret(orgId)` (org resolved by `orgSlug` field in payload JSON). Returns 202 `{result: processed|duplicate|rejected}` on any validation outcome, 401 only when payload cannot be parsed. NEVER processes without valid signature.
- `POST /api/payments/simulate-webhook` (owner/admin) — TEST HARNESS: constructs a real signed webhook event (uses org webhook secret, generates eventId) and runs the same `processWebhook` path. Body `{invoiceNumber, amountCents, method?, reference?}`. Audit `webhook.simulated`. Clearly labeled in UI.
- `PUT /api/webhook-secret` (owner/admin) → rotate secret (returns it once, over HTTPS, to the admin — this is the only time the secret is visible). Audit.
- `POST /api/stripe/webhook` — PUBLIC. Verifies `Stripe-Signature: t=…,v1=…` (HMAC-SHA256 over `"<t>.<rawBody>"` with the stripe integration's `webhookSecret`, timing-safe) → `400 invalid_signature` otherwise. Org from `data.object.metadata.org_slug`, else the org whose secret verifies. Handled: `checkout.session.completed` (`amount_total`), `payment_intent.succeeded` (`amount_received`) → VERIFIED payment via the idempotent `processWebhook` path (overpay/currency-mismatch rejected honestly with `result:'error'` under 200). Dedupe by `event.id` → `{received:true, result:'duplicate', eventId}`; other types → `result:'ignored'`. Success → `{received:true, result:'processed', eventId, paymentId}`.

### Integrations (auth; owner/admin for mutations)

- `GET /api/integrations` → `{integrations: [{id, kind, label, config, configured: boolean, enabled, lastTestAt: string|null, lastTestOk: boolean, lastTestError: string, createdAt}]}` — `config` is the parsed non-secret `configJson`; credentials are represented ONLY by `configured` (secrets are never returned).
- `POST /api/integrations` (owner/admin) `{kind, label?, config?, secrets?}` → `201 {integration}`. Kinds: `smtp`, `twilio_sms`, `twilio_whatsapp`, `stripe`, `webhook_out`. Per-kind config schemas: smtp `{host, port, secure?, from}`; twilio_* `{from}`; stripe `{}`; webhook_out `{url}`. Per-kind secrets: smtp `{user?, pass?}`; twilio_* `{accountSid, authToken}`; stripe `{secretKey, webhookSecret?}`; webhook_out `{secret?}`. Singleton kinds reject a second row (`409 already_configured`); `webhook_out` allows one per destination URL. Errors: `422 bad_kind | validation | insufficient_secrets`. Rows are created `enabled: false`. Audit `integration.created` (meta without secrets).
- `PATCH /api/integrations/[id]` (owner/admin) `{label?, config?, secrets?, enabled?}` — `secrets` as an object = FULL replacement (encrypted); `secrets: null` clears credentials and forces `enabled:false`. Enabling requires sufficient credentials, except `smtp`/`webhook_out` where anonymous/unsigned is legitimate (`400 not_configured | insufficient_secrets`). Enabling nudges queued outbox messages of the matching channel for the next dispatch tick. Audit `integration.updated` (meta: `changed` field names only).
- `DELETE /api/integrations/[id]` (owner/admin) → `{deleted: true}` — removes the row and its encrypted credentials. Audit `integration.deleted`.
- Per-kind connection tests (`nodemailer verify`, Twilio/Stripe account fetch, signed webhook test POST) exist in `@/lib/integrations/connectors.testIntegration` but are NOT exposed as an HTTP endpoint in this build — enabling + dispatching a real message is the verification path.

### Outbox / calendar (auth)

- `GET /api/outbox?status=` → `{messages}` (last 200) — `OutboxMessage` rows with honest `status` (`queued|sent|failed|skipped`), `statusReason`, `attempts`, `channel` (`email|sms|whatsapp|webhook|inapp`), `dedupeKey`, `scheduledFor`, `sentAt`.
- `POST /api/outbox/dispatch` (owner/admin) → releases backoff for every enabled channel, runs `dispatchOutbox()` now → `{ok: true, stats: {processed, sent, failed, waiting}}`. Audit `outbox.dispatched`. (Worker ticks the dispatcher every 30s automatically.)
- `GET /api/calendar/bookings.ics?from=&to=` → subscribable RFC 5545 feed (`text/calendar`; default next 30 days, `pending`+`confirmed` bookings, TENTATIVE/CONFIRMED status, −60 min VALARM). Cookie session auth.
- `GET /api/calendar/bookings/<id>.ics` → single booking as one VEVENT (accepts `<id>.ics` or `booking-<id>.ics`; `404` outside the org). Cookie session auth.

### Ledger (auth)
- `GET /api/ledger?from&to&limit` → `{entries, balances}`.
- `GET /api/ledger/export` → text/csv attachment.
- `POST /api/ledger/[id]/reverse` `{memo?}` (owner/admin) → reverseEntry.
- `GET /api/customers/[id]/statement` → `{customer, invoices:[{number,total,paid,outstanding,status}], ledgerRows}`.

### Knowledge (auth)
- `GET /api/knowledge` → docs with chunk counts. `POST /api/knowledge` `{title, content, approved?, tags?}` → indexDocument (response includes `chunkCount` + `embeddingModel`). Audit.
- `PATCH /api/knowledge/[id]` (re-index on content/approved change), `DELETE /api/knowledge/[id]`.
- `GET /api/knowledge/search?q=` → hybrid search hits (approved only): `{docId, docTitle, chunkId, text, score, scores:{dense|null, lexical}}`.
- `GET /api/knowledge/index` → index status `{provider, model, enabled, docs, approvedDocs, totalChunks, chunksWithCurrentModel, needsReindex, neuralReady}`.
- `POST /api/knowledge/reindex` (owner/admin) → re-embed all docs with the active embedding provider; audited; returns honest summary `{docs, chunks, model, dim, ms, errors[]}`.

### Conversations / inbox (auth)
- `GET /api/conversations?status=` → with last message preview + customer name.
- `POST /api/conversations` `{contactName?, customerId?, channel?}` → open conversation.
- `GET /api/conversations/[id]` → conversation + messages asc.
- `POST /api/conversations/[id]/messages` `{content}` → handleReceptionistTurn → `{assistantReply, toolCalls, aiUsed, error?}`. Emit `conversation_escalated` event when status became waiting_human.
- `PATCH /api/conversations/[id]` `{status?, aiEnabled?}` (take over/close/resume AI).
- `POST /api/conversations/[id]/agent-reply` `{content}` → human agent message (role 'agent').

### AI providers (auth; owner/admin for mutations)
- `GET /api/providers` → `{capabilities: {llm: PublicProviderConfig, ...}, dataMode, capabilityInfo}` — never secrets.
- `PUT /api/providers/[capability]` `{provider, label?, baseUrl?, model?, apiKey? (''=clear, undefined=keep), enabled?, config?}`. Audit `settings.provider_updated` (meta without secrets).
- `POST /api/providers/[capability]/test` → runAndStoreTest → `{ok, message, latencyMs}`.
- `GET /api/ai/logs?limit=` → recent AiLog rows (no content, only metrics).
- `PUT /api/settings/data-mode` `{dataMode: 'local_only'|'hybrid'|'cloud_first'}` (owner/admin). Audit `settings.data_mode_changed`.
- `GET /api/settings/channels`, `PUT /api/settings/channels` `{email: boolean, sms: boolean}` → writes AppSetting `channel_email`/`channel_sms` (presence marks the channel "configured" for reminder queueing); actual delivery runs through Integrations (SMTP/Twilio) via the outbox dispatcher — see [INTEGRATIONS.md](./INTEGRATIONS.md).

### Automations (auth)
- `GET /api/automations` → with last 5 runs each. `POST /api/automations` `{name, description?, triggerType, triggerCfg?, conditions?, delayMinutes?, actions, maxRunsPerDay?, quietHours?, testMode?, enabled?}` (owner/admin). Audit.
- `PATCH /api/automations/[id]`, `DELETE /api/automations/[id]` (owner/admin).
- `POST /api/automations/run` → tick(ctx.org.id) → stats. (Worker also ticks every 60s.)
- `GET /api/automations/[id]/runs` → history. Outbox listing/dispatch is under "Outbox / calendar" above.

### Audit / health / dashboard
- `GET /api/audit?limit=100` → latest events.
- `GET /api/health` — PUBLIC: `{ok:true, time}` (liveness). `GET /api/health/detail` (auth): `{db, encryptionKey, webhookSecret, workerHeartbeat, providers:{llm:{provider,enabled,lastTestOk}, embedding:{...}}, counts:{customers,bookings,invoices,outboxQueued}, dataMode}` — real checks only.
- `GET /api/dashboard` → `{todayBookings, upcomingBookings(5), outstandingCents, overdue:[{id,number,customer,daysOverdue,outstanding}], openConversations, recentAudit(8), outboxRecent(5), readiness:{okCount,total}}`.
- `POST /api/admin/backup` (owner/admin) → run `VACUUM INTO` to `backups/backup-<ts>.db` (mkdir, return filename+size). Honest errors.
- `GET /api/admin/export` (owner/admin) → JSON export of org data (customers, services, bookings, invoices+items, payments, ledger, knowledge, conversations+messages, automations). No secrets.

## Response shapes
Success: `json(data)` (200) or `json(data, 201)`. Errors: `{error: string, code?: string, ...}`. All timestamps ISO strings.
