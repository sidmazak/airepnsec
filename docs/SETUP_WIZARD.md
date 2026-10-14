# Setup Wizard — AI Secretary

The wizard takes a new operator from empty database to an activated assistant **without a single
external integration**: no AI keys, no SMS/email accounts, no calendars. External providers are
optional enhancements configured in step 5 (AI) and later in settings.

Wizard state is org-scoped (`Setting key = wizard.progress`) and written on every step completion
(**autosave**). Reloading, closing the tab, or a server restart resumes exactly where the operator
left off; a completion banner shows percent done. Activation (step 8) is the only step that flips
the org from "setup" to "live", and it is explicit.

## Step 1 — Business profile

- Choose one of: Apartment rentals · Car rentals · Salon · Clinic · Contractor.
- Set organization name, timezone (IANA), currency (ISO 4217).
- The profile seeds vocabulary (e.g. "listing"/"vehicle" vs "service"), default service catalog,
  CSV templates, and starter FAQ examples.
- **Plain language:** "This teaches the system what kind of business you run. You can rename
  everything later."
- Validation: profile required; timezone must parse; currency must be 3 letters.

## Step 2 — Services, staff, hours

- Services: name, duration, buffer, price (entered in major units, stored as cents — shown to the
  operator as currency, never as raw cents), day-based toggle for rentals profiles.
- Staff: names, contact; per-service assignment (skills) — for salons/clinics; optional for
  rentals.
- Resources (units/vehicles/rooms) for capacity profiles.
- Business hours: per-weekday open/close or closed, in org timezone.
- Pre-filled from the profile template; operator edits or deletes rows.
- Validation: end after start; price ≥ 0; at least one service before step 8 readiness.

## Step 3 — CSV imports

- Import customers and services from CSV. **Downloadable templates** link next to each importer
  (exact headers, one example row).
- Upload → server-side parse → **row-level validation report** (row number, field, error) →
  operator fixes the file or imports valid rows only (explicit choice, both results shown).
- Bounded by row count/size limits; encoding UTF-8; no silent truncation.
- Skippable: if the business has no existing data, step 3 can be marked done empty.
- **Plain language:** "Bring your existing customer list. Not sure? Skip — you can import any
  time from Customers → Import."

## Step 4 — Knowledge / FAQ

- Add question/answer pairs the assistant will use to answer business-specific questions
  (cancellation policy, parking, deposits…).
- Profile-seeded starter examples the operator can edit.
- Items show an embedding status badge (READY / lexical mode) — embeddings are used when a
  provider is configured; otherwise retrieval is lexical. Both are labeled honestly in the UI.
- Skippable but recommended; readiness checklist counts ≥ 3 items as "good".

## Step 5 — AI configuration

- Provider detection: the wizard probes for a **local Ollama** endpoint and lists healthy local
  models; an OpenAI-compatible endpoint can be added with a key (stored AES-256-GCM encrypted,
  never displayed again — only a masked hint).
- **Readiness checks run live**: reachability, a 1-token completion test, embedding availability.
  Results are explicit badges (HEALTHY / UNHEALTHY with the error), never silent.
- AI mode selection: **local-only** (default) / hybrid / cloud, with a plain-language explanation
  of what each sends where.
- **Zero-integration guarantee:** the wizard is completable with no provider at all. In that case
  the assistant runs in clearly-labeled deterministic mode, and every other feature (bookings,
  invoices, ledger, automations) is fully functional.

## Step 6 — Channels

- Text chat (web): on.
- Browser voice test (Web Speech API): on — a "Test a call" button for the operator to place a
  simulated call in the browser; requires no telephony.
- Email / SMS channels: shown as **Deferred** with a one-line honest explanation ("delivery
  integration not built yet; messages will be recorded as drafts"). No fake toggles.
- Webhook endpoint (inbound automations) shown for admins.

## Step 7 — Collections & escalation

- Overdue policy: grace days, reminder cadence, escalation threshold, who gets escalated
  (internal staff vs customer contact).
- Template preview for reminder messages (drafted, not sent — delivery Deferred).
- Consent notice: outbound messages honor customer opt-outs; suppressed messages are logged as
  OPTED_OUT, not silently dropped.
- Validation: cadence days ≥ 1; escalation threshold ≥ last reminder day.

## Step 8 — Test scenarios & activation

- Guided end-to-end scenarios the operator runs in-app (each has pass/fail feedback):
  1. "Ask the assistant to book a service" → booking created, visible in calendar.
  2. "Ask about a price/policy" → answer grounded in your FAQ.
  3. "Create an invoice and record a payment" → balance updates; ledger shows both entries.
- **Readiness checklist** (all visible, each green/red): business profile set · ≥1 active service ·
  hours configured · ≥1 customer · FAQ ≥ 1 (recommended ≥ 3) · AI provider healthy **or**
  deterministic mode acknowledged · collections policy saved.
- **Activation is explicit**: a button ("Go live") that flips the org to active. Nothing is live
  until this is pressed. After activation, the wizard remains reachable for edits.

## Accessibility & UX rules

- Every input has a visible label; errors are text (not color-only) and announced to screen readers.
- Full keyboard operability; visible focus; logical tab order; step navigation via buttons.
- Autosave state changes announced politely (`aria-live=polite`); no content jumps.
- `prefers-reduced-motion` respected (no nonessential animation).
- Plain language throughout: no jargon without an inline explanation; every field that persists
  somewhere says where and who sees it.
- Progress indicator lists all 8 steps with completion state; "Resume" restores the last step.

## Verification hooks

- Wizard progress survives a hard reload (tested per [TEST_PLAN.md](./TEST_PLAN.md) §A).
- All 8 steps complete with zero external services (no DNS calls besides localhost) — verified by
  running with the sandbox SDK disabled.
