# Task 10-a — Integrations frontend (full-stack-developer)

## Files changed
- `src/components/sections/integrations-section.tsx` — NEW (~1,100 lines): BYOK connector cards (smtp / twilio_sms / twilio_whatsapp / stripe), webhook_out destination list card, Outbox / Calendar / Inbound-webhook tabs.
- `src/lib/client/store.ts` — added `'integrations'` to `SectionId`.
- `src/lib/client/api.ts` — added `IntegrationInfo`, `OutboxDispatchStats`, `IntegrationTestResult`; extended `OutboxRow` additively (`html?`, `attempts?`, `relatedId?`).
- `src/components/sections/sidebar.tsx` — NAV item `integrations` (Plug icon, Settings group) between Business Profile and Diagnostics.
- `src/app/page.tsx` — import + `case 'integrations'`.
- `src/components/sections/invoices-section.tsx` — detail dialog: "Send to customer" + "Payment link" buttons (owner/admin), payment-link dialog with Copy/Open, honest queued/paymentLinkError alerts, `copyText` helper.
- `src/components/sections/automations-section.tsx` — 3 new action types (send_email / send_sms / send_webhook): labels, draft fields, cfg mapping, run-summary, webhook destination select populated from GET /api/integrations.

No backend/lib/api-route files touched.

## Verification
- `bun run lint` — clean.
- `npx tsc --noEmit` — zero errors for project code (pre-existing examples/ + skills/ only).
- Browser E2E (agent-browser, demo org): connector card states, Configure prefill, Save & test SMTP (real 200 + honest "Test passed" inline), webhook secret rotate shown-once, Dispatch now stats toast, outbox table rows with status badges/attempt/statusReason, invoice send 422 + payment-link 503 verbatim toasts, void invoice disables actions, automations editor new action fields + destination select listing the real webhook URL. Zero page errors.

## Key decisions
- Secrets: full-replacement semantics made explicit ("saving any credential field replaces the whole stored set"); only non-empty typed fields are sent; omitting `secrets` keeps the stored set; "Clear saved credentials" uses PATCH `secrets: null`.
- Refresh never flips the section back to skeletons (would unmount open dialogs); stale data + inline alert on refresh failure.
- Dialog prefill snapshotted at open time — later refreshes don't reset mid-edit state.

## Contract mismatches (for the coordinator)
1. `/api/webhook-secret` has **no GET** (PUT-only, returns `{secret}` once). UI does GET → on failure falls back to owner/admin Rotate flow; picks up a future GET automatically.
2. Automation engine `send_webhook` ignores `cfg.body` — payload is fixed `{event, automation, input}`. UI saves the optional body field with an honest helper note.
3. Engine `send_webhook` requires `cfg.destinationId` (skips honestly otherwise) — UI offers no "any destination" option.
4. Invoice send 409 carries `outboxId` in error extra; frontend surfaces the message (outbox row visible in Outbox tab anyway).
