# Feature Matrix — AI Secretary

Status legend: **DONE** = implemented + working; **PARTIAL** = exists but incomplete/honest-gap;
**MISSING** = not implemented; **N/A** = not applicable. Last reviewed: Iteration 1.

## SPA sections (15 + auth)
| Section | Route/API | Status | Notes |
|---|---|---|---|
| Dashboard | `/api/dashboard*` | DONE | KPIs feed. |
| Inbox | `/api/conversations*` | DONE | Web chat conversations. Browser-only Web Speech voice test. |
| Voice Console | `/api/voice/*` | PARTIAL | Twilio voice webhooks exist; **voice/speed prefs persist to localStorage only** (not server-side). |
| Bookings | `/api/bookings*`, `/api/availability` | DONE | Availability → booking → audit. |
| Customers | `/api/customers*` | DONE | RBAC fixed this iteration. |
| Invoices & Payments | `/api/invoices*`, `/api/payments/*` | DONE | Payment integrity fixed this iteration. |
| Ledger | `/api/ledger*` | DONE | Append-only, reversals. |
| Knowledge & FAQs | `/api/knowledge*` | DONE | Approve/reindex/search. |
| Data Sources | `/api/datasources*` | DONE | BYO SQLite/Postgres/MySQL/http_json → RAG (iteration 12). |
| Automations | `/api/automations*` | DONE | Engine + triggers + runs. |
| AI Providers | `/api/providers/*` | DONE | Test route **added** this iteration. |
| Business Profile | `/api/settings/*` | DONE | |
| Integrations | `/api/integrations/*` | DONE | Test route **added** this iteration. |
| Diagnostics | `/api/diagnostics`, `dev.log` | DONE | |
| Setup Wizard | `/api/setup*` | DONE | |
| Auth screen | `/api/auth/*` | DONE | Custom session cookies (next-auth present but unused). |

## Cross-cutting features
| Capability | Status | Evidence / gap |
|---|---|---|
| BYOK LLM providers | DONE | `managed`, `ollama`, `openai_compatible`; AES-GCM key storage. |
| Local-only data mode | DONE | `assertAiPolicy()` blocks cloud providers when `dataMode==='local_only'`. |
| Embeddings (independent config) | DONE | `local_neural` default; `ollama`/`openai_compatible`/`local_lexical`. |
| RAG pipeline | DONE | chunk → embed → hybrid cosine+BM25 → search (approved only). |
| BYO external data sources | DONE | 4 kinds; read-only SQL + SSRF guard; auto-sync worker. |
| Reranking | **MISSING** | Declared in `Capability` but not wired into retrieval; test now reports not-implemented. |
| Vision | **MISSING** | Declared but not implemented. |
| STT / TTS | DONE | `managed`, `browser` (Web Speech), `openai_compatible`. |
| Real-time streaming | **MISSING** | No SSE/token streaming; no full-duplex voice. |
| Native tool-calling | PARTIAL | Prompt-based JSON tool loop (`receptionist.ts`), not provider function-calling. |
| SMS | PARTIAL | Twilio only (`sendTwilio`); **no gateway abstraction** (TextBee/httpSMS/Android SMS Gateway). |
| WhatsApp | PARTIAL | Twilio only. |
| Outbound email | DONE | SMTP via nodemailer. |
| Inbound email | **MISSING** | No IMAP/webhook ingest. |
| Calendar | PARTIAL | ICS (public, read-only) + one-way CalDAV. |
| Payments online | PARTIAL | Stripe connector + generic signed webhook. |
| Automations | DONE | 60s worker tick. |
| Hardware detection / model catalog | **MISSING** | No GPU/RAM probe, no recommended-model endpoint. |
| Audit log | DONE | `src/lib/audit.ts`. |
| Rate limiting / CSRF | DONE | In-memory sliding window + `x-requested-with: ais`. |
| Security headers / middleware | **MISSING** | No `middleware.ts`; README/TEST_PLAN claims are inaccurate. |
