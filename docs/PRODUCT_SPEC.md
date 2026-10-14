# Product Specification — AI Secretary

> Status: authoritative product contract for this build. Implementation state is tracked in
> [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md); anything not marked DONE there must be read as planned, not shipped.

## 1. Objective

AI Secretary is a **local-first, self-hostable AI business assistant**. It answers inbound customer
questions (voice and text), books appointments on a real scheduling engine, manages customers,
issues invoices, records verified payments, and keeps an auditable financial ledger — all on
infrastructure the operator controls.

Design principles:

1. **Local-first.** The operator's data lives in a database they own. No vendor cloud is required
   for core flows (bookings, invoices, ledger, automations).
2. **AI is optional and swappable.** The assistant works against local models (e.g. Ollama) or
   operator-supplied cloud keys (BYOK). The product must complete its full business vertical slice
   with **zero cloud AI keys**.
3. **One shared core, configured per business type.** Apartments, cars, salons, clinics, and
   contractors are *profiles*, not forks. A single booking/invoicing/ledger engine serves all of them.
4. **Honesty over demos.** Features that are not implemented are labeled Deferred/Planned. The
   system never fakes success (e.g. "message sent" when nothing was sent).

## 2. Supported business profiles

A **business profile** is a configuration object selected in the setup wizard. It seeds vocabulary,
templates, booking semantics, and default services. It does **not** change the code path: every
profile runs on the same services (`src/lib/business`), the same Prisma schema, and the same
assistant tool set.

| Profile | Bookable "thing" | Booking unit | Capacity model | Typical default services |
|---|---|---|---|---|
| Apartment rentals | Listing / unit | Night(s), check-in date | Resource (the unit) | Check-in support, cleaning slot, viewing appointment |
| Car rentals | Vehicle | Day(s), pickup date | Resource (the vehicle) | Pickup/drop-off, test drive, service appointment |
| Salon | Service menu item | Time slot | Staff member(s) with skills | Haircut, coloring, nails, consultation |
| Clinic | Appointment type | Time slot | Practitioner (staff) + room (optional resource) | Consultation, follow-up, procedure |
| Contractor | Job type | Time window | Crew member (staff) | Site visit, estimate, repair visit |

What varies per profile (config, not code):

- Terminology labels in the UI and assistant prompts ("listing" vs "vehicle" vs "service").
- Booking duration semantics (slots in minutes vs. day/night ranges).
- Default service catalog and CSV import templates.
- Dunning (collections) defaults and escalation message templates.
- Knowledge/FAQ starter examples.

What never varies: booking conflict rules, invoice/payment math, ledger rules, RBAC, audit,
automation engine, org isolation.

## 3. Feature list

| Area | Feature | Status (this build) |
|---|---|---|
| Setup | 8-step setup wizard, autosave, resumable | Implemented (see [SETUP_WIZARD.md](./SETUP_WIZARD.md)) |
| Setup | Business profiles (5) with seeded templates | Implemented |
| Setup | CSV import for customers/services with templates + row-level validation report | Implemented |
| Customers | CRUD, notes, tags, consent flags | Implemented |
| Scheduling | Services, staff, business hours, real booking engine with overlap protection | Implemented |
| Scheduling | Resource booking (units/vehicles/rooms) | Implemented (schema + service layer) |
| Invoicing | Invoice creation from bookings, line items, balances, void/adjust | Implemented |
| Payments | Record payment, verification workflow, idempotency keys, generic signed-webhook adapter | Implemented |
| Payments | Provider-specific webhooks (Stripe/PayPal event schemas) | **Deferred** — needs real provider credentials; generic HMAC adapter is the seam |
| Ledger | Append-only ledger, adjustments/reversals only, per-invoice reconciliation | Implemented |
| Assistant | Text chat receptionist with strict JSON tool loop | Implemented |
| Assistant | Browser voice test calls (Web Speech API) through the same tool loop | Implemented |
| Assistant | Telephony/PSTN inbound & outbound voice | **Deferred** — requires telephony provider account + adapter; browser voice test exercises the identical server-side loop |
| Knowledge | FAQ/knowledge items, retrieval for assistant grounding | Implemented |
| AI providers | Local model detection (Ollama), OpenAI-compatible BYOK, sandbox SDK adapter, policy gate | Implemented |
| Automations | Trigger/condition/delay/action engine, retry, dedupe, audit | Implemented |
| Automations | Outbound message **delivery** (SMS/email send) | **Deferred** — messages are created and audited as QUEUED/draft; no send-side integration in this build; consent & opt-out enforced at creation time |
| Collections | Overdue policy, dunning schedule, escalation | Implemented (as automations producing audited queued messages/tasks) |
| Channels | Web text chat, browser voice test | Implemented |
| Channels | WhatsApp/Instagram inbound | **Planned** |
| Calendar | External calendar sync (ICS/Google) | **Deferred** — planned read-only ICS feed first |
| Reporting | Dashboard (today's bookings, outstanding balances, ledger view) | Implemented (basic) |
| Data | Org-scoped JSON export, backup endpoint | Implemented (JSON export) |
| Data | Binary snapshot backup/restore scripts (`infra/`) | **Planned** — `infra/` packaging ships with the production Docker Compose work |

## 4. Non-goals

- **Not a multi-tenant SaaS.** One deployment serves one organization. Multi-tenancy is per-instance.
- **No payment custody.** The system records and verifies payments; it never holds or moves funds.
- **No email/SMS delivery in this build.** Outbound messages are modeled, consent-checked, and
  audited, but sending is deferred (see feature table).
- **No native mobile apps.** The admin UI is responsive web; the voice test runs in the browser.
- **Not a general chatbot framework.** The assistant is scoped to reception/booking/billing intents
  over first-party data, with a fixed validated tool set.
- **No marketplace, no public directory, no SEO surface.** The only public surface is the assistant
  channel configured by the operator.
- **No dark-pattern collection.** Analytics/telemetry do not exist; local-only mode forbids outbound calls.

## 5. User roles

| Role | Capabilities |
|---|---|
| **Owner** | Everything an Admin can do, plus: delete organization, manage ownership transfer, rotate server-side secrets (encryption key rotation procedure), delete all org data |
| **Admin** | Manage users & roles, services/staff/hours, AI providers & keys, automations, channels, ledger adjustments, export/backup, void invoices |
| **Agent** | Day-to-day operations: customers CRUD, create/change bookings, create invoices, record payments (verification per policy), manage knowledge items, run assistant conversations. Cannot: manage users, edit AI keys, edit automations, adjust ledger |
| **Viewer** | Read-only dashboards, bookings, invoices, ledger. Cannot mutate anything. Assistant conversations visible in transcript view only |

Enforcement is server-side: every route handler resolves the session → membership → role, and
business services assert permission before mutation. The full matrix lives in
[SECURITY.md](./SECURITY.md) §RBAC.

## 6. Demo mode

Demo mode exists so an operator can evaluate the product **without any external accounts**.

- Seeded demo organization with one profile (apartment rentals by default), sample customers,
  services, staff, hours, FAQ entries, bookings, invoices, and ledger entries.
- Demo assistant runs in **local-only** semantics: if no local model is detected and no keys are
  configured, the chat falls back to a deterministic rule-based responder so bookings/invoices can
  still be demonstrated. This fallback is clearly labeled in the UI ("deterministic mode — no model
  configured"), never presented as an LLM.
- No outbound network calls are made by demo mode. Ever.
- Demo data is disposable: a reset action recreates the seed. Demo organizations are visually
  flagged and excluded from "real" counts where mixed.
- Demo mode does **not** bypass auth: it creates a real (local) demo account.

## 7. Acceptance criteria — minimum vertical slice

The product passes acceptance when this slice completes end-to-end **without any cloud AI keys**:

| # | Step | Pass condition |
|---|---|---|
| 1 | Install & run | `bun install`, `.env` with `DATABASE_URL`, `bun run db:push`, `bun run dev` → app serves on port 3000 with no runtime errors in `dev.log` |
| 2 | Setup wizard | All 8 steps complete; progress survives reload; wizard is completable with zero external integrations (AI provider optional at this stage) |
| 3 | Customer + service | A customer and a bookable service exist, created via UI or CSV import, scoped to the organization |
| 4 | Booking via real engine | Booking created against business hours + staff/resource; an overlapping booking attempt is **rejected with 409** (conflict logic in the service layer inside a transaction, not UI-only) |
| 5 | Invoice | Invoice issued from the booking with correct line math; balance = total − verified payments |
| 6 | Verified payment | Payment recorded with an idempotency key; replaying the same key/webhook event ID does **not** double-credit; invoice status transitions DRAFT/ISSUED → PARTIALLY_PAID → PAID |
| 7 | Ledger inspect | Ledger shows the charge entry for the invoice and the payment entry; corrections are only possible as adjustment/reversal entries referencing the original; per-invoice ledger sums reconcile with invoice balance |
| 8 | No cloud AI keys | None of steps 1–7 required or invoked a cloud AI provider; if the assistant was used, it ran on a local model or deterministic fallback |

A customer-facing assistant conversation that creates a booking (verified via the browser voice
test or text chat) is the stretched goal on top of this slice; the business slice above must pass
even with the assistant disabled.
