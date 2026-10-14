# Data Model — AI Secretary

Source of truth: `prisma/schema.prisma`. This document is the field-level reference plus the
**invariants** the service layer must enforce.

> **Schema status note (honest).** At the start of this build, `schema.prisma` contained only the
> scaffold placeholder models (`User`, `Post`). The model set below is the authoritative target the
> data-foundation phase implements. The "Status" column reflects the build recorded in
> `worklog.md`; if the schema on disk diverges from this document, update this document in the same
> change.

Portability rules (SQLite sandbox → PostgreSQL production): no Prisma enums (strings + zod unions),
no native `Json` columns (JSON held in `String` columns, validated in services), money is `Int`
cents, no DB-specific types.

## 1. Model index

| Model | Purpose | Status (this build) |
|---|---|---|
| `Organization` | Tenant root; business profile, timezone, currency | Implemented |
| `User` | Login identity (email + scrypt hash) | Implemented |
| `Membership` | User ↔ Organization with role | Implemented |
| `Customer` | End customers of the business | Implemented |
| `Service` | Bookable service catalog item | Implemented |
| `Staff` | Staff/practitioner/crew member | Implemented |
| `StaffService` | Staff ↔ Service skills join | Implemented |
| `BusinessHours` | Weekly opening template | Implemented |
| `Resource` | Capacity unit (apartment/vehicle/room) | Implemented |
| `Booking` | Reservation of service + staff/resource | Implemented |
| `Invoice` | Billable document for a customer | Implemented |
| `InvoiceLine` | Invoice line items | Implemented |
| `Payment` | Money received against an invoice | Implemented |
| `WebhookEvent` | Inbound webhook log (dedupe + replay safety) | Implemented |
| `LedgerEntry` | Append-only financial ledger | Implemented |
| `KnowledgeItem` | FAQ/knowledge for assistant grounding (`KnowledgeChunk` now stores per-chunk embedding `model` + `dim`; vectors are neural by default, lexical hash as fallback) | Implemented |
| `Conversation` / `Message` | Assistant transcripts incl. tool calls | Implemented |
| `AssistantRun` | Per-turn provider/latency/error metadata | Implemented |
| `AutomationRule` / `AutomationRun` | Automation definitions and executions | Implemented |
| `OutboundMessage` | Outbound messages (queued/draft; delivery **Deferred**) | Implemented (creation/audit) |
| `ProviderConfig` | AI/payment provider configs; encrypted keys | Implemented |
| `Setting` | Org settings, wizard state, feature flags | Implemented |
| `AuditEvent` | Consequential-change audit trail | Implemented |

`Post` from the scaffold is **removed** by the data-foundation phase (it was placeholder only).

## 2. Entity relationships

```
Organization 1─* Membership *─1 User
Organization 1─* Customer / Service / Staff / Resource / BusinessHours
Staff *─* Service          (StaffService)
Organization 1─* Booking  ──1 Customer
                           ──1 Service
                           ──0..1 Staff / Resource
Booking 1─0..1 Invoice 1─* InvoiceLine
Invoice 1─* Payment (verified payments reduce balance)
Invoice 1─* LedgerEntry (CHARGE)   Payment 1─1 LedgerEntry (PAYMENT)
Organization 1─* KnowledgeItem / Conversation 1─* Message
Conversation 1─* AssistantRun
Organization 1─* AutomationRule 1─* AutomationRun
Organization 1─* OutboundMessage / ProviderConfig / Setting / AuditEvent / WebhookEvent(provider-level org)
```

## 3. Model reference

Conventions: all ids are `String @id @default(cuid())`; all business tables carry `organizationId`
with a relation to `Organization`; `createdAt DateTime @default(now())`, `updatedAt @updatedAt`
unless noted. `*_Json` columns are `String` holding JSON, validated by zod on read/write.

### Organization
| Field | Type | Notes |
|---|---|---|
| name | String | Display name |
| slug | String @unique | URL-safe identifier |
| businessProfile | String | One of `APARTMENT_RENTALS \| CAR_RENTALS \| SALON \| CLINIC \| CONTRACTOR` (zod-validated) |
| timezone | String | IANA tz; used for hours/booking display |
| currency | String | ISO 4217; default `USD`; money stored in minor units |
| settings_Json | String | Org-level settings blob |
| demo | Boolean | Marks demo orgs (seed/reset, excluded from real counts) |

### User
| Field | Type | Notes |
|---|---|---|
| email | String @unique | Login id, lowercased |
| name | String? | Display name |
| passwordHash | String | `scrypt` hash (never exposed to client) |
| lastLoginAt | DateTime? | Audited on login |

### Membership
| Field | Type | Notes |
|---|---|---|
| userId | String (FK User) | |
| organizationId | String (FK Organization) | |
| role | String | `OWNER \| ADMIN \| AGENT \| VIEWER` (zod-validated) |
| *Invariant* | | `@@unique([userId, organizationId])`; an org has exactly one OWNER |

### Customer
| Field | Type | Notes |
|---|---|---|
| name | String | |
| email | String? | |
| phone | String? | Normalized digits+`+`; used by assistant lookup |
| notes | String? | Free-form |
| tags_Json | String | Array of strings |
| consentMarketing | Boolean @default(false) | Outbound marketing allowed |
| consentTransactional | Boolean @default(true) | Booking/invoice messages allowed |
| optedOut_Json | String | Channel opt-outs `{ "EMAIL": ts, "SMS": ts }` |
| externalRef | String? | Operator's external id |

### Service
| Field | Type | Notes |
|---|---|---|
| name | String | |
| description | String? | |
| category | String? | Profile-specific grouping |
| durationMin | Int | Slot length in minutes (or base unit for day-based profiles) |
| bufferMin | Int @default(0) | Buffer after each booking |
| priceCents | Int | Money in cents (Int) |
| dayBased | Boolean @default(false) | True for night/day rentals |
| active | Boolean @default(true) | |

### Staff
| Field | Type | Notes |
|---|---|---|
| name | String | |
| email / phone | String? | |
| active | Boolean @default(true) | |

### StaffService — `@@unique([staffId, serviceId])`

### BusinessHours
| Field | Type | Notes |
|---|---|---|
| weekday | Int | 0=Sunday … 6=Saturday |
| openMin / closeMin | Int | Minutes from local midnight (org timezone) |
| closed | Boolean @default(false) | |
| *Invariant* | | One row per (organizationId, weekday): `@@unique([organizationId, weekday])` |

### Resource
| Field | Type | Notes |
|---|---|---|
| name | String | e.g. "Apt 3B", "Corolla #7", "Room 2" |
| type | String | Profile-specific (`UNIT \| VEHICLE \| ROOM \| OTHER`) |
| active | Boolean @default(true) | |

### Booking
| Field | Type | Notes |
|---|---|---|
| customerId | FK Customer | |
| serviceId | FK Service | |
| staffId | FK Staff? | Required for slot-based services that need staff |
| resourceId | FK Resource? | Required for capacity-type profiles |
| startAt / endAt | DateTime | UTC in DB; interpreted in org timezone |
| status | String | `PENDING \| CONFIRMED \| CANCELLED \| COMPLETED \| NO_SHOW` |
| source | String | `WEB \| ASSISTANT \| WIZARD \| API` |
| notes | String? | |
| cancelledAt / cancellationReason | DateTime? / String? | Set on cancel |
| *Invariant* | | **No double-booking**: conflict check + insert inside one Prisma interactive transaction; see §4 |

### Invoice
| Field | Type | Notes |
|---|---|---|
| number | String | Org-unique human-readable number (`@@unique([organizationId, number])`) |
| customerId | FK Customer | |
| bookingId | FK Booking? | Source booking if any |
| status | String | `DRAFT \| ISSUED \| PARTIALLY_PAID \| PAID \| VOID \| UNCOLLECTIBLE` |
| totalCents | Int | Sum of lines at issue time (Int cents) |
| currency | String | From org at creation |
| issuedAt / dueAt | DateTime? | |
| voidedAt / voidReason | DateTime? / String? | |
| *Invariant* | | `balanceCents = totalCents − Σ(VERIFIED payments)`; status transitions derived from verified payments (§4) |

### InvoiceLine
| Field | Type | Notes |
|---|---|---|
| invoiceId | FK Invoice | Cascade delete with invoice while DRAFT only |
| description | String | |
| quantity | Int | Whole units (profiles needing fractions store per-unit lines) |
| unitPriceCents / totalCents | Int | `line.totalCents = quantity × unitPriceCents` checked on write |

### Payment
| Field | Type | Notes |
|---|---|---|
| invoiceId | FK Invoice | |
| amountCents | Int | > 0 |
| status | String | `PENDING \| VERIFIED \| FAILED \| REFUNDED` |
| method | String | `MANUAL \| CASH \| BANK \| GENERIC_WEBHOOK` |
| reference | String? | Operator/provider reference |
| idempotencyKey | String? | `@@unique([organizationId, idempotencyKey])` |
| verifiedAt | DateTime? | Set by verification flow |
| *Invariant* | | Only VERIFIED payments affect invoice balance & ledger (§4) |

### WebhookEvent
| Field | Type | Notes |
|---|---|---|
| provider | String | e.g. `generic`, later `stripe` (**Deferred**) |
| eventId | String | `@@unique([provider, eventId])` — replay/dedupe anchor |
| payload_Json | String | Raw body (for replay/debug) |
| signatureVerified | Boolean | HMAC check result |
| status | String | `RECEIVED \| PROCESSED \| SKIPPED_DUPLICATE \| FAILED` |
| error | String? | |

### LedgerEntry (append-only)
| Field | Type | Notes |
|---|---|---|
| entryDate | DateTime | |
| type | String | `CHARGE \| PAYMENT \| ADJUSTMENT \| REVERSAL` |
| amountCents | Int | Signed: charges positive, payments negative, adjustments either |
| refType / refId | String / String | `INVOICE`+id, `BOOKING`+id, `MANUAL`+memo id |
| memo | String? | |
| createdBy | String | Actor id (`system`/user id) |
| reversesEntryId | String? (self-FK) | Set on ADJUSTMENT/REVERSAL referencing the corrected entry |
| *Invariant* | | **No UPDATE/DELETE paths in code.** Corrections only via ADJUSTMENT/REVERSAL referencing the original (§4) |

### KnowledgeItem
| Field | Type | Notes |
|---|---|---|
| question / answer | String | FAQ pair |
| tags_Json | String | Array of strings |
| embedding_Json | String? | Float array (JSON) when embeddings available; lexical search used otherwise; pgvector column at production switch |
| embeddingStatus | String | `NONE \| PENDING \| READY \| FAILED` |

### Conversation / Message
| Field | Type | Notes |
|---|---|---|
| Conversation: customerId | FK? | Channel, status (`OPEN \| CLOSED`), startedAt/endedAt |
| Message: conversationId | FK Conversation | |
| role | String | `USER \| ASSISTANT \| SYSTEM \| TOOL` |
| content | String | |
| toolName / toolArgs_Json / toolResult_Json | String? | Set for role=TOOL; persisted for full audit |
| *Invariant* | | Every assistant tool invocation is persisted before the result is used to continue the loop |

### AssistantRun
| Field | Type | Notes |
|---|---|---|
| conversationId | FK Conversation | One row per assistant turn |
| provider / model / mode | String | `mode`: `LOCAL \| HYBRID \| CLOUD \| FALLBACK` |
| toolCalls | Int | Iterations used |
| status | String | `OK \| ERROR \| TIMEOUT \| POLICY_BLOCKED` |
| error / latencyMs | String? / Int? | |

### AutomationRule / AutomationRun
| Field | Type | Notes |
|---|---|---|
| Rule: name, triggerType | String | see ARCHITECTURE §6 |
| Rule: triggerConfig_Json / conditions_Json / actions_Json | String | zod-validated shapes |
| Rule: delaySeconds | Int @default(0) | |
| Rule: enabled | Boolean @default(true) | |
| Run: ruleId, subjectType, subjectId | FK / String | What the run acted on |
| Run: dedupeKey | String @unique | `(ruleId, subjectType, subjectId, window)` |
| Run: status | String | `QUEUED \| RAN \| SKIPPED \| FAILED \| CANCELLED` |
| Run: attempts, lastError, scheduledFor, ranAt | Int, String?, DateTime, DateTime? | Retry bookkeeping |

### OutboundMessage
| Field | Type | Notes |
|---|---|---|
| customerId | FK Customer? | |
| channel | String | `EMAIL \| SMS` (delivery **Deferred**) |
| body / template | String | |
| status | String | `QUEUED \| SENT \| FAILED \| OPTED_OUT \| CANCELLED` — in this build, terminal state is QUEUED (draft/audit) |
| dedupeKey | String? | Reminder dedupe |
| *Invariant* | | Consent/opt-out checked at creation **and** at send time; opted-out → OPTED_OUT, never silently dropped |

### ProviderConfig
| Field | Type | Notes |
|---|---|---|
| kind | String | `LLM \| EMBEDDING \| PAYMENTS` |
| provider | String | `ollama \| openai-compatible \| sandbox-sdk \| generic-webhook` |
| baseUrl / model | String? | |
| encryptedKey | String? | **AES-256-GCM ciphertext**; plaintext never stored, never returned to client |
| isDefault | Boolean | One default per kind per org |
| status / lastCheckedAt | String / DateTime? | `UNVERIFIED \| HEALTHY \| UNHEALTHY` |

### Setting
| Field | Type | Notes |
|---|---|---|
| key | String | e.g. `wizard.progress`, `ai.mode`, `collections.policy` |
| value_Json | String | |
| *Invariant* | | `@@unique([organizationId, key])` |

### AuditEvent
| Field | Type | Notes |
|---|---|---|
| actorType / actorId | String / String? | `USER \| SYSTEM \| ASSISTANT` |
| action | String | e.g. `booking.create`, `payment.verify`, `ai.mode.change`, `data.export` |
| entityType / entityId | String / String? | |
| before_Json / after_Json | String? | Diff snapshots for consequential changes |
| ip | String? | Where applicable |
| *Invariant* | | Written in the same transaction as the change it describes; never user-editable |

## 4. Invariants (enforcement contract)

| # | Invariant | Where enforced |
|---|---|---|
| 1 | **Booking overlap protection.** A booking is rejected (409) if it overlaps another non-CANCELLED booking for the same staff or resource, respecting service duration + buffer. Check-and-insert runs inside a single Prisma interactive transaction so concurrent requests serialize; SQLite's single-writer model makes this atomic in the sandbox; PostgreSQL production relies on the same transaction boundary (a unique/exclusion index is a planned hardening once on Postgres) | `src/lib/business/bookings` |
| 2 | **Invoice balance.** `balanceCents = totalCents − Σ payments where status=VERIFIED`. PARTIALLY_PAID/PAID transitions are derived and written in the same transaction as the payment verification | `src/lib/business/payments` |
| 3 | **Ledger corrections.** Ledger is append-only. Changing a wrong entry is only possible by writing an ADJUSTMENT or REVERSAL entry with `reversesEntryId` pointing at the original. No code path updates or deletes ledger rows | `src/lib/business/ledger` |
| 4 | **Payment idempotency.** A payment is accepted once per `idempotencyKey` (unique per org). Webhook-driven payments are accepted once per `(provider, eventId)`; duplicates are logged as `SKIPPED_DUPLICATE` and produce no ledger/balance effect | `src/lib/business/payments` + webhook handler |
| 5 | **Organization scoping.** Every business table carries `organizationId`; every service call receives the org id from the verified session (never from the client body alone). Cross-org reads/writes must 404/403 | `src/lib/business` + route handlers |
| 6 | **Money integer rule.** All monetary values are `Int` cents. No floats anywhere in the write path | schema + zod |
| 7 | **Verified payments only.** PENDING payments never affect balances, ledger, or collections | `src/lib/business/payments` |
| 8 | **Consent gating.** Outbound-message automations resolve consent/opt-out at run time; suppressed actions are recorded as SKIPPED/OPTED_OUT | automation runner |
| 9 | **Audit coupling.** Consequential changes write their AuditEvent inside the same transaction; a failed audit write fails the operation | all mutating services |
| 10 | **Wizard state survives restarts.** Wizard progress persisted per org in `Setting(wizard.progress)`; completion is an explicit flag, never implied | wizard API |
