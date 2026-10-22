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
- Integrations: `getEnabledIntegration`, `getUsableIntegration`, `decryptSecrets`, `sanitizeMessage`, `sendEmail`, `sendTwilio`, `signWebhookPayload`, `testIntegration` in `@/lib/integrations/connectors`; `dispatchOutbox`, `nudgeChannel` in `@/lib/integrations/dispatcher`; `createStripePaymentLink`, `verifyStripeSignature` in `@/lib/integrations/stripe`; `renderInvoiceEmail` in `@/lib/integrations/templates`; `buildIcs` in `@/lib/integrations/ics`; `testCaldav`, `bookingToVEvent`, `putBookingEvent`, `deleteRemoteEvent`, `caldavCreds` in `@/lib/integrations/caldav`; `googleAuthUrl`, `parseTokenResponse`, `exchangeCodeForTokens`, `refreshAccessToken`, `queryFreeBusy`, `listEvents`, `upsertBookingEvent`, `deleteBookingEvent`, `buildBookingEvent`, `readBookingId` in `@/lib/integrations/googleCalendar`; `googleState`, `ensureGoogleAccessToken`, `storeGoogleTokens` in `@/lib/integrations/googleAuth`; `normalizeReceptionistStatus` in `@/lib/receptionist/status`; `publicIntegration`, `mergeSecrets`, `googleOAuthConnected` in `@/lib/integrations/kinds` — never return `secretsEnc`
- Telephony: `verifyTwilioSignature`, `candidateWebhookUrls`, `resolveTelephonyRoute`, `formParams`, `matchCustomerByPhone`, `logWebhook`, and the TwiML builders (`twiml`, `say`, `gatherSpeech`, `dialNumber`, `hangup`, `speakable`) in `@/lib/telephony/twiml`
- Demo: `seedDemo()` in `@/lib/demo/seed`
- Org helpers: `parseJson`, `getSetting`, `setSetting`, `updateOrgField` in `@/lib/org`

## Endpoints

### Session / auth (public unless noted)
- `GET /api/session` → `{ needsSetup: boolean }` if no users exist, else `{ authenticated: boolean, user?: {id,name,email,role}, org?: {id,name,slug,demo,setupComplete,dataMode,timezone,currency,businessType}, demoAvailable: boolean }` (demoAvailable = whether a demo org with credentials exists; do NOT leak hashes)
- `POST /api/auth/login` `{email,password,code?}` → sets session cookie (`sessionCookie` helper + `createSession`). Compare with `verifyPassword`. When the account has TOTP enabled, `code` (6-digit current authenticator code) is required — missing → `401 totp_required`, wrong → `401 totp_invalid`. Audit `auth.login` (meta includes `twoFactor`).
- `GET /api/auth/2fa` → `{enabled, enrollmentPending}` (never the secret).
- `POST /api/auth/2fa/setup` `{password}` → starts TOTP enrollment: verifies the password, stores a pending encrypted secret, returns `{secret, otpauthUrl, hint}` (secret returned exactly once). Audit `auth.2fa_setup_started`.
- `POST /api/auth/2fa/enable` `{code}` → confirms enrollment with a live code and turns 2FA on. `409 no_pending_setup`, `422 invalid_code`.
- `POST /api/auth/2fa/disable` `{password, code?}` → requires password + a current code while enabled. Audit `auth.2fa_disabled`.
- `POST /api/auth/logout` (auth) → clear cookie and persistently revoke the session row (`revokedAt`).
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

### Services / staff (auth; all mutations owner/admin)
- `GET /api/services`, `POST /api/services` `{name, description?, category?, durationMin, priceCents, bufferBeforeMin?, bufferAfterMin?, maxPerSlot?, requiresDeposit?, depositCents?}`, `PATCH /api/services/[id]`, `DELETE /api/services/[id]` (refuse if bookings exist → suggest `active:false`).
- `GET /api/staff` → staff + serviceLinks + workingHours. `POST /api/staff` `{name, role?, email?, phone?}`. `PATCH /api/staff/[id]`. `PUT /api/staff/[id]/services` `{serviceIds:[]}`. `PUT /api/staff/[id]/hours` `{hours: [{dow,startMin,endMin}]}` (replace set). Org-wide hours: `PUT /api/staff/hours` (staffId null).
- `GET /api/availability?serviceId=&from=ISO&to=ISO&staffId=` → `{slots:[{startAt,endAt,staffId}]}` via computeSlots.

### Bookings (auth)
- `GET /api/bookings?from&to&status&customerId` → include customer{name}, service{name}, staff{name}; ordered by startAt.
- `POST /api/bookings` `{customerId, serviceId, staffId?, startAt, notes?}` (owner/admin/agent) → calls createBooking. Audit done inside service.
- `PATCH /api/bookings/[id]` `{action:'reschedule'|'cancel'|'confirm'|'complete'|'no_show', startAt?, reason?}` (owner/admin/agent).
- `POST /api/bookings/[id]/remind` (owner/admin/agent) → queue a booking reminder to outbox (honest states).

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
- `POST /api/integrations` (owner/admin) `{kind, label?, config?, secrets?}` → `201 {integration}`. Kinds: `smtp`, `twilio_sms`, `twilio_whatsapp`, `twilio_voice`, `sms_gateway`, `caldav`, `google_calendar`, `stripe`, `webhook_out`. Per-kind config schemas: smtp `{host, port, secure?, from}`; twilio_sms/twilio_whatsapp `{from}`; twilio_voice `{from, language?, voiceName?, transferNumber?, publicBaseUrl?}`; sms_gateway `{provider: textbee|httpsms|android_sms_gateway|generic_http, baseUrl?, from?, deviceId?, url?, method?, authHeaderName?, bodyTemplate?, testRecipient?}`; caldav `{url, username?}`; google_calendar `{calendarId?, redirectUri?}`; stripe `{}`; webhook_out `{url, allowPrivate?}`. Per-kind secrets: smtp `{user?, pass?}`; twilio_* `{accountSid, authToken}`; sms_gateway `{apiKey?, username?, password?, token?, authValue?}`; caldav `{password?}` (optional — local servers may allow anonymous writes); google_calendar `{clientId, clientSecret}` (the OAuth tokens are written by the callback, never typed by the operator); stripe `{secretKey, webhookSecret?}`; webhook_out `{secret?}`. Singleton kinds (incl. `twilio_voice`, `sms_gateway`, `caldav`, `google_calendar`) reject a second row (`409 already_configured`); `webhook_out` allows one per destination URL. Outbound SMS resolves an enabled `twilio_sms` first, otherwise the enabled `sms_gateway`. Errors: `422 bad_kind | validation | insufficient_secrets`. Rows are created `enabled: false`. Audit `integration.created` (meta without secrets).
- `PATCH /api/integrations/[id]` (owner/admin) `{label?, config?, secrets?, enabled?}` — `secrets` as an object = FULL replacement (encrypted; the Google OAuth tokens are preserved across edits); `secrets: null` clears credentials and forces `enabled:false`. Enabling requires sufficient credentials, except `smtp`/`webhook_out` where anonymous/unsigned is legitimate (`400 not_configured | insufficient_secrets`). Enabling nudges queued outbox messages of the matching channel for the next dispatch tick. Audit `integration.updated` (meta: `changed` field names only).
- `DELETE /api/integrations/[id]` (owner/admin) → `{deleted: true}` — removes the row and its encrypted credentials. Audit `integration.deleted`.
- `POST /api/integrations/[id]/test` (owner/admin) → runs the real per-kind test in `testIntegration` (SMTP `verify`, Twilio/Stripe account fetch, SMS-gateway probe, CalDAV PROPFIND, Google Calendar calendar fetch, signed webhook POST), stores `lastTest*`, audits `integration.tested`, and returns `{ok, detail, latencyMs?}`. Secrets never appear in the result.
- `POST /api/integrations/caldav-sync` (owner/admin) `{days?: 1–120 (default 45), verifyFirst?: boolean (default true), direction?: 'push'|'pull'|'both' (default 'both')}` → two-way CalDAV sync. Push: upcoming `pending|confirmed` bookings within the horizon (cap 500) are PUT to the configured collection as `booking-{id}@{orgslug}.ics` (idempotent upsert; RFC 5545 VEVENT with UTC stamps, folding/escaping, `X-AIS-ORG`). Pull (two-way): previously pushed events are read back — remote `STATUS:CANCELLED` cancels the booking, a moved `DTSTART` reschedules it through the validated booking service (out-of-hours / fully-booked changes are reported as `failed`, never applied partially); remotely deleted events are reported as `missing` and deliberately do NOT cancel local bookings. `verifyFirst` runs a PROPFIND health check first and updates `lastTest*`; failure → `502 health_check_failed`. Errors: `403 forbidden` (role), `404 not_found` (no caldav integration), `409 disabled`, `422 bad_config` (missing URL). Success → `{direction, pushed, failed, total, results, pulled:{cancelled,rescheduled,unchanged,missing,failed,total}, pullResults, syncedAt}` — per-item truth, never a fake success. Summary persisted in AppSetting `caldav_sync:<integrationId>`; audit `integrations.caldav_sync`.
- `GET /api/integrations/caldav-sync` → `{configured: false}` or `{configured, enabled, lastSync: {at, direction, pushed, failed, total, pulled}, lastTestOk, lastTestError}` (drives the "Sync now" button + last-sync summary in the CalDAV card).
- `GET /api/integrations/google_calendar/authorize` (owner/admin) → `307` redirect to Google's consent screen (`client_id`, `redirect_uri`, offline access, `prompt=consent`). Requires a saved `google_calendar` integration with client id + secret → `404 not_found` / `422 bad_config`. A one-time `state` nonce is stored server-side (10 min TTL) and bound to the org. Audit `integration.google_oauth_authorize`.
- `GET /api/integrations/google_calendar/callback` — PUBLIC (Google redirects the browser cross-site, so no session cookie is used): verifies and destroys the `state` nonce, exchanges the code for tokens (`code` → access + refresh token), stores them encrypted, enables the integration and redirects to `/?google_calendar=connected#integrations`. Failures redirect with `?google_calendar=error&reason=…`. Audit `integration.google_oauth_connected | integration.google_oauth_failed`.
- `POST /api/integrations/google-calendar/sync` (owner/admin) `{days?: 1–120 (default 45), direction?: 'push'|'pull'|'both'}` → two-way Google Calendar sync. **Pull (busy):** free/busy windows of the configured calendar become `CalendarBlock` rows (external events we pushed ourselves are excluded) — a busy diary therefore removes slots from availability and blocks new bookings. **Pull (events):** events carrying our `aisBookingId` marker are read back — a cancelled remote event cancels the booking, a moved event reschedules it through the validated booking service, and events of locally cancelled bookings are removed remotely. **Push:** upcoming `pending|confirmed` bookings become Google events (idempotent — the booking id is stored as a private extended property). Errors: `403 forbidden`, `404 not_found` (no integration), `409 disabled`, `422 not_connected` (no refresh token) / `bad_config`. Success → `{direction, pushed, failed, total, results, pulled:{cancelled,rescheduled,unchanged,removed,failed,total}, pullResults, blocks:{added,removed,kept}, errors, syncedAt}` — per-item truth. Summary persisted in AppSetting `google_sync:<integrationId>`; audit `integrations.google_calendar_sync`.
- `GET /api/integrations/google-calendar/sync` → `{configured: false}` or `{configured, enabled, lastSync, activeBlocks, lastTestOk, lastTestError}` (drives the "Sync now" button and the connected/not-connected state of the card).

### Outbox / calendar (auth)

- `GET /api/outbox?status=` → `{messages}` (last 200) — `OutboxMessage` rows with honest `status` (`queued|sent|failed|skipped`), `statusReason`, `attempts`, `channel` (`email|sms|whatsapp|webhook|inapp`), `dedupeKey`, `scheduledFor`, `sentAt`.
- `POST /api/outbox/dispatch` (owner/admin) → releases backoff for every enabled channel, runs `dispatchOutbox(orgId)` now → `{ok: true, stats: {processed, sent, failed, waiting}}`. Returns `409 worker_busy` when the dispatcher lease is held. Audit `outbox.dispatched`. (Worker ticks the dispatcher every 30s automatically.)
- `GET /api/calendar/bookings.ics?from=&to=` → subscribable RFC 5545 feed (`text/calendar`; default next 30 days, `pending`+`confirmed` bookings, TENTATIVE/CONFIRMED status, −60 min VALARM). Cookie session auth.
- `GET /api/calendar/bookings/<id>.ics` → single booking as one VEVENT (accepts `<id>.ics` or `booking-<id>.ics`; `404` outside the org). Cookie session auth.
- `GET /api/calendar/blocks?from=&to=` → `{blocks: [{id, title, source, staffId, staffName, startAt, endAt, allDay}], count}` — blocked periods (external busy time + manual blocks). Default window: now → +30 days.
- `POST /api/calendar/blocks` (owner/admin/agent) `{start_at, end_at, title?, staff_id?|staff?}` → `201 {block}`. Times are parsed in the org timezone. `422 validation` when the range is invalid or end ≤ start, `404 not_found` for an unknown staff member. The slot disappears from availability immediately and the booking transaction refuses overlapping bookings (`409 slot_blocked`). Audit `calendar.block_created`.
- `DELETE /api/calendar/blocks/[id]` (owner/admin/agent) → `{deleted: true, id}` — the affected slots become bookable again. Audit `calendar.block_deleted`.

### Receptionist runtime switch (auth)

- `GET /api/settings/receptionist` → `{status: 'running'|'paused'|'stopped', label, detail}`. `running` = the assistant answers inbound SMS/WhatsApp, calls and web chat; `paused` = inbound is recorded for staff but the assistant does not reply (calls get a short notice); `stopped` = the app stops listening (webhooks are acknowledged and audited, nothing is answered or stored).
- `PATCH /api/settings/receptionist` (owner/admin) `{status}` → `{status, changed}` — persists `Organization.receptionistStatus` and audits `settings.receptionist_changed` (meta: from/to). The switch is enforced in the inbound SMS/WhatsApp/voice routes, the speech gather loop, the public web chat, the realtime session mint and the receptionist turn runner. Calls routed to a human agent line and scheduled automations are unaffected.

### Ledger (auth)
- `GET /api/ledger?from&to&limit` → `{entries, balances}`.
- `GET /api/ledger/export` → text/csv attachment.
- `POST /api/ledger/[id]/reverse` `{memo?}` (owner/admin) → reverseEntry.
- `GET /api/customers/[id]/statement` → `{customer, invoices:[{number,total,paid,outstanding,status}], ledgerRows}`.

### Knowledge (auth; mutations owner/admin)
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
- `POST /api/datasources/[id]/sync` (owner/admin) → pulls rows, upserts docs by `(dataSourceId, externalId)`, skips unchanged rows (content hash), deletes docs whose rows disappeared, (re)embeds changed docs, records `lastSync*` + `lastSyncStats` + document/chunk counts. Returns `{ok, result, message}`; `409 sync_busy` when this source is already syncing. Audit `datasource.synced`.
- Auto-sync: the background worker (`src/instrumentation.ts`) runs `runDueDataSourceSyncs()` every 5 min for `enabled && autoSync` sources whose interval is due.

### Conversations / inbox (auth; staff = owner/admin/agent)
- `GET /api/conversations?status=` → with last message preview + customer name.
- `POST /api/conversations` `{contactName?, customerId?, channel?}` (staff) → open conversation.
- `GET /api/conversations/[id]` → conversation + messages asc.
- `POST /api/conversations/[id]/messages` `{content}` (staff) → handleReceptionistTurn → `{assistantReply, toolCalls, aiUsed, error?, skipped?}`. When the conversation has `aiEnabled:false` the message is stored but no AI reply runs (`skipped:'ai_disabled'`). Emit `conversation_escalated` event when status became waiting_human (transition only).
- `PATCH /api/conversations/[id]` `{status?, aiEnabled?}` (staff) — take over/close/resume AI.
- `POST /api/conversations/[id]/agent-reply` `{content}` (staff) → human agent message (role 'agent'); on `sms` conversations it is actually delivered via the enabled SMS integration (`{delivery: {delivered, queued?, reason?}}` — delivered ≠ queued in the outbox ≠ failed); opt-out is honored.
- `POST /api/conversations/[id]/transcript` `{messages:[{role:'user'|'assistant'|'agent'|'tool', content}]}` (staff) → persists externally produced turns (WebRTC realtime voice) into the transcript; `tool` rows are skipped, no AI turn is triggered.

### Public web chat (public, CORS-enabled)
- `POST /api/public/chat/[slug]` `{message (≤2000), token?, name?}` → the org's public web receptionist. First call (no token) creates a `web` conversation + returns a `token`; pass the token back on every message (unknown/expired token → `404`). Reply is generated synchronously and returned: `{token, reply, aiUsed, error?, status, note?}`. When the org/staff paused AI, `{reply:'', aiUsed:false, note}` with the message stored for staff. Per-IP rate limited (30/min). Audit `conversation.created` on first contact.
- `GET /api/public/chat/[slug]` with header `x-chat-token` (or `?token=`) → visitor's own transcript (customer/assistant/agent only): `{business, status, aiEnabled, messages:[{role,content,createdAt}]}`. Unknown token/slug → `404`; missing/blank token → `401`.
- Both responses carry permissive CORS headers (`access-control-allow-origin: *`) so the widget can be embedded anywhere; `OPTIONS` answers preflight.

### Realtime voice (auth; owner/admin)
- `POST /api/ai/realtime/session` → mints a short-lived client secret at the org's `realtime` provider (falls back to the `llm` row): `{provider, model, clientSecret, expiresAt, realtimeUrl, sdpUrl, serverLatencyMs}`. The client opens WebRTC against `sdpUrl` (derived from the base URL, override via provider config `realtimeUrl`) — no hardcoded cloud URL.
- `POST /api/ai/realtime/tool` `{conversationId, tool, args}` (staff) → executes one validated receptionist tool for the live session.

### Voice / speech (auth) — Voice Console

Real STT/TTS routed through the same BYOK provider layer as chat (capabilities `stt`/`tts`; the only server-side speech provider is `openai_compatible` — there is no proprietary AI SDK, and self-hosted OpenAI-compatible servers on this machine/private network are allowed even in `local_only` mode). The `browser` kind runs the device's built-in Web Speech API entirely client-side (mic + speechSynthesis) and needs no server round-trip — the Voice Console uses it automatically whenever no server STT/TTS provider is enabled, so voice works out of the box. Legacy `managed` rows (retired provider kind) are reset to `browser` on `GET /api/providers` and before each call. Every server call writes an `AiLog` row (metrics only, no content). No audio is ever persisted.

- `POST /api/ai/asr` `{b64: string, mime?: string}` (staff) → `{text, provider, model, latencyMs}`. Base64 audio decoded server-side (max ~12 MB raw → `413`; decodes to zero bytes → `400`). `openai_compatible` → `POST {baseUrl}/audio/transcriptions` (multipart, model default `whisper-1`, 60 s timeout). Empty transcript → `502 stt_failed` (sanitized upstream message). Only the transcript is returned. `browser` rows are rejected server-side with `503 speech_provider_unsupported` — the console uses Web Speech instead.
- `POST /api/ai/tts` `{text (≤4000 chars), voice?, speed? (0.5–2.0)}` (staff) → `{audio: [{mime, b64}], provider, model, latencyMs}`. Text is split into sentence-bounded ≤1000-char chunks; one audio chunk per upstream request. `openai_compatible` → `POST {baseUrl}/audio/speech` (model default `tts-1`; voice = request `voice` → `config.voice` → `config.openaiVoice` → `alloy`; MP3). Errors: `400 empty_text`, `503 speech_not_configured | speech_provider_unsupported`, `502 tts_failed`.

### Telephony lines (auth; owner/admin for mutations)
- `GET /api/telephony/lines` (owner/admin/viewer) → `{lines}` ordered by priority.
- `POST /api/telephony/lines` `{label, phoneNumber, destinationKind?, destinationValue?, priority?, enabled?, acceptingCalls?, integrationId?}` → 201 row.
- `PATCH /api/telephony/lines/[id]` partial `{label?, phoneNumber?, destinationKind?, destinationValue?, priority?, enabled?, acceptingCalls?}`; `DELETE /api/telephony/lines/[id]`. Used by PABX `least_busy`/`round_robin`/`redirect` routing.

### Telephony (public — Twilio-signature webhooks)

All `/api/telephony/*` routes are PUBLIC but authenticated with Twilio's real signature scheme: `x-twilio-signature` = base64 HMAC-SHA1 over `fullUrl + sorted("Key" + "Value" concat)` using the integration's `authToken`, compared timing-safely. Behind proxies the URL Twilio signed can differ from what the server sees, so verification tries a **candidate URL list**: integration `config.publicBaseUrl` → `PUBLIC_BASE_URL` env → the forwarded request host; any match is authentic. The org is resolved by the called/texted number (`To` matched against the `from` of enabled `twilio_voice`/`twilio_sms` integrations; single-org deployments accept the sole number; `404` plain text when none owns it). Every webhook is stored in `WebhookEvent` (`signatureValid`, `result: received|processed|duplicate|rejected`); invalid/missing signature → `403` text/plain, nothing processed, and a previously rejected event never blocks a properly signed retry (rejected-retry-safe dedup). Responses are TwiML (`application/xml`, `<Response>…</Response>`).

- `POST /api/telephony/voice/incoming` — a call arrives. Opens/reuses a `phone`-channel Conversation keyed by CallSid (`Conversation.externalRef`), matches the caller by phone digits, records a `TelephonyCall`, audits `telephony.call_started`, and answers with `<Gather input="speech">` + the org's AI-identity greeting. PABX routing for `<Dial>` uses configured lines: `least_busy` (real active calls), CAS round-robin (`lastRrIndex`), or `redirect` (priority target); disabled/paused (`acceptingCalls:false`) lines are excluded. Duplicate CallSid (Twilio retry) → empty TwiML.
- `POST /api/telephony/voice/gather` — one FULL AI receptionist turn per spoken utterance: `SpeechResult` → `handleReceptionistTurn` (same tools as chat: availability, bookings, knowledge, reschedule, invoices, claims, escalate) → reply via `<Say>` + next Gather. Escalation (`waiting_human`): `<Dial>` `config.transferNumber` when set, otherwise a message-taken promise + hangup (conversation closed); `conversation_escalated` fires only on the transition. When staff paused AI for the call's conversation (`aiEnabled:false`) a takeover message is spoken and the call ends — the bot never talks over a human handoff. No input: reprompt twice, then a polite hangup. Low speech confidence (< 0.45) is annotated to the model. Turn errors degrade to an honest apology line — Twilio always receives valid TwiML.
- `POST /api/telephony/voice/status` — call status callback: prefers `DialCallStatus` for `<Dial>` results; normalized statuses (`ringing/queued→started`, `in-progress→answered`, `no-answer/busy/canceled→missed`). Terminal statuses set `endedAt`, do not regress finalized calls, close the conversation unless `waiting_human`, and clear shared no-input state. Signature verification accepts both the plain URL and the `<Dial action>` form `?routed=1`. Always `204` for valid signatures.
- `POST /api/telephony/sms/incoming` — inbound SMS: one `sms`-channel Conversation per sender number (`externalRef: "sms:{digits}"`); the inbound message is recorded instantly (`WebhookEvent` payload + `telephony.sms_received` audit) while Twilio gets an immediate empty TwiML. The answer is generated after the response is flushed (`after()` from `next/server`, so serverless runtimes keep it alive) through the full receptionist turn and sent via the Twilio Messages API (REST): send failure → OutboxMessage `queued` with the honest `statusReason` (dispatcher retries with backoff); no enabled `twilio_sms` integration → outbox `skipped` with a clear reason. `customer.optOut` is honored absolutely — inbound is stored, nothing is ever sent. Duplicate `MessageSid` → deduped; `conversation_escalated` fires only on the transition to `waiting_human`.
- `POST /api/telephony/whatsapp/incoming` — inbound WhatsApp: one `whatsapp`-channel Conversation per sender number (`externalRef: "whatsapp:{digits}"`); same flow as SMS but replies go out through the enabled `twilio_whatsapp` integration; `ProfileName` becomes the contact label. Audit `telephony.whatsapp_received` / `telephony.whatsapp_reply_sent`. Webhook URL is shown in the Integrations card for the `twilio_whatsapp` kind.

### AI providers (auth; owner/admin for mutations)
- `GET /api/providers` → `{capabilities: {llm: PublicProviderConfig, ...}, dataMode, capabilityInfo}` — never secrets. Capabilities: `llm` (`ollama | openai_compatible | none`), `embedding` (`local_neural | ollama | openai_compatible | local_lexical`), `stt` (`browser | openai_compatible`), `tts` (`browser | openai_compatible`), `realtime` (`none | openai_compatible`), `rerank`/`vision` (`none | openai_compatible`, optional/not implemented). GET resets any retired `managed` rows for `stt`/`tts` to `browser` so the voice console works out of the box — there is no built-in/managed model.
- `local_only` data mode blocks `openai_compatible` calls via `assertAiPolicy(orgId, kind, baseUrl)` — but endpoints on this machine/private network (localhost, 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, `::1`, fc00::/7, fe80::/10, `*.local`, `*.internal`, `host.docker.internal`) are treated as local and stay allowed.
- `PUT /api/providers/[capability]` `{provider, label?, baseUrl?, model?, apiKey? (''=clear, undefined=keep), enabled?, config?}`. Audit `settings.provider_updated` (meta without secrets).
- `POST /api/providers/[capability]/test` → runAndStoreTest → `{ok, message, latencyMs}`.
- `GET /api/ai/logs?limit=` → recent AiLog rows (no content, only metrics).
- `PUT /api/settings/data-mode` `{dataMode: 'local_only'|'hybrid'|'cloud_first'}` (owner/admin). Audit `settings.data_mode_changed`.
- `GET /api/settings/channels`, `PUT /api/settings/channels` `{email: boolean, sms: boolean}` → writes AppSetting `channel_email`/`channel_sms` (presence marks the channel "configured" for reminder queueing); actual delivery runs through Integrations (SMTP/Twilio) via the outbox dispatcher — see [INTEGRATIONS.md](./INTEGRATIONS.md).

### Automations (auth)
- `GET /api/automations` → with last 5 runs each. `POST /api/automations` `{name, description?, triggerType, triggerCfg?, conditions?, delayMinutes?, actions, maxRunsPerDay?, quietHours?, testMode?, enabled?}` (owner/admin). Audit.
- `PATCH /api/automations/[id]`, `DELETE /api/automations/[id]` (owner/admin).
- `POST /api/automations/run` (owner/admin) → tick(ctx.org.id) → `{evaluated, executed, failed, skipped}`. Returns `409 worker_busy` when another automation tick holds the lease. (Worker also ticks every 60s.)
- `GET /api/automations/[id]/runs` → history. Outbox listing/dispatch is under "Outbox / calendar" above.

### Sessions (auth)
- `POST /api/auth/sessions/revoke-all` → revoke every other active session for the signed-in user; returns `{revoked}`; audited `auth.sessions_revoked`.

### Usage (auth; owner/admin/viewer)
- `GET /api/usage?days=30` → aggregate `AiLog` metrics: calls/ok/fail, tokens in/out, latency, estimated cost (unknown model pricing flagged `costKnown:false`), per capability/provider/model/daily breakdown, `rates`, `summary` (includes conversation/message counts).

### Audit / health / dashboard
- `GET /api/audit?limit=100` → latest events.
- `GET /api/health` — PUBLIC liveness only: `{ok:true, time}` (no DB access). `GET /api/health/ready` — PUBLIC readiness: real `SELECT 1`; `{ok:true, db:'ok', latencyMs, time}` or `503 {ok:false, db:'unreachable', time}`. `GET /api/health/detail` (auth): `{db, database:{kind,journalMode,busyTimeoutMs}, encryptionKey, webhookSecret, workerHeartbeat, workers:[{name,enabled,running,holder,lastRunAt,leaseExpiresAt,lastError}], providers:{llm:{provider,enabled,lastTestOk}, embedding:{...}}, counts:{customers,bookings,invoices,conversations,outboxQueued}, dataMode}` — real checks only; SQLite tuning is read live.
- `GET /api/dashboard` → `{todayBookings, upcomingBookings(5), outstandingCents, overdue:[{id,number,customer,daysOverdue,outstanding}], openConversations, recentAudit(8), outboxRecent(5), readiness:{okCount,total}}`.
- `POST /api/admin/backup` (owner/admin) → SQLite only: run `VACUUM INTO` to `backups/backup-<ts>.db` (mkdir, return filename+size). On PostgreSQL returns `400 unsupported_database` — use `pg_dump`. Honest errors.
- `GET /api/admin/export` (owner/admin) → JSON export of org data (customers, services, bookings, invoices+items, payments, ledger, knowledge, conversations+messages, automations). No secrets.

## Response shapes
Success: `json(data)` (200) or `json(data, 201)`. Errors: `{error: string, code?: string, ...}`. All timestamps ISO strings.
