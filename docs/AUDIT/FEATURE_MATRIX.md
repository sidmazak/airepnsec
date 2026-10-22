# Feature Matrix — AI Secretary

Status legend: **DONE** = implemented + working; **PARTIAL** = exists but incomplete/honest-gap;
**MISSING** = not implemented; **N/A** = not applicable. Last reviewed: iteration 3, 2026-10-22.

## SPA sections (18 + auth)
| Section | Primary APIs | Status | Notes |
|---|---|---|---|
| Dashboard | `/api/dashboard` | DONE | KPIs, overdue, outbox, readiness. |
| Inbox | `/api/conversations*`, `/api/public/chat/*` | DONE | Web/SMS/WhatsApp/phone transcripts, human takeover, agent replies. |
| Voice Console | `/api/ai/asr`, `/api/ai/tts`, `/api/conversations/*` | DONE | Browser Web Speech fallback; real server STT/TTS via OpenAI-compatible endpoints; latency badges. |
| Realtime Voice | `/api/ai/realtime/*` | DONE | OpenAI-compatible WebRTC session + validated tools; falls back to the conversation model. |
| Bookings | `/api/bookings*`, `/api/availability` | DONE | Transactional overlap checks; reschedule/cancel/remind. |
| Customers | `/api/customers*` | DONE | CRUD, import, statement, consent/opt-out. |
| Invoices & Payments | `/api/invoices*`, `/api/payments/*` | DONE | Claims stay pending; verification guards; Stripe links/webhooks. |
| Ledger | `/api/ledger*` | DONE | Append-only; reversals only. |
| Usage & Billing | `/api/usage` | DONE | Token/latency/cost estimates from `AiLog`; unknown model pricing flagged. |
| Knowledge & FAQs | `/api/knowledge*` | DONE | Approve/reindex/search; neural + lexical hybrid. |
| Data Sources | `/api/datasources*` | DONE | sqlite/postgres/mysql/http_json → RAG; read-only SQL; SSRF guard; auto-sync. |
| Automations | `/api/automations*` | DONE | Triggers, conditions, delays, quiet hours, test mode, runs. |
| AI Providers | `/api/providers/*` | DONE | BYOK Ollama/OpenAI-compatible; encrypted keys; real connection tests. |
| Security | `/api/auth/2fa/*`, `/api/auth/sessions/revoke-all` | DONE | TOTP enrollment/disable; revoke other sessions. |
| Team | `/api/users*` | DONE | Members, invitations, roles, deactivation, session revocation, password reset; owner/admin only. |
| Business Profile | `/api/setup`, `/api/settings/*` | DONE | Profile, hours, policies, AI identity, collections config. |
| Integrations | `/api/integrations/*` | DONE | SMTP, Twilio, SMS gateways, Stripe, CalDAV, Google Calendar, outbound webhooks; per-kind tests. |
| Diagnostics | `/api/health/detail` | DONE | DB tuning, worker leases, heartbeat, providers, counts. |
| Setup Wizard | `/api/setup*` | DONE | Autosave/resume; readiness checks; end-to-end test. |
| Auth screen | `/api/auth/*`, `/api/session` | DONE | scrypt passwords, hashed sessions, optional TOTP. |

## Cross-cutting features
| Capability | Status | Evidence / gap |
|---|---|---|
| BYOK LLM providers | DONE | `ollama`, `openai_compatible`, `none`; AES-GCM key storage. |
| Local-only data mode | DONE | `assertAiPolicy()` blocks cloud endpoints when `dataMode==='local_only'`; private/LAN endpoints stay allowed. |
| Embeddings (independent config) | DONE | `local_neural` default; `ollama`/`openai_compatible`/`local_lexical`. |
| RAG pipeline | DONE | chunk → embed → hybrid cosine+BM25 → approved-only search. |
| BYO external data sources | DONE | 4 kinds; read-only SQL + DNS-aware SSRF guard; per-source sync lease. |
| Reranking | **MISSING** | Declared capability; tests report not-implemented. |
| Vision | **MISSING** | Declared capability; not implemented. |
| STT / TTS (server) | DONE | `openai_compatible` only; browser Web Speech path works client-side. |
| Real-time voice | DONE | WebRTC via OpenAI-compatible realtime endpoint; no local/browser realtime implementation. |
| Streaming token output | **MISSING** | Synchronous JSON responses; no SSE token stream. |
| Native tool-calling | PARTIAL | Strict JSON tool loop (`receptionist.ts`), not provider function-calling. |
| SMS | DONE | Twilio plus `sms_gateway` adapters: TextBee, httpSMS, android-sms-gateway, generic HTTP. |
| WhatsApp | DONE | Twilio inbound/outbound; inbound webhook signature-verified. |
| Outbound email | DONE | SMTP via nodemailer; invoice HTML/text templates. |
| Inbound email | **MISSING** | No IMAP/webhook ingest. |
| Calendar | DONE | ICS feed + per-booking `.ics` + two-way CalDAV push/pull + Google Calendar OAuth sync. External busy times become `CalendarBlock` rows, so a busy diary removes slots from availability and blocks new bookings. |
| Payments online | DONE | Stripe Payment Links + Stripe/generic signed webhooks. |
| Automations | DONE | 60s lease-protected worker tick; manual run shares the lease. |
| Outbox delivery | DONE | 30s lease-protected dispatcher; backoff and honest statuses. |
| Hardware detection / model catalog | **MISSING** | No GPU/RAM probe or recommended-model endpoint. |
| Audit log | DONE | `src/lib/audit.ts`; append-only rows. |
| Rate limiting / CSRF | DONE | In-memory sliding window per route plus a DB-backed `RateBucket` limiter for login; `x-requested-with: ais` on mutations. |
| Security headers | DONE | Configured in `next.config.ts` (HSTS/CSP in production). No middleware. |
| 2FA / session revocation | DONE | TOTP RFC 6238; DB sessions with `revokedAt`; revoke-all endpoint. |
| Worker single-flight | DONE | `WorkerLease` + TTL recovery; manual endpoints return 409 while busy. |
| Conversation turn serialization | DONE | DB lock + token; stale-lock takeover; 409 `conversation_busy`. |
| PABX routing | DONE | least-busy/round-robin/redirect, line pause/disable, real load, call records. |
| Receptionist runtime switch | DONE | Org-wide `running \| paused \| stopped` (`Organization.receptionistStatus`): dashboard control, audited changes, gates inbound SMS/WhatsApp/voice/web chat and realtime sessions. |
| SSO (SAML/OIDC) | **MISSING** | Email+password/TOTP only. |
| Team user management | DONE | `/api/users*`: members, one-time invitations (7-day TTL, hashed token, emailed via the outbox), invitation revocation, role changes, deactivation, session revocation, password reset; Team section in the SPA + public Join/Reset screens. Owners manage owners, admins manage agents/viewers, the last active owner is protected. |
| Shared-store rate limiting | DONE | `RateBucket` rows (DB-backed) for the login limiter — survives restarts, shared across replicas. |
