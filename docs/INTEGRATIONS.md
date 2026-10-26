# Integrations — AI Secretary

How the app talks to third-party services: email (SMTP or SendGrid/Mailgun/Postmark/Resend/Brevo/Mailjet/SparkPost/Elastic Email), SMS/WhatsApp (Twilio or a self-hosted/carrier SMS gateway), real telephony (Twilio Voice inbound calls + inbound SMS), inbound email (IMAP), Stripe/Square payments, QuickBooks/Xero/MYB accounting, Shopify/WooCommerce/Wix/Mailchimp contact sync, CalDAV calendar sync (push + pull), **Google Calendar** sync (OAuth two-way), and signed outbound webhooks. Speech recognition/synthesis for the
browser **Voice Console** is not an integration row — it rides the AI provider layer (capabilities
`stt`/`tts`, same BYOK + data-mode policy as chat; see [ARCHITECTURE.md](./ARCHITECTURE.md) §9).
Everything here is **BYOK (bring your own key)** — the app ships with zero third-party accounts and
makes no network calls until you configure a channel.

Status summary (details per section below): integrations CRUD, the outbox
dispatcher, Stripe/Square payment links + signature-verified webhooks, email
provider APIs, SMS carrier APIs, QuickBooks/Xero/MYB push, commerce/CRM contact
sync, generic inbound payment webhooks, outbound signed webhooks, the ICS
calendar feed, the real phone/SMS receptionist (Twilio Voice webhooks),
SMS-gateway delivery, and CalDAV push/pull sync and **Google Calendar OAuth
sync** are **implemented and live**. Every kind has a real
connection test exposed at `POST /api/integrations/[id]/test` (results stored in
`lastTest*` and shown on the card); the test never claims message delivery.

## 1. Philosophy

- **Local-first, optional everything.** Bookings, invoices, ledger, AI (local
  models), and the whole setup wizard work with no integrations at all. Every
  integration is additive; nothing degrades when a channel is missing.
- **BYOK.** Credentials belong to your org, are stored **AES-256-GCM
  encrypted** (`Integration.secretsEnc`), and are **never returned** by any
  API — responses carry only a boolean `configured`.
- **Honest delivery states.** Every outbound message is an `OutboxMessage` row
  with `status` (`queued | sent | failed | skipped`), an `attempts` counter,
  and a plain-language `statusReason`. Nothing is reported as sent that did not
  reach a real provider; nothing is silently dropped.
- **The outbox is the single outbound path.** Invoice emails, reminders,
  automation sends and webhook deliveries are all rows in `outbox`, delivered
  by one dispatcher with one retry policy.
- **Audited.** Every integration mutation and every manual dispatch writes an
  `AuditEvent` (`integration.created|updated|deleted`, `outbox.dispatched`,
  `invoice.sent`, `invoice.payment_link_created`, …) — metadata only, never
  secret values.

### Dispatcher mechanics (`src/lib/integrations/dispatcher.ts`)

- Runs **every 30 s** in-process (worker in `src/instrumentation.ts`), batch of
  15 queued messages whose `scheduledFor <= now`, FIFO by creation. A DB
  `WorkerLease` (single-flight, TTL-recovered) guarantees a message is never
  delivered twice concurrently, including across replicas.
- **Channel not configured** → message stays `queued` with reason
  `waiting for <channel> integration (configure in Integrations)` and a
  **10-minute recheck**, so it is picked up the moment you configure the
  channel (without starving the queue).
- **Transient send error** → `attempts++`, retry with **exponential backoff
  (2^attempts minutes, capped at 60)**; after **5 attempts** the message is
  marked `failed` with the last (sanitized) error.
- **Enabling an integration nudges pending messages**: queued messages of the
  matching channel (`smtp→email`, `email_api→email`, `twilio_sms→sms`,
  `twilio_whatsapp→whatsapp`, `webhook_out→webhook`) get `scheduledFor = now`
  and are flushed on the next tick.
- **Manual flush**: `POST /api/outbox/dispatch` (owner/admin) releases the
  backoff for every enabled channel and dispatches immediately — returns
  `{ ok, stats: { processed, sent, failed, waiting } }`; `409 worker_busy` when
  the dispatcher lease is held.
- `inapp` channel messages are marked `sent` immediately (delivery is the UI).

## 2. Kind-by-kind reference

Config = non-secret fields (`configJson`), Secrets = encrypted fields.
`GET /api/integrations` returns config plus `configured`, `enabled`,
`lastTestAt/Ok/Error` — never secrets. Singleton kinds (one row per org):
`smtp`, `email_api`, `twilio_sms`, `twilio_whatsapp`, `twilio_voice`, `sms_gateway`, `caldav`,
`google_calendar`, `microsoft_calendar`, `stripe`, `square`, `quickbooks`, `xero`, `myob`,
`shopify`, `woocommerce`, `wix`, `mailchimp`; `webhook_out` allows one row per destination URL.

### `smtp` — email delivery

| | |
|---|---|
| Config | `host` (required), `port` (positive int), `secure` (bool, implicit TLS on connect), `from` (sender address, required) |
| Secrets | `user?`, `pass?` — **optional**: anonymous relays (e.g. a local MailHog) are legitimate |
| Test routine | nodemailer `transport.verify()` — checks connect + greeting + auth, sends nothing. Reports e.g. `SMTP connection verified (smtp.example.com:587, no implicit TLS, authenticated)`. |
| Delivery | nodemailer `sendMail` with `from/to/subject/text` (+ `html` when the outbox row has one). |
| Failure examples | `SMTP test failed: Invalid login: 535 5.7.8 Authentication credentials were not accepted` · `Connection timeout` after 10 s (test) / 15 s (send). |

An enabled SMTP row with host/port but **no** credentials is considered usable
(anonymous relay). Creating an SMTP row when one exists → `409
already_configured`.

### `twilio_sms` / `twilio_whatsapp` — SMS + WhatsApp

| | |
|---|---|
| Config | `from` (required): sender number, e.g. `+15551234567`; for WhatsApp it **must** be `whatsapp:+1555…` (validated at test time) |
| Secrets | `accountSid`, `authToken` (both required) |
| Test routine | Real authenticated `GET https://api.twilio.com/2010-04-01/Accounts/<sid>.json` (10 s timeout). Success: `Twilio SMS verified — account "My Co" (active), sender +15551234567`. |
| Delivery | `POST …/Messages.json` (form: `To`, `From`, `Body`), Basic auth, 15 s timeout; for `twilio_whatsapp` the destination is normalized to `whatsapp:+…`. Returns the Twilio message `sid` into the audit trail. |
| Failure examples | `Twilio API rejected the credentials (HTTP 401): Authenticate` (bad authToken) · `Twilio error 400: Unable to create record: The 'To' number is not a valid phone number` · `From` number not WhatsApp-enabled → Twilio 400/401 on send. |

### `sms_gateway` — BYO Android modem / HTTP SMS bridge

| | |
|---|---|
| Config | `provider` (required): `textbee`, `httpsms`, `android_sms_gateway`, `telnyx`, `vonage`, `messagebird`, `plivo`, `sinch`, `infobip`, `clicksend`, or `generic_http`; `baseUrl?` (override the provider default); `from?` (required for httpSMS and the carrier APIs); `deviceId?` (TextBee); `servicePlanId?` (Sinch); generic_http: `url` (required), `method` (`POST`/`PUT`), `authHeaderName?`, `bodyTemplate?`, `testRecipient?`, `allowPrivate?` |
| Secrets | Provider-dependent: `apiKey?` (TextBee/httpSMS/Telnyx/MessageBird/Sinch/Infobip/ClickSend), `apiKey`+`apiSecret` (Vonage), `accountId`+`apiSecret` (Plivo auth id/token), `username`+`apiKey` (ClickSend basic auth), `token?` or `username`+`password?` (android-sms-gateway; local mode may need none), `authValue?` (generic custom header). Absent credentials are legitimate; sends/tests fail honestly. |
| Test routine | Read-only probe: TextBee `GET /gateway/devices`, httpSMS `GET /v1/messages?limit=1`, android-sms-gateway `GET /3rdparty/v1/messages?limit=1`, Telnyx `GET /messages?page[size]=1`, Vonage `GET /account/get-balance`, MessageBird `GET /messages?limit=1`, Plivo `GET /Account/{authId}/`, Sinch `GET /xms/v1/{servicePlanId}/batches`, Infobip `GET /sms/1/reports`, ClickSend `GET /account` (10 s). `generic_http` has no standard probe — it **sends a real SMS** to `testRecipient` if set, otherwise returns an explicit "set a testRecipient" failure. |
| Delivery | `sendOrgSms()` prefers an enabled `twilio_sms` row; otherwise the enabled `sms_gateway`. Requests: TextBee `POST /gateway/send-sms`, httpSMS `POST /v1/messages/send`, android-sms-gateway `POST /3rdparty/v1/messages`, Telnyx `POST /messages`, Vonage `POST /sms/json`, MessageBird `POST /messages`, Plivo `POST /Account/{authId}/Message/`, Sinch `POST /xms/v1/{servicePlanId}/batches`, Infobip `POST /sms/2/text/advanced`, ClickSend `POST /sms/send`, generic template with `{{to}}`/`{{message}}`/`{{from}}`. |
| Honesty | HTTP 2xx means **accepted by the gateway**, not delivered to a handset. `statusReason` says "awaiting handset delivery"; delivery receipts require separate gateway webhooks (not implemented). Errors are sanitized/redacted. |
| Inbound | Point the gateway's received-message webhook at `POST /api/telephony/sms/gateway-incoming?org=<org-slug>` with the org webhook secret in `x-webhook-secret`. JSON keys accepted: `from`/`sender`, `to`, `body`/`message`/`text`, `id`. STOP/START/UNSTOP keywords update `Customer.optOut`; the AI reply is sent through whichever SMS sender is enabled. |
| Wiring | Create the row, add credentials, click **Test**, enable it. Pending SMS outbox rows are nudged and retried on the next 30 s tick. |

`generic_http` SSRF note: private/LAN addresses are intentionally allowed here because a
self-hosted bridge is the normal deployment. Point it only at your own bridge; the URL is
admin-supplied and never customer-controlled.

### `email_api` — provider-native email delivery

| | |
|---|---|
| Config | `provider` (`sendgrid`, `mailgun`, `postmark`, `resend`, `brevo`, `mailjet`, `sparkpost`, `elasticemail`), `from`, `fromName?`, `domain?` (Mailgun), `region?` (`us`/`eu`, Mailgun), `messageStream?` (Postmark, default `outbound`) |
| Secrets | `apiKey`; `apiSecret` additionally required for Mailjet |
| Test routine | Read-only provider probe: SendGrid scopes, Mailgun domains, Postmark server, Resend domains, Brevo account, Mailjet API keys, SparkPost account, Elastic Email domains. Never sends an email. |
| Delivery | Raw HTTP to the provider API; the dispatcher prefers `email_api` over SMTP. A 2xx means the provider accepted the message; delivery receipts depend on the provider. |
| Failure handling | Provider errors are sanitized/redacted. The dispatcher does not fall back to SMTP after an API failure, so an invoice is never sent twice. |

### `imap` — inbound email (IMAP mailbox polling + push webhook)

| | |
|---|---|
| Config | `host`, `port`, `secure?`, `username`, `folders?` (comma-separated, default `INBOX`), `pollIntervalMinutes?` (1–60, default 5), `maxMessagesPerPoll?` (1–200, default 50), `allowPrivate?` |
| Secrets | `password`, optional `webhookSecret` (16–200 chars) for the push endpoint |
| Test routine | Connects, logs in, lists the configured folders and reports unseen counts. SSRF-guarded (`assertImapHostAllowed` blocks cloud metadata always; LAN mail servers opt in via `allowPrivate`). |
| Inbound | The instrumentation worker polls every 60 s (per-integration interval honoured); a push endpoint `POST /api/telephony/imap/webhook?integration=<id>` (or `x-ais-integration-id`) accepts JSON with `MessageId`/`subject`/`from`/`text`/`html` and requires `x-webhook-secret` or `x-webhook-signature`. Each message is deduplicated by `Message-ID`, persisted as a customer/conversation/message, handed to the receptionist with `channel: 'email'`, and the reply is queued in the outbox with `dedupeKey email-reply:<orgId>:<messageId>` (threading via `In-Reply-To`/`References`). |
| Delivery | Outbound replies use the org's enabled email sender (SMTP or email_api) via the dispatcher; queued ≠ sent. |

### `stripe` — payment links + payment webhooks

| | |
|---|---|
| Config | none (empty object) |
| Secrets | `secretKey` (required, `sk_live_…`/`sk_test_…`), `webhookSecret?` (whsec_… — required for inbound Stripe webhooks) |
| Test routine | Real `GET https://api.stripe.com/v1/account` with the key (10 s timeout). Success: `Stripe verified — account acct_123 (Business Name), charges_enabled=true`. |
| Failure examples | `Stripe API rejected the key (HTTP 401): Invalid API key provided: sk_live_***[redacted]` — **secret values are redacted from every error message** before storage/display. |

Full payment flow in §4.

### `square` — payment links + payment webhooks

| | |
|---|---|
| Config | `locationId` (required), `environment?` (`production`/`sandbox`), `notificationUrl?` (must match Square exactly) |
| Secrets | `accessToken`, `webhookSignatureKey?` |
| Test routine | Real `GET /v2/locations` with the token (10 s). |
| Delivery | `POST /v2/online-checkout/payment-links` with the invoice number, org slug and invoice metadata on the order; amounts are integer minor units. |
| Webhook | `POST /api/square/webhook` verifies `x-square-hmacsha256-signature` (base64 HMAC-SHA256 over notification URL + raw body), resolves the org, fetches the order, reads invoice metadata and records a verified payment through `processWebhook`. Only `COMPLETED` payments are recorded. |
| Preference | When both Stripe and Square are enabled, invoice payment links use Stripe. |

### `quickbooks` / `xero` / `myob` — accounting push

| | |
|---|---|
| Config | QuickBooks `{realmId}`; Xero `{tenantId, salesAccountCode}`; MYOB `{companyFileId, salesAccountCode}` |
| Secrets | `clientId`, `clientSecret`, `refreshToken` (access tokens are refreshed automatically and stored encrypted) |
| Test routine | QuickBooks company info, Xero organisation, MYOB company file — all read-only. |
| Push | `POST /api/invoices/[id]/push-accounting` matches/creates the customer (external ref is stored on `Customer.externalRef`) and posts the invoice with the invoice number as the provider document number. A prior successful push for the same provider is refused to avoid duplicates. |
| Honesty | Provider failures return `502 accounting_push_failed` with the sanitized provider message; nothing is reported as pushed unless the provider returned an id. |

### `shopify` / `woocommerce` / `wix` / `mailchimp` — commerce/CRM contact sync

| | |
|---|---|
| Config | Shopify `{shopDomain}`; WooCommerce `{storeUrl, allowPrivate?}`; Wix `{siteId}`; Mailchimp `{serverPrefix, listId}` |
| Secrets | Shopify `{accessToken}`; WooCommerce `{consumerKey, consumerSecret}`; Wix/Mailchimp `{apiKey}` |
| Test routine | Pulls one page of contacts (Shopify 250, WooCommerce 100, Wix 100, Mailchimp 500) and reports the real count. |
| Sync | `POST /api/integrations/[id]/sync` upserts org-scoped Customers, matching by provider external ref, email or phone; tags are unioned and existing manual data is preserved. |
| SSRF | WooCommerce store URLs pass the outbound URL guard unless `allowPrivate` is explicitly enabled for a self-hosted LAN store. |

### `webhook_out` — outbound signed webhooks

| | |
|---|---|
| Config | `url` (required, http(s)) — one integration per destination URL; `allowPrivate?` (default false) — explicit owner/admin opt-in for LAN/loopback receivers (SSRF guard otherwise rejects them) |
| Secrets | `secret?` — optional signing secret; omit for unsigned delivery |
| Test routine | Validates the destination through the shared SSRF guard, then really POSTs `{event:"integration.test", sentAt, org}` with the same signing scheme, expecting 2xx within 8 s. |
| Delivery | see §6. |

`webhook_out` may be enabled without a secret (unsigned mode is explicit —
receivers get `x-signature: none` and can distinguish it from a real signature).

### `twilio_voice` — real phone receptionist (inbound voice + inbound SMS)

| | |
|---|---|
| Config | `from` (required — the voice-capable Twilio number, E.164, e.g. `+15551234567`), `language?`, `voiceName?`, `transferNumber?` (escalation target), `publicBaseUrl?`, `routingStrategy?` (`receptionist`, `least_busy`, `round_robin`, `redirect`, `simultaneous`), `agentLines?` (up to 20 `{label, number}`), `ringTimeoutSec?` (5–60), `voicemailEnabled?`, `voicemailGreeting?`, `missedCallFollowUp?`, `missedCallSms?`, `afterHoursAction?` (`receptionist`, `voicemail`, `transfer`), `afterHoursTransferNumber?` |
| Secrets | `accountSid`, `authToken` (both required) |
| Test routine | Same real authenticated Twilio account fetch as `twilio_sms`, reported as `Twilio Phone (voice) verified — account "…" (active), number +1555…`. |
| Behavior | Inbound calls: signature-verified webhook opens a `phone` conversation keyed by CallSid, greets, then runs the FULL AI receptionist turn per spoken utterance (`<Gather input="speech">` — Twilio does the speech recognition and its `<Say>` voices the reply). Escalation → `<Dial> transferNumber`, voicemail, or a message-taken hangup. Outside opening hours the configured action applies (voicemail by default). PABX strategies ring one agent or every available line at once (`simultaneous`); disabled/paused lines are excluded and `ringTimeoutSec` bounds the ring. Missed/voicemail calls persist the recording and transcript, notify staff, and can queue a caller acknowledgement SMS. Inbound SMS threads per sender and answers asynchronously via the enabled SMS sender (§3 outbox honesty applies). |

**Wiring the Twilio console** (Phone Numbers → your number → Voice & Messaging; all three URLs
are shown copyable on the integration card):

1. **A call comes in** → `POST <public-base-url>/api/telephony/voice/incoming`
2. **Call status changes** → `POST <public-base-url>/api/telephony/voice/status`
3. **A message comes in** → `POST <public-base-url>/api/telephony/sms/incoming`

The voicemail `<Record>` action posts to `/api/telephony/voice/voicemail` (signature-verified);
the recording/transcript is stored on the conversation and surfaced to staff. No extra console
configuration is required for it.

The Gather step is wired by the TwiML itself (action `/api/telephony/voice/gather`) — no console
configuration needed.

**Signature validation (incl. behind proxies).** Twilio signs every webhook as
`base64(HMAC-SHA1(authToken, full URL + sorted "KeyValue" param concat))` in the
`X-Twilio-Signature` header; the app verifies timing-safely and answers anything else `403`. A
TLS-terminating proxy changes the absolute URL the app sees, so verification accepts a
candidate list: the integration's `publicBaseUrl` first (what you told Twilio to call), then the
`PUBLIC_BASE_URL` env var, then the forwarded request host. **Set `publicBaseUrl` (or
`PUBLIC_BASE_URL`) to exactly the URL configured in the Twilio console** or signature checks
will fail behind proxies. Every attempt is stored in `WebhookEvent` with `signatureValid` and
`result` (`received | processed | duplicate | rejected`), and a previously rejected event never
blocks a properly signed retry.

### `caldav` — two-way calendar sync (bookings ↔ your calendar)

| | |
|---|---|
| Config | `url` (required — the CalDAV **calendar collection** URL, not the account root, e.g. `https://host/user/calendar/`), `username?` |
| Secrets | `password?` — **optional** (some local servers allow anonymous writes). Use an **app password** wherever the provider requires one (Nextcloud, Fastmail, iCloud). |
| Test routine | Real `PROPFIND` against the collection (15 s timeout); `207`/`200` = alive → `CalDAV collection verified (207, calendar collection) at …`. Honest failures: `401` (check username/app-password), `403` (collection denied), `404` (point at the collection, not the account root), anything else → "is this a CalDAV collection?" |
| Sync | `POST /api/integrations/caldav-sync` (owner/admin; the **Sync now** button) defaults to `direction: both` for upcoming `pending|confirmed` bookings (default next 45 days, `days` 1–120). **Push:** idempotent `PUT` of `booking-{id}@{orgslug}.ics` (RFC 5545 VEVENTs, UTC stamps, folding/escaping, `X-AIS-ORG`), cap 500. **Pull:** reads events back — remote `STATUS:CANCELLED` cancels the booking; a moved `DTSTART` reschedules through the validated booking service (out-of-hours/conflict → per-item `failed`, never partially applied); remotely deleted events are reported `missing` and deliberately do **not** cancel local bookings. A PROPFIND health check runs first (unless `verifyFirst: false`) and updates `lastTest*`. Per-item results and a persisted summary (`caldav_sync:<integrationId>`) drive the card. |

Server examples:

- **Radicale** (self-hosted, zero config): `pip install radicale` then
  `radicale --hosts 0.0.0.0:5232 --storage-filesystem-folder ./radicale-data`. Create the
  collection once (`curl -X MKCALENDAR http://localhost:5232/ais/calendar/`), set url
  `http://localhost:5232/ais/calendar/`; username/password optional.
- **Nextcloud**: url `https://cloud.example.com/remote.php/dav/calendars/<user>/<calendar-id>/`,
  username = your login, password = an **app password** (Settings → Security → Devices &
  sessions).
- **Fastmail**: url `https://caldav.fastmail.com/dav/calendars/user/<user>/<calendar>/`,
  username = your Fastmail address, password = an **app-specific password** (Settings →
  Privacy & Security → Third-party apps).
- **iCloud**: url `https://caldav.icloud.com/<user>/calendars/`, password = an app-specific
  password.

This is **two-way but conservative**: pushes are idempotent per booking UID; pulls apply only
explicit cancellation or a moved start time. A missing remote event is surfaced as `missing`
(a never-pushed or manually-deleted event) and never auto-cancels a booking, so an accidental
calendar wipe cannot destroy the local schedule. Push only covers `pending|confirmed` bookings;
there is no delete-on-cancel push, so a locally cancelled booking's remote event is left for the
operator to remove (and is reported `missing` only after that).

### `google_calendar` — two-way sync with Google Calendar (OAuth)

| | |
|---|---|
| Config | `calendarId?` (default `primary`; a shared calendar address also works), `redirectUri?` (defaults to this app's `/api/integrations/google_calendar/callback`) |
| Secrets | `clientId` + `clientSecret` (from the Google Cloud console). The **access/refresh tokens are written by the OAuth callback**, encrypted at rest, and never returned by any API. |
| Connect | Save the client id/secret, then **Connect Google Calendar** → `GET /api/integrations/google_calendar/authorize` redirects to Google's consent screen. A one-time server-side `state` nonce (10 min TTL, bound to the org) is verified and destroyed on the callback; the code is exchanged for tokens, the row is enabled, and the browser returns to the Integrations section. |
| Test routine | Real calendar fetch with the stored (or freshly refreshed) access token → `Google Calendar verified — calendar "…" (access: owner)`. Honest failures: `401`/`403` (re-authorize), `404` (wrong calendar id), `422 not_connected` (consent not completed yet). |
| Sync | `POST /api/integrations/google-calendar/sync` (owner/admin; the **Sync now** button) → **busy pull:** free/busy windows become `CalendarBlock` rows, so busy diary time is never offered as a slot and the booking transaction refuses it (`409 slot_blocked`); **event pull:** events carrying our `aisBookingId` marker are read back — remote cancellation cancels the booking, a moved event reschedules through the validated booking service, events of locally cancelled bookings are removed remotely; **push:** upcoming `pending|confirmed` bookings become Google events (idempotent — the booking id is stored as a private extended property, so re-pushing updates instead of duplicating). |

Both CalDAV and Google Calendar feed the **same** availability engine, so the booking promise
always matches the real diary. Manual blocks can be managed through
`GET/POST/DELETE /api/calendar/blocks` and through the assistant's `block_time` tool.

**Microsoft 365 / Graph** is implemented as a two-way sync (see below). CalDAV and the ICS feed remain the alternatives for tenants without an Entra ID app.

### `microsoft_calendar` — two-way sync with Microsoft 365 (Graph OAuth)

Outlook users who do not want CalDAV can connect Microsoft 365 directly. The flow mirrors the
Google Calendar integration: an Entra ID application (client id + secret) is saved in Integrations,
`GET /api/integrations/microsoft_calendar/authorize` redirects to
`login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize` with the scopes
`offline_access User.Read Calendars.ReadWrite`, and the callback exchanges the code for an access
+ refresh token. The refresh token is stored encrypted and never returned; a one-time `state`
nonce is bound to the org.

`POST /api/integrations/microsoft-calendar/sync` (owner/admin, "Sync now") does three things:

- **Pull (busy):** the free/busy schedule of the configured mailbox becomes `CalendarBlock` rows
  (source `microsoft_calendar`) — busy diary time is subtracted from availability and rejected by
  the booking transaction. Events we pushed ourselves are excluded.
- **Pull (events):** Graph events whose body carries the `ais-booking-id: <bookingId>` marker are
  read back — a cancelled remote event cancels the booking, a moved event reschedles it through
  the validated booking service, and events of locally cancelled bookings are removed remotely.
- **Push:** upcoming `pending|confirmed` bookings become Graph events (idempotent through the
  marker, so a re-push updates the existing event instead of duplicating it).

Every item carries a real result (`pushed`, `failed`, `pulled.cancelled|rescheduled|removed`,
`blocks.added|removed`) — a partial failure is reported as such, never as a fake success. The
last sync summary is stored in `AppSetting microsoft_sync:<integrationId>` and shown in the card.

Setup notes:

- Register an app in the Entra ID admin center, add the **web** redirect URI
  `<your-base-url>/api/integrations/microsoft_calendar/callback` and grant the calendar scopes.
- `tenant` defaults to `common` (works for most Microsoft 365 tenants); a directory (tenant) ID
  locks the app to one tenant.
- `calendarEmail` is the mailbox used for the free/busy query; when empty, the connected account's
  own mailbox is used.

## 3. The outbox

`OutboxMessage` fields: `channel` (`email|sms|whatsapp|webhook|inapp`),
`recipient` (address or destination URL), `subject`, `body` (text/JSON),
`html` (optional rich email body), `status`, `statusReason`, `attempts`,
`relatedType`/`relatedId` (invoice/booking/automation), `dedupeKey` (unique —
daily dedupe), `scheduledFor`, `sentAt`.

- Inspect: `GET /api/outbox?status=` (last 200, newest first).
- Flush: `POST /api/outbox/dispatch` (owner/admin).
- The outbox is the honesty surface: a message that could not be delivered says
  exactly why (`statusReason`), and the UI/diagnostics show attempts.

## 4. Stripe / Square payment flow

1. **Create a real Payment Link** — `POST /api/invoices/[id]/payment-link`
   (owner/admin). Requires an *enabled* payment integration (`503
   payment_not_enabled` otherwise); Stripe is preferred, then Square. Refuses
   void (`409`) or fully paid (`409 already_paid`) invoices. For Stripe it calls
   the live Payment Links API:
   `unit_amount` = outstanding minor units, `currency` = invoice currency
   (lowercased), product name `Invoice <number> — <org name>`, and **metadata
   `org_slug`, `invoice_id`, `invoice_number`** (how callbacks find their
   invoice). Success → `{ url, id, provider }`. Provider-side failure → honest
   `502 payment_link_error` with the sanitized message. For Square the same
   metadata is attached to the order (`org_slug`, `invoice_id`,
   `invoice_number`) and the webhook reads it back after fetching the order.
2. **Attach to the invoice email** — `POST /api/invoices/[id]/send` renders the
   invoice email (see §7) and, when Stripe is enabled, tries to attach a
   payment link. A Stripe failure is reported back as `paymentLinkError` — the
   email still goes out without the button; nothing is faked.
3. **Receive the callback** — `POST /api/stripe/webhook` (public):
   - Verifies `Stripe-Signature: t=…,v1=…` — HMAC-SHA256 over
     `"<t>.<rawBody>"` with the integration's `webhookSecret`, timing-safe
     comparison. Invalid/missing → `400 invalid_signature`; nothing is
     processed unsigned.
   - Org resolution: `data.object.metadata.org_slug` first (our payment links
     always carry it); otherwise every org's stripe integration is tried and
     the one whose `webhookSecret` verifies wins.
   - **Idempotency**: `WebhookEvent.eventId` is unique — a repeated Stripe
     `event.id` answers `{received:true, result:"duplicate"}` and never
     double-counts.
   - Handled events: `checkout.session.completed` (`amount_total`) and
     `payment_intent.succeeded` (`amount_received`). Other event types are
     stored and answered `{received:true, result:"ignored"}`.
   - The event is mapped to a **verified** payment through the same idempotent
     path as every other webhook (`recordVerifiedPayment`): overpay protection
     (`409`-grade rejection), ledger entry, invoice recalculation. Amounts
     arrive in minor units and are recorded as-is; `method: "card"`,
     `reference` = Stripe object id.
   - Honest rejections (HTTP 200 with `result:"error"` so Stripe does not
     retry-storm): no invoice reference in metadata; no positive amount;
     **currency mismatch** (event currency ≠ invoice currency, case-insensitive).
4. **Local Stripe testing** — forward Stripe's webhooks to the app:

   ```bash
   stripe listen --forward-to localhost:3000/api/stripe/webhook
   # copy the printed whsec_… into the stripe integration's webhookSecret, then
   stripe trigger checkout.session.completed
   ```

## 5. Inbound generic payment webhooks

`POST /api/payments/webhook` (public) — the provider-agnostic endpoint that
predates the Stripe integration; any PSP (or your bank export pipeline) can use
it.

**Contract**

```json
{
  "org_slug": "my-business",          // or "orgSlug"
  "event_id": "evt-2026-10-14-001",   // unique per event (idempotency)
  "invoice_number": "INV-2026-0003",
  "amount_cents": 12960,               // positive integer minor units
  "method": "online",                  // optional
  "reference": "tx-8812"               // optional
}
```

- **Auth**: `x-signature` header = hex **HMAC-SHA256 of the exact raw request
  body** with the org's webhook secret (`PUT /api/webhook-secret` rotates it
  and shows it exactly once). Nothing is processed without a valid signature —
  invalid signatures yield `result:"rejected"`.
- **Responses**: `202` with `{result: "processed" | "duplicate" | "rejected" | "error", …}`
  for all business outcomes (validation outcomes never 500 — providers must not
  retry-storm); `401` only when the body is not JSON, `400` when `org_slug` is
  missing, `404` for an unknown org, and `404 invoice_not_found` / `409
  overpay` when the payload itself is unusable (overpay = amount exceeds the
  outstanding balance).
- Duplicate `event_id` → `result:"duplicate"` (deduped via `WebhookEvent`).
- A labeled test harness exists for this contract: `POST
  /api/payments/simulate-webhook` (owner/admin) constructs a *real signed*
  event and runs the same processing path.

## 6. Outbound webhooks (Zapier / Make / anything)

**Delivery**: each `webhook_out` integration is one destination. The dispatcher
POSTs the raw body as `application/json` with:

- `x-signature`: hex **HMAC-SHA256 of the raw request body** using the
  integration's `secret` — or the literal `none` when no secret is configured,
  so receivers can distinguish signed from unsigned.
- `x-ais-event`: the event name (from the message `subject`).

Automation action **`send_webhook`** (cfg: `destinationId` = the `webhook_out`
integration id) queues a message whose payload is:

```json
{ "event": "automation.<triggerType>", "automation": "<automation name>", "input": { …run input… } }
```

with `x-ais-event: automation.<triggerType>`.

**Zapier/Make notes (honest):** point a Zapier "Catch Hook" or Make "Custom
webhook" at the destination URL — they accept the POST out of the box but do
**not** verify `x-signature` by default. For destinations that can verify
(e.g. a small server, Make with a code module), check
`hex_hmac_sha256(raw_body, secret) == x-signature`; unsigned destinations get
`x-signature: none`. Configure an optional secret per destination in the
integration's credentials.

## 7. Email / SMS content

- **Invoice email** (`POST /api/invoices/[id]/send`): text + HTML templates
  (`src/lib/integrations/templates.ts`) — line-item table, subtotal/tax/total,
  paid + balance-due rows, due date, org contact footer, and an optional
  Stripe **"Pay now"** button linking the payment link. Subject:
  `Invoice <number> from <org> — <total>`. Refuses when the customer has no
  email (`422`), opted out / no contact consent (`409`), and is **deduped per
  invoice per calendar day** (same-day resend → `409 already_queued` with the
  existing `outboxId`).
- **Reminders via automations**: the `send_invoice_reminder` action
  (channels `email|sms|inapp`) renders a template with variables
  `{{customer_name}}`, `{{invoice_number}}`, `{{amount_due}}`, `{{due_date}}`,
  `{{business_name}}`, `{{payment_link}}` (a real Stripe link when enabled, a
  plain-language placeholder otherwise — never a fake URL). Dedupe key
  `inv_reminder:<invoiceId>:<day>:<stage>` — one reminder per invoice per stage
  per day.
- **Direct-send automation actions** (`send_email`, `send_sms`,
  `send_webhook`) render templates with variables
  `{{customer_name}}`, `{{business_name}}`, `{{invoice_number}}`,
  `{{amount_due}}`, `{{due_date}}`, `{{service_name}}`, `{{start_time}}` —
  e.g. booking confirmations via a `booking_created` automation with a
  `send_email` action. The booking-confirmation HTML template (with the .ics
  attachment) is wired through `renderBookingEmail` in the automation engine.
- **Consent & quiet hours**: opt-out is checked at queue time *and* at run
  time (opted-out customers produce explicit `skipped: opt_out` outcomes, not
  silent drops). Quiet hours (`HH:MM`–`HH:MM`, evaluated against the server's
  local clock) skip message-sending automation runs; automations also enforce
  a per-day execution cap.
- **Calendar (.ics)**: `GET /api/calendar/bookings.ics?from=&to=` is a
  subscribable RFC 5545 feed (defaults: next 30 days, `pending`+`confirmed`
  bookings, statuses TENTATIVE/CONFIRMED, a −60 min VALARM per event, proper
  CRLF folding/escaping). `GET /api/calendar/bookings/<id>.ics` serves one
  booking (accepts `<id>.ics` or `booking-<id>.ics`; 404 outside your org).
  Both are session-cookie authenticated and served as `text/calendar`. For
  push sync into an external calendar (CalDAV — Radicale/Nextcloud/Fastmail),
  see the `caldav` kind in §2.

## 8. Local testing recipe (bring your own capture target)

Nothing extra needs to be installed - point the integrations at any throwaway
listener you already have.

**Inbound payment webhook signing check (no service at all)**

Capture what Twilio/your PSP sends, so you can compare signatures offline, then
re-verify the HMAC in code with the stored secret before enabling it:

```bash
nc -l 3030 > webhook.raw
```

**Email delivery to a local SMTP sink**

Any local SMTP listener works. Two standard options:

- Python stdlib debugging server (prints the whole message to stdout):
  ```bash
  python -m smtpd -n -c DebuggingServer localhost:2525
  ```
- MailHog / Mailpit (Docker, web UI at :8025):
  ```bash
  docker run --rm -p 1025:1025 -p 8025:8025 mailhog/mailhog
  ```

Then create an `smtp` integration with host `localhost`, port `1025` (or `2525`
for the Python sink), from `test@example.com`, no credentials, enable it, then
`POST /api/invoices/<id>/send` (or trigger an automation) and read the delivered
message from the sink's output/UI.

**Outbound webhook verification**

Point a `webhook_out` integration at any URL you control (an `nc -l` listener, a
[webhook.site](https://webhook.site) bin, or your own endpoint). Every request
carries `x-signature` = hex HMAC-SHA256 over the raw body using the destination's
signing secret (or the literal `none` when no secret is set), so you can verify
the HMAC yourself:

```bash
python3 -c "import hashlib,hmac;body=open('delivered-body.json','rb').read();print(hmac.new(b'your-signing-secret',body,hashlib.sha256).hexdigest())"
```

These are development tools only - never point production webhooks or mail at an
unauthenticated listener.
## 9. Security notes

- **Secrets are AES-256-GCM encrypted at rest** (key = SHA-256 of `APP_SECRET`
  or a generated `.data/secret.key` file) and are **never returned** by any
  endpoint, log line, or audit event — API responses show only
  `configured: true/false`.
- **Error sanitization**: provider error messages pass through a sanitizer that
  replaces any stored secret value (≥ 6 chars) with `[redacted]`, collapses
  whitespace, and truncates to 300 chars before the message is stored in
  `statusReason` / `lastTestError` / audit metadata.
- **Audit events** cover every integration mutation (`integration.created`,
  `integration.updated`, `integration.deleted` — metadata lists *changed
  fields*, never values), every manual dispatch, and webhook rejections.
- **Role gating**: reading integrations/outbox is allowed for any signed-in
  role; creating, editing, deleting, enabling and dispatching require
  **owner/admin**.
- Inbound webhooks are signature-gated (HMAC, timing-safe compare) and
  idempotent by event id; outbound webhooks sign what they send. Enabling an
  integration with insufficient credentials is refused (`not_configured`).
- **Twilio webhooks** (`twilio_voice`, inbound SMS) carry Twilio's own
  `X-Twilio-Signature` (HMAC-SHA1, timing-safe) — see §2 for the candidate-URL
  scheme and proxy notes. Phone/SMS audio never reaches the server: only Twilio's
  text transcription and the reply text are stored.

## Notes for 3rd Party Providers

### Third-Party Documentation References

**Twilio**
- Voice/SMS API docs: https://www.twilio.com/docs/voice
- Video/webinars: https://www.twilio.com/video
- Pricing: https://www.twilio.com/pricing
- Account management: https://www.twilio.com/console

**SendGrid**
- API docs: https://sendgrid.com/docs/api-reference
- SMTP docs: https://sendgrid.com/docs/smtp-api
- Marketing API: https://sendgrid.com/docs/for-developers/sending-email/api-v3
- Developer guide: https://sendgrid.com/docs/for-developers

**Mailgun**
- API docs: https://www.mailgun.com/docs/api
- SMTP docs: https://www.mailgun.com/docs/smtp
- Webhook docs: https://www.mailgun.com/docs/technical-webhooks
- Getting started: https://www.mailgun.com/getting-started

**Postmark**
- API docs: https://postmarkapp.com/developer/api
- SMTP docs: https://postmarkapp.com/developer/smtp-api
- Outbound email: https://postmarkapp.com/developer/outbound-email
- API documentation: https://postmarkapp.com/developer/api/api-overview

**Resend**
- API docs: https://resend.com/docs
- Email send API: https://resend.com/docs/api-reference/emails
- Email create API: https://resend.com/docs/api-reference/emails/create
- Getting started: https://resend.com/docs/getting-started

**Brevo (formerly Sendinblue)**
- API docs: https://developers.brevo.com/docs
- Email API: https://developers.brevo.com/docs/v2/reference/emails/post-send
- Transactional emails: https://developers.brevo.com/docs/v2/transactional-emails
- SMS API: https://developers.brevo.com/docs/v2/sms

**Mailjet**
- API docs: https://docs.mailjet.com
- Transactional emails: https://docs.mailjet.com/docs/transactional
- SMS API: https://docs.mailjet.com/docs/sms
- Getting started: https://docs.mailjet.com/getting-started.html

**SparkPost**
- API docs: https://developers.sparkpost.com/api/v1
- Sending: https://developers.sparkpost.com/api/v1/sending.html
- Transmission API: https://developers.sparkpost.com/api/v1/transmissions.html
- Guides: https://developers.sparkpost.com/guides.html

**Elastic Email**
- API docs: https://www.elasticemail.com/docs
- Email API: https://www.elasticemail.com/docs/api/REST/send
- Contacts API: https://www.elasticemail.com/docs/api/REST/contacts
- Getting started: https://www.elasticemail.com/getting-started

**TextBee**
- API docs: https://www.textbee.io/api-docs
- Getting started: https://www.textbee.io/getting-started

**httpSMS**
- API docs: https://docs.httpsms.io
- Getting started: https://docs.httpsms.io/getting-started

**Android SMS Gateway**
- GitHub: https://github.com/android-sms-gateway
- Documentation: https://github.com/android-sms-gateway/android-sms-gateway/wiki

**Telnyx**
- API docs: https://developers.telnyx.com
- SMS API: https://developers.telnyx.com/reference/sms
- Voice API: https://developers.telnyx.com/reference/voice
- Getting started: https://developers.telnyx.com/guides/getting-started

**Vonage (Nexmo)**
- API docs: https://developers.vonage.com
- SMS API: https://developers.vonage.com/messaging-api/messages
- Voice API: https://developers.vonage.com/voice-api/api-documentation
- Getting started: https://developers.vonage.com/messaging-api/get-started

**MessageBird**
- API docs: https://developers.messagebird.com
- SMS API: https://developers.messagebird.com/sms-api/messages
- Voice API: https://developers.messagebird.com/voice-api
- Getting started: https://developers.messagebird.com/getting-started

**Plivo**
- API docs: https://developers.plivo.com
- SMS API: https://developers.plivo.com/api-reference/sms/
- Voice API: https://developers.plivo.com/api-reference/voice/
- Getting started: https://developers.plivo.com/getting-started

**Sinch**
- API docs: https://developer.sinch.com
- SMS API: https://developer.sinch.com/en/api/sms
- Voice API: https://developer.sinch.com/en/api/voice
- Getting started: https://developer.sinch.com/getting-started

**Infobip**
- API docs: https://www.infobip.com/docs
- SMS API: https://www.infobip.com/docs/api/sms
- Voice API: https://www.infobip.com/docs/api/voice
- Getting started: https://www.infobip.com/getting-started

**ClickSend**
- API docs: https://www.clicksend.com/docs
- SMS API: https://www.clicksend.com/docs/sms-api/send-sms
- Getting started: https://www.clicksend.com/getting-started

**Google Calendar API**
- Official docs: https://developers.google.com/calendar/api/v3/reference
- Quickstart: https://developers.google.com/calendar/quickstart
- OAuth 2.0: https://developers.google.com/identity/protocols/oauth2

**Microsoft Graph API**
- Docs: https://learn.microsoft.com/en-us/graph/api/overview
- Calendar API: https://learn.microsoft.com/en-us/graph/api/resources/calendar
- Getting started: https://learn.microsoft.com/en-us/graph/get-started

**Google OAuth**
- Authorization: https://developers.google.com/identity/protocols/oauth2
- Consent screen: https://console.cloud.google.com/apis/credentials

**Microsoft OAuth**
- Docs: https://learn.microsoft.com/en-us/azure/active-directory/develop/
- Registration: https://learn.microsoft.com/en-us/azure/active-directory/develop/quickstart-register-app

**Stripe**
- API docs: https://stripe.com/docs/api
- Payment Links: https://stripe.com/docs/payment-links
- Webhooks: https://stripe.com/docs/webhooks
- Getting started: https://stripe.com/docs/quickstart

**Square**
- API docs: https://developer.squareup.com/docs/api
- Payments API: https://developer.squareup.com/docs/api/order-payment
- Webhooks: https://developer.squareup.com/docs/webhooks
- Getting started: https://developer.squareup.com/docs/get-started

**QuickBooks Online**
- API docs: https://developer.intuit.com/v2/api/documentation/quickbooks-2021.2.0
- OAuth 2.0: https://developer.intuit.com/v2/api/oauth
- Get started: https://developer.intuit.com/v2/api/getting-started

**Xero**
- API docs: https://developer.xero.com/documentation/api/v2
- OAuth 2.0: https://developer.xero.com/documentation/oauth-2/
- Getting started: https://developer.xero.com/documentation/getting-started/

**MYOB (Australian Financial Services)**
- API docs: https://api.myob.com/developer
- OAuth 2.0: https://api.myob.com/developer/oauth/authorize
- Getting started: https://api.myob.com/developer/getting-started

**Shopify**
- REST API: https://shopify.dev/api/admin-rest
- GraphQL: https://shopify.dev/api/admin-graphql
- OAuth: https://shopify.dev/apps/auth
- Getting started: https://shopify.dev/apps/quickstart

**WooCommerce**
- REST API: https://woocommerce.com/docs/woocommerce-rest-api
- OAuth: https://docs.woocommerce.com/documentation/plugins/rest-api/oauth/
- Getting started: https://docs.woocommerce.com/documentation/plugins/rest-api/getting-started

**Wix Stores**
- REST API: https://dev.wix.com/docs/rest/api
- Getting started: https://dev.wix.com/docs/start/quickstart

**Mailchimp**
- API docs: https://mailchimp.com/developer
- Campaigns: https://mailchimp.com/developer/marketing-api/campaigns
- Lists: https://mailchimp.com/developer/marketing-api/lists
- Getting started: https://mailchimp.com/developer/get-started

**CalDAV**
- RFC 4791: https://datatracker.ietf.org/doc/html/rfc4791
- Calendar Server: https://calendarserver.org/specs/rfc6352/
- Clients: https://webcal.io/docs/calendars/

**Stripe**
- Documentation: https://stripe.com/docs/webhooks
- Signing: https://stripe.com/docs/webhooks/signing-requests
- Testing: https://stripe.com/docs/webhooks/testing

**Square**
- Documentation: https://developer.squareup.com/docs/webhooks
- Signing: https://developer.squareup.com/docs/webhooks/secure-verification
- Testing: https://developer.squareup.com/docs/webhooks/testing

**Twilio**
- Documentation: https://www.twilio.com/docs/webhooks/webhook-events
- Signing: https://www.twilio.com/docs/webhooks/security
- Testing: https://www.twilio.com/docs/webhooks/testing

**Generic HTTP / SSRF**
- Security notes are detailed in `docs/INTEGRATIONS.md` §9, with guidance on: private network risk, certificate validation bypass, timeout and size limits, request/response redaction, and recursion prevention.

### Pricing and Account Setup

All integrations are **BYOK** — you will need accounts wi
