# Integrations — AI Secretary

How the app talks to third-party services: email (SMTP), SMS/WhatsApp (Twilio),
Stripe payments, and signed outbound webhooks. Everything here is **BYOK
(bring your own key)** — the app ships with zero third-party accounts and makes
no network calls until you configure a channel.

Status summary (details per section below): integrations CRUD, the outbox
dispatcher, Stripe payment links + signature-verified webhooks, generic inbound
payment webhooks, outbound signed webhooks, and the ICS calendar feed are
**implemented and live** (see the capability ledger in
[IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)). The per-kind connection
*test routines* are implemented in the connector layer but are **not yet
exposed as an HTTP endpoint** — enabling an integration and dispatching a real
message is the current verification path.

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
  15 queued messages whose `scheduledFor <= now`, FIFO by creation. A lock
  guarantees a message is never delivered twice concurrently.
- **Channel not configured** → message stays `queued` with reason
  `waiting for <channel> integration (configure in Integrations)` and a
  **10-minute recheck**, so it is picked up the moment you configure the
  channel (without starving the queue).
- **Transient send error** → `attempts++`, retry with **exponential backoff
  (2^attempts minutes, capped at 60)**; after **5 attempts** the message is
  marked `failed` with the last (sanitized) error.
- **Enabling an integration nudges pending messages**: queued messages of the
  matching channel (`smtp→email`, `twilio_sms→sms`, `twilio_whatsapp→whatsapp`,
  `webhook_out→webhook`) get `scheduledFor = now` and are flushed on the next
  tick.
- **Manual flush**: `POST /api/outbox/dispatch` (owner/admin) releases the
  backoff for every enabled channel and dispatches immediately — returns
  `{ ok, stats: { processed, sent, failed, waiting } }`.
- `inapp` channel messages are marked `sent` immediately (delivery is the UI).

## 2. Kind-by-kind reference

Config = non-secret fields (`configJson`), Secrets = encrypted fields.
`GET /api/integrations` returns config plus `configured`, `enabled`,
`lastTestAt/Ok/Error` — never secrets. Singleton kinds (one row per org):
`smtp`, `twilio_sms`, `twilio_whatsapp`, `stripe`; `webhook_out` allows one row
per destination URL.

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

### `stripe` — payment links + payment webhooks

| | |
|---|---|
| Config | none (empty object) |
| Secrets | `secretKey` (required, `sk_live_…`/`sk_test_…`), `webhookSecret?` (whsec_… — required for inbound Stripe webhooks) |
| Test routine | Real `GET https://api.stripe.com/v1/account` with the key (10 s timeout). Success: `Stripe verified — account acct_123 (Business Name), charges_enabled=true`. |
| Failure examples | `Stripe API rejected the key (HTTP 401): Invalid API key provided: sk_live_***[redacted]` — **secret values are redacted from every error message** before storage/display. |

Full payment flow in §4.

### `webhook_out` — outbound signed webhooks

| | |
|---|---|
| Config | `url` (required, http(s)) — one integration per destination URL |
| Secrets | `secret?` — optional signing secret; omit for unsigned delivery |
| Test routine | Really POSTs `{event:"integration.test", sentAt, org}` to the URL with the same signing scheme, expects a 2xx within 8 s. |
| Delivery | see §6. |

`webhook_out` may be enabled without a secret (unsigned mode is explicit —
receivers get `x-signature: none` and can distinguish it from a real signature).

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

## 4. Stripe payment flow

1. **Create a real Payment Link** — `POST /api/invoices/[id]/payment-link`
   (owner/admin). Requires an *enabled* stripe integration (`503
   stripe_not_enabled` otherwise); refuses void (`409`) or fully paid (`409
   already_paid`) invoices. Calls the live Stripe Payment Links API:
   `unit_amount` = outstanding minor units, `currency` = invoice currency
   (lowercased), product name `Invoice <number> — <org name>`, and **metadata
   `org_slug`, `invoice_id`, `invoice_number`** (how callbacks find their
   invoice). Success → `{ url, id }`. Stripe-side failure → honest `502
   stripe_error` with the sanitized Stripe message.
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
  `send_email` action. (A rich booking-confirmation HTML template with the
  .ics path exists in the template library but is not wired to an endpoint yet
  — honest gap.)
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
  Both are session-cookie authenticated and served as `text/calendar`.

## 8. Local testing recipe (zero external services)

The repo ships two throwaway mini-services for end-to-end integration tests:

```bash
bun mini-services/smtp-sink/index.ts     # SMTP :2525 · HTTP :2526 (in-memory, cap 200)
bun mini-services/webhook-echo/index.ts  # HTTP :3030 (in-memory, cap 200)
```

1. **Email**: create an `smtp` integration with host `localhost`, port `2525`,
   from `test@example.com`, no credentials → enable it →
   `POST /api/invoices/<id>/send` (or trigger an automation) → inspect the
   delivered message at `http://localhost:2526/messages` (includes extracted
   Subject; `POST /clear` resets).
2. **Webhooks**: create a `webhook_out` integration with url
   `http://localhost:3030/hook` (optionally a signing secret) → deliveries are
   recorded at `GET http://localhost:3030/deliveries` with the raw body and the
   `x-signature` header, so you can verify the HMAC with a one-liner.

Both services are development tools only — in-memory, unauthenticated, never
run them in production.

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
