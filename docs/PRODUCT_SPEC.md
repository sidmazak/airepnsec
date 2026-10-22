# Product Specification — AI Secretary

> Status: product contract for this build. Implementation status is tracked in
> [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md); anything marked Planned/Deferred there is not shipped.

## 1. Objective

AI Secretary is a **local-first, self-hostable AI business assistant**. It answers inbound customer
questions (voice and text), books appointments on a real scheduling engine, manages customers,
issues invoices, records verified payments, and keeps an auditable financial ledger — all on
infrastructure the operator controls.

Design principles:

1. **Local-first.** The operator's data lives in a database they own (SQLite by default; Postgres
   supported through the Docker deployment). No vendor cloud is required for core flows.
2. **AI is optional and swappable.** The assistant works against local models (Ollama), a local
   neural embedder, or an operator-supplied OpenAI-compatible endpoint (BYOK). No proprietary AI
   SDK. The business vertical slice (steps 1–7 in §7) must work with **zero AI providers**; the
   assistant itself needs a configured model and never invents a deterministic fallback reply.
3. **One shared core, configured per business type.** Apartments, cars, salons, clinics, and
   contractors are *profiles*, not forks: one booking/invoicing/ledger engine serves all.
4. **Honesty over demos.** Unimplemented features are labeled Planned/Deferred. The system never
   fakes success ("message sent" when only queued, "paid" when only claimed, "tested" when not).

## 2. Supported business profiles

A **business profile** is a configuration object selected in the 8-step setup wizard. It seeds
vocabulary, templates, booking semantics, and default services. It does not change the code path:
every profile runs on the same services (`src/lib/business`), Prisma schema, and assistant tool set.

| Profile | Bookable "thing" | Booking unit | Capacity model | Typical default services |
|---|---|---|---|---|
| Apartment rentals | Listing / unit | Night(s), check-in date | Resource (the unit) | Check-in support, cleaning slot, viewing appointment |
| Car rentals | Vehicle | Day(s), pickup date | Resource (the vehicle) | Pickup/drop-off, test drive, service appointment |
| Salon | Service menu item | Time slot | Staff member(s) with skills | Haircut, coloring, nails, consultation |
| Clinic | Appointment type | Time slot | Practitioner (staff) + room (optional resource) | Consultation, follow-up, procedure |
| Contractor | Job type | Time window | Crew member (staff) | Site visit, estimate, repair visit |

What varies per profile (config, not code): terminology, booking duration semantics, default
catalog/import templates, dunning defaults, and knowledge starters. What never varies: conflict
rules, invoice/payment math, ledger rules, RBAC checks, audit, automation engine, org isolation.

## 3. Feature status

| Area | Feature | Status (this build) |
|---|---|---|
| Setup | 8-step setup wizard (Business, Services & staff, Import, Knowledge, AI provider, Channels, Collections, Test & activate), autosave, resumable, readiness gate | Implemented |
| Setup | Business profiles (5) with seeded templates | Implemented |
| Setup | CSV import for customers/services with templates + row-level validation report | Implemented |
| Customers | CRUD, notes, tags, consent/opt-out flags | Implemented |
| Scheduling | Services, staff, business hours, validated booking engine with overlap protection | Implemented |
| Scheduling | Resource booking (units/vehicles/rooms) | Implemented (schema + service layer) |
| Invoicing | Invoice creation from bookings, line items, balances, void | Implemented |
| Payments | Record/verify payments, claims vs verified payments, idempotency keys, generic signed inbound webhook | Implemented |
| Payments | Stripe payment links + signature-verified Stripe webhooks | Implemented (BYOK) |
| Payments | PayPal/other provider-specific schemas | **Planned** — use the generic webhook or Stripe |
| Ledger | Append-only ledger, adjustments/reversals only, per-invoice reconciliation | Implemented |
| Assistant | Text chat receptionist with strict JSON tool loop and validated tools | Implemented |
| Assistant | Voice Console — browser Web Speech fallback or BYOK OpenAI-compatible STT/TTS driving the same tool loop | Implemented |
| Assistant | Inbound telephony (Twilio Voice/TwiML, speech Gather, escalation, PABX line routing) + inbound SMS/WhatsApp threads | Implemented (BYOK) |
| Assistant | Outbound PSTN dialing / voice broadcast | **Deferred** — inbound telephony only |
| Assistant | Server-side streaming, native provider tool calls, reranking, vision | **Not implemented** — the tool loop is non-streaming JSON |
| Knowledge | FAQ/knowledge items, approved-only retrieval, local lexical + neural embeddings | Implemented |
| Knowledge | External datasources (Postgres/MySQL/SQLite read-only, HTTP JSON) into the same RAG pipeline | Implemented (BYOK; SSRF-guarded) |
| AI providers | Local Ollama, any OpenAI-compatible endpoint, browser STT, built-in local neural/lexical embeddings, policy gate | Implemented; **no managed/hosted default** |
| Automations | Trigger/condition/delay/action engine, retry, dedupe, audit, per-day caps, quiet hours | Implemented |
| Automations | Outbound delivery (SMTP, Twilio SMS/WhatsApp, BYO SMS gateway, signed webhooks) via the leased outbox dispatcher | Implemented; consent/opt-out enforced at queue and run time |
| Collections | Overdue policy, dunning schedule, escalation | Implemented (audited queued messages/tasks; nothing auto-sends unverified) |
| Channels | Web text chat, public embedded web chat, Voice Console, phone, inbound SMS, inbound WhatsApp | Implemented |
| Channels | Instagram inbound | **Planned** |
| Calendar | Read-only ICS feed + CalDAV push/pull sync (remote cancel/move applied conservatively) | Implemented |
| Calendar | Google/Microsoft OAuth, external-event ingestion beyond CalDAV | **Planned** |
| Reporting | Dashboard, usage metrics (`AiLog`), diagnostics (DB/workers/providers) | Implemented (basic) |
| Data | Org-scoped JSON export, SQLite backup endpoint, Docker/Compose deployment | Implemented |
| Data | One-click restore/rollback scripts | **Not shipped** — snapshot via `VACUUM INTO`/`pg_dump` documented in SELF_HOSTING |
| Team | Multiple users per org with role management UI | **Not shipped** — roles are enforced server-side, but this build has no user-management API/UI; each org has its owner account |

## 4. Non-goals

- **Not a multi-tenant SaaS.** One deployment serves one organization; org scoping exists for
  isolation and demo data, not for public multi-tenancy.
- **No payment custody.** The system records and verifies payments; it never holds or moves funds.
- **No email/SMS delivery without your own provider.** Delivery is BYOK (SMTP/Twilio/SMS gateway)
  through the outbox; nothing sends until an integration is enabled, and nothing is ever faked.
- **No native mobile apps.** Responsive web UI; voice runs in the browser or over Twilio.
- **No general chatbot framework.** Fixed validated tool set scoped to reception/booking/billing.
- **No marketplace/public directory/SEO surface.** The public surfaces are the public web-chat
  endpoint (anyone who knows the org slug can start a chat), signature-verified inbound webhooks,
  and the session-authenticated ICS feed. There is no listing/discovery page.
- **No dark-pattern collection.** No analytics/telemetry; `local_only` blocks cloud providers.

## 5. Roles (enforced server-side)

| Role | Current capabilities |
|---|---|
| **Owner** | Everything an Admin can do; the only role that can complete owner-only setup actions. No ownership-transfer or org-deletion endpoint exists yet. |
| **Admin** | Services/staff/hours, AI providers & keys, integrations, automations, data sources, ledger adjustments, export/backup, void invoices, telephony lines, conversation takeover. |
| **Agent** | Customers, bookings, invoices, payments, knowledge, conversations. Cannot manage users/settings/AI keys/automations/ledger. |
| **Viewer** | Read-only across dashboards, bookings, invoices, ledger, conversations, diagnostics. |

Every route resolves session → user → org and checks role server-side; business services validate
again. The full matrix lives in [SECURITY.md](./SECURITY.md). **Gap:** there is no user-management
API or UI in this build, so an org effectively has one owner account; the role checks are still
exercised by tests and remain the enforcement layer for future team support.

## 6. Demo mode

- `POST /api/demo/seed` (public, rate-limited, idempotent) creates a clearly-labeled demo org
  (`demo@aisecretary.local` / `demo-1234`) with customers, services, staff, hours, FAQ, bookings,
  invoices (paid/partial/overdue), ledger entries, and a seeded inbox conversation.
- **No deterministic assistant fallback exists.** Demo AI provider rows start disabled; chat reports
  an explicit configuration error until the operator enables a local/OpenAI-compatible model.
- Demo mode makes no outbound network calls of its own. It does not bypass auth; it creates a real
  local account. Re-running the seed reuses/updates the demo org rather than duplicating it.
- There is no one-click demo reset endpoint; delete `db/custom.db` (or the demo rows) to reset.

## 7. Acceptance criteria — minimum vertical slice

The business slice passes **without any cloud AI keys**:

| # | Step | Pass condition |
|---|---|---|
| 1 | Install & run | `npm install`, `.env` with `DATABASE_URL`, `npm run db:push`, `npm run dev` → port 3000 with no runtime errors in `dev.log` |
| 2 | Setup wizard | All 8 steps complete; progress survives reload; completable with zero external integrations (AI provider optional) |
| 3 | Customer + service | Created via UI/CSV, scoped to the organization |
| 4 | Booking | Created against hours + staff/resource; overlap rejected **409** inside the booking transaction |
| 5 | Invoice | Correct line math; balance = total − verified payments |
| 6 | Payment | Idempotency key/webhook event replay does not double-credit; status transitions `draft/issued → partial → paid` |
| 7 | Ledger | Charge + payment entries reconcile per invoice; corrections only as reversal/adjustment entries |
| 8 | AI optional | Steps 1–7 required no cloud AI provider; any assistant use ran on a local model or reported an explicit error |

The assistant vertical slice (tool-created booking + verified reply via text or Twilio voice) is the
stretch goal; the business slice must pass even with the assistant disabled.
