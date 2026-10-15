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
- Speech: `transcribeAudio`, `synthesizeSpeech`, `chunkForTts`, `ensureVoiceProviders` in `@/lib/ai/speech` — STT/TTS route through the same BYOK/policy layer as chat (`capability 'stt'/'tts'`)
- Automations: `tick(orgId?)`, `emitEvent`, `workerHeartbeat` in `@/lib/automation/engine`
- Integrations: `getEnabledIntegration`, `getUsableIntegration`, `decryptSecrets`, `sanitizeMessage`, `sendEmail`, `sendTwilio`, `signWebhookPayload`, `testIntegration` in `@/lib/integrations/connectors`; `dispatchOutbox`, `nudgeChannel` in `@/lib/integrations/dispatcher`; `createStripePaymentLink`, `verifyStripeSignature` in `@/lib/integrations/stripe`; `renderInvoiceEmail` in `@/lib/integrations/templates`; `buildIcs` in `@/lib/integrations/ics`; `testCaldav`, `bookingToVEvent`, `putBookingEvent`, `deleteRemoteEvent`, `caldavCreds` in `@/lib/integrations/caldav`; `publicIntegration` in `@/lib/integrations/kinds` — never return `secretsEnc`
- Telephony: `verifyTwilioSignature`, `candidateWebhookUrls`, `resolveTelephonyRoute`, `formParams`, `matchCustomerByPhone`, `logWebhook`, and the TwiML builders (`twiml`, `say`, `gatherSpeech`, `dialNumber`, `hangup`, `speakable`) in `@/lib/telephony/twiml`
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
- `POST /api/integrations` (owner/admin) `{kind, label?, config?, secrets?}` → `201 {integration}`. Kinds: `smtp`, `twilio_sms`, `twilio_whatsapp`, `twilio_voice`, `caldav`, `stripe`, `webhook_out`. Per-kind config schemas: smtp `{host, port, secure?, from}`; twilio_sms/twilio_whatsapp `{from}`; twilio_voice `{from, language?, voiceName?, transferNumber?, publicBaseUrl?}`; caldav `{url, username?}`; stripe `{}`; webhook_out `{url}`. Per-kind secrets: smtp `{user?, pass?}`; twilio_* `{accountSid, authToken}`; caldav `{password?}` (password optional — local servers may allow anonymous writes); stripe `{secretKey, webhookSecret?}`; webhook_out `{secret?}`. Singleton kinds (incl. `twilio_voice`, `caldav`) reject a second row (`409 already_configured`); `webhook_out` allows one per destination URL. Errors: `422 bad_kind | validation | insufficient_secrets`. Rows are created `enabled: false`. Audit `integration.created` (meta without secrets).
- `PATCH /api/integrations/[id]` (owner/admin) `{label?, config?, secrets?, enabled?}` — `secrets` as an object = FULL replacement (encrypted); `secrets: null` clears credentials and forces `enabled:false`. Enabling requires sufficient credentials, except `smtp`/`webhook_out` where anonymous/unsigned is legitimate (`400 not_configured | insufficient_secrets`). Enabling nudges queued outbox messages of the matching channel for the next dispatch tick. Audit `integration.updated` (meta: `changed` field names only).
- `DELETE /api/integrations/[id]` (owner/admin) → `{deleted: true}` — removes the row and its encrypted credentials. Audit `integration.deleted`.
- Per-kind connection tests (`nodemailer verify`, Twilio/Stripe account fetch, CalDAV PROPFIND, signed webhook test POST) exist in `@/lib/integrations/connectors.testIntegration` but are NOT exposed as an HTTP endpoint in this build — enabling + dispatching a real message is the verification path.
- `POST /api/integrations/caldav-sync` (owner/admin) `{days?: 1–120 (default 45), verifyFirst?: boolean (default true)}` → real CalDAV push sync: upcoming `pending|confirmed` bookings within the horizon (cap 500) are PUT to the configured collection as `booking-{id}@{orgslug}.ics` (idempotent upsert; RFC 5545 VEVENT with UTC stamps, folding/escaping, `X-AIS-ORG`). `verifyFirst` runs a PROPFIND health check first and updates `lastTest*`; failure → `502 health_check_failed`. Errors: `403 forbidden` (role), `404 not_found` (no caldav integration), `409 disabled`, `422 bad_config` (missing URL). Success → `{pushed, failed, total, results: [{bookingId, uid, ok, detail, title}] (first 100), syncedAt}` — per-item truth, never a fake success. Summary persisted in AppSetting `caldav_sync:<integrationId>`; audit `integrations.caldav_sync`.
- `GET /api/integrations/caldav-sync` → `{configured: false}` or `{configured, enabled, lastSync: {at, pushed, failed, total}, lastTestOk, lastTestError}` (drives the "Sync now" button + last-sync summary in the CalDAV card).

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

### Data sources — bring-your-own DB into RAG (auth; owner/admin for mutations)

Connects an external relational database or JSON HTTP endpoint and ingests its rows as knowledge documents in the **same** chunk/embedding pipeline the assistant answers from. Kinds: `postgres`, `mysql`, `sqlite` (Node built-in `node:sqlite`, read-only), `http_json`. Credentials are encrypted (AES-256-GCM) and never returned; SQL is restricted to a single read-only `SELECT`/`WITH` and the result set is capped; `http_json` blocks private/loopback addresses unless `allowPrivate` is set (SSRF guard).

- `GET /api/datasources` → `{sources: PublicDataSource[], kinds: KindInfo[]}` (public source shape excludes connection details; includes `configured`, `documentCount`, `chunkCount`, `lastTest*`, `lastSync*`, `lastSyncStats`).
- `POST /api/datasources` (owner/admin) `{name, kind, connection (per-kind secrets), config?, enabled?, autoSync?, syncIntervalMin?}` → `201 {source}`. `connection` validated per kind; encrypted before storage. Audit `datasource.created`.
- `PATCH /api/datasources/[id]` (owner/admin) — partial update; `connection:null` clears credentials and disables the source; enabling without a stored connection → `400 not_configured`. Audit `datasource.updated`.
- `DELETE /api/datasources/[id]` (owner/admin) → removes the source (its ingested `KnowledgeDoc`s cascade-delete with their chunks). Audit `datasource.deleted`.
- `POST /api/datasources/[id]/test` (owner/admin) → connects, runs the configured query (capped), returns `{result: {ok, message, latencyMs, rowCount?, columns?, preview?}}` and records `lastTest*`. Audit `datasource.tested`.
- `POST /api/datasources/[id]/sync` (owner/admin) → pulls rows, upserts docs by `(dataSourceId, externalId)`, skips unchanged rows (content hash), deletes docs whose rows disappeared, (re)embeds changed docs, records `lastSync*` + `lastSyncStats` + document/chunk counts. Returns `{ok, result:{ok, stats}, message}`. Audit `datasource.synced`.
- Auto-sync: the background worker (`src/instrumentation.ts`) runs `runDueDataSourceSyncs()` every 5 min for `enabled && autoSync` sources whose interval is due.

### Conversations / inbox (auth)
- `GET /api/conversations?status=` → with last message preview + customer name.
- `POST /api/conversations` `{contactName?, customerId?, channel?}` → open conversation.
- `GET /api/conversations/[id]` → conversation + messages asc.
- `POST /api/conversations/[id]/messages` `{content}` → handleReceptionistTurn → `{assistantReply, toolCalls, aiUsed, error?}`. Emit `conversation_escalated` event when status became waiting_human.
- `PATCH /api/conversations/[id]` `{status?, aiEnabled?}` (take over/close/resume AI).
- `POST /api/conversations/[id]/agent-reply` `{content}` → human agent message (role 'agent').

### Voice / speech (auth) — Voice Console

Real STT/TTS routed through the same BYOK provider layer as chat (capabilities `stt`/`tts`; the only server-side speech provider is `openai_compatible` — there is no proprietary AI SDK. The `browser` kind uses the device's built-in Web Speech API and needs no server round-trip). Legacy `managed` rows (retired provider kind) are reset to `browser` on `GET /api/providers` and before each call, so the voice console stays honest instead of pointing at a provider that cannot run. Every call writes an `AiLog` row (metrics only, no content). `local_only` data mode blocks `openai_compatible` speech via the AI policy gate → honest `403`. No audio is ever persisted.

- `POST /api/ai/asr` `{b64: string, mime?: string}` → `{text, provider, model, latencyMs}`. Base64 audio decoded server-side (max ~12 MB raw → `413`; decodes to zero bytes → `400`). `openai_compatible` → `POST {baseUrl}/audio/transcriptions` (multipart, model default `whisper-1`, 60 s timeout). Empty transcript → `502 stt_failed` (sanitized upstream message). Only the transcript is returned. `browser` rows are rejected server-side with `503 speech_provider_unsupported` — use the in-browser mic path instead.
- `POST /api/ai/tts` `{text (≤4000 chars), voice?, speed? (0.5–2.0)}` → `{audio: [{mime, b64}], provider, model, latencyMs}`. Text is split into sentence-bounded ≤1000-char chunks; one audio chunk per upstream request. `openai_compatible` → `POST {baseUrl}/audio/speech` (model default `tts-1`, voice from `config.openaiVoice` or `alloy`, MP3). Errors: `400 empty_text`, `503 speech_not_configured | speech_provider_unsupported`, `502 tts_failed`.

### Telephony (public — Twilio-signature webhooks)

All `/api/telephony/*` routes are PUBLIC but authenticated with Twilio's real signature scheme: `x-twilio-signature` = base64 HMAC-SHA1 over `fullUrl + sorted("Key" + "Value" concat)` using the integration's `authToken`, compared timing-safely. Behind proxies the URL Twilio signed can differ from what the server sees, so verification tries a **candidate URL list**: integration `config.publicBaseUrl` → `PUBLIC_BASE_URL` env → the forwarded request host; any match is authentic. The org is resolved by the called/texted number (`To` matched against the `from` of enabled `twilio_voice`/`twilio_sms` integrations; single-org deployments accept the sole number; `404` plain text when none owns it). Every webhook is stored in `WebhookEvent` (`signatureValid`, `result: received|processed|duplicate|rejected`); invalid/missing signature → `403` text/plain, nothing processed, and a previously rejected event never blocks a properly signed retry (rejected-retry-safe dedup). Responses are TwiML (`application/xml`, `<Response>…</Response>`).

- `POST /api/telephony/voice/incoming` — a call arrives. Opens/reuses a `phone`-channel Conversation keyed by CallSid (`Conversation.externalRef`), matches the caller to a customer by phone digits, audits `telephony.call_started`, and answers with `<Gather input="speech">` + the org's AI-identity greeting (language/voice from config, defaults `en-US`/`alice`). Duplicate CallSid (Twilio retry) → empty TwiML.
- `POST /api/telephony/voice/gather` — one FULL AI receptionist turn per spoken utterance: `SpeechResult` → `handleReceptionistTurn` (same tools as chat: availability, bookings, knowledge, claims, escalate) → reply via `<Say>` + next Gather. Escalation (`waiting_human`): `<Dial>` `config.transferNumber` when set, otherwise a message-taken promise + hangup (conversation closed). No input: reprompt twice, then a polite hangup. Low speech confidence (< 0.45) is annotated to the model. Turn errors degrade to an honest apology line — Twilio always receives valid TwiML.
- `POST /api/telephony/voice/status` — call status callback: `completed` closes the phone conversation; terminal statuses audit `telephony.call_status` (incl. duration). Always `204` for valid signatures.
- `POST /api/telephony/sms/incoming` — inbound SMS: one `sms`-channel Conversation per sender number (`externalRef: "sms:{digits}"`); the inbound message is recorded instantly (`WebhookEvent` payload + `telephony.sms_received` audit) while Twilio gets an immediate empty TwiML. The answer is generated asynchronously through the full receptionist turn and sent via the Twilio Messages API (REST): send failure → OutboxMessage `queued` with the honest `statusReason` (dispatcher retries with backoff); no enabled `twilio_sms` integration → outbox `skipped` with a clear reason. `customer.optOut` is honored absolutely — inbound is stored, nothing is ever sent. Duplicate `MessageSid` → deduped.

### AI providers (auth; owner/admin for mutations)
- `GET /api/providers` → `{capabilities: {llm: PublicProviderConfig, ...}, dataMode, capabilityInfo}` — never secrets. Capabilities include `stt`/`tts` (kinds `browser | openai_compatible`); GET resets any retired `managed` rows for those two to `browser` so the voice console works out of the box. `llm` kinds are `ollama | openai_compatible | none` — there is no built-in/managed model.
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
