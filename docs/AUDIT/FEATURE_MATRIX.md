# Feature Matrix — AI Secretary

Status legend: **DONE** = implemented + working; **PARTIAL** = exists but incomplete/honest-gap;
**MISSING** = not implemented; **N/A** = not applicable. Last reviewed: iteration 4, 2026-10-23.

## SPA sections (19 + auth)
| Section | Primary APIs | Status | Notes |
|---|---|---|---|
| Dashboard | `/api/dashboard` | DONE | KPIs, overdue, outbox, readiness. |
| Inbox | `/api/conversations*`, `/api/public/chat/*` | DONE | Web/SMS/WhatsApp/phone transcripts, human takeover, agent replies. |
| Voice Console | `/api/ai/asr`, `/api/ai/tts`, `/api/conversations/*` | DONE | Browser Web Speech fallback; real server STT/TTS via OpenAI-compatible endpoints; latency badges. |
| Realtime Voice | `/api/ai/realtime/*` | DONE | OpenAI-compatible WebRTC session + validated tools; falls back to the conversation model. |
| Bookings | `/api/bookings*`, `/api/availability` | DONE | Transactional overlap checks; reschedule/cancel/remind. |
| Customers | `/api/customers*` | DONE | CRUD, import, statement, consent/opt-out. |
| Invoices & Payments | `/api/invoices*`, `/api/payments/*` | DONE | Claims stay pending; verification guards; Stripe/Square links + signed webhooks; QuickBooks/Xero/MYB push. |
| Ledger | `/api/ledger*` | DONE | Append-only; reversals only. |
| Usage & Billing | `/api/usage` | DONE | Token/latency/cost estimates from `AiLog`; unknown model pricing flagged. |
| Knowledge & FAQs | `/api/knowledge*` | DONE | Approve/reindex/search; neural + lexical hybrid; file import (PDF/DOCX/HTML/MD/CSV/JSON); website crawl with AI-configured gate. |
| Data Sources | `/api/datasources*` | DONE | sqlite/postgres/mysql/http_json → RAG; read-only SQL; SSRF guard; auto-sync. |
| Automations | `/api/automations*` | DONE | Triggers, conditions, delays, quiet hours, test mode, runs. |
| AI Providers | `/api/providers/*` | DONE | BYOK Ollama/OpenAI-compatible/Anthropic/Google/Azure OpenAI; per-capability model discovery; encrypted keys; real connection tests. |
| Security | `/api/auth/2fa/*`, `/api/auth/sessions/revoke-all` | DONE | TOTP enrollment/disable; revoke other sessions. |
| Team | `/api/users*` | DONE | Members, invitations, roles, deactivation, session revocation, password reset; owner/admin only. |
| Business Profile | `/api/setup`, `/api/settings/*` | DONE | Profile, hours, policies, AI identity, collections config. |
| Integrations | `/api/integrations/*` | DONE | SMTP + 5 email APIs, Twilio, 8 SMS gateways, Stripe/Square, QuickBooks/Xero/MYB, Shopify/WooCommerce/Wix/Mailchimp, CalDAV, Google/Microsoft calendars, outbound webhooks; per-kind tests + contact sync. |
| Diagnostics | `/api/health/detail` | DONE | DB tuning, worker leases, heartbeat, providers, counts. |
| Setup Wizard | `/api/setup*` | DONE | Autosave/resume; readiness checks; end-to-end test. |
| Auth screen | `/api/auth/*`, `/api/session` | DONE | scrypt passwords, hashed sessions, optional TOTP. |

## Cross-cutting features
| Capability | Status | Evidence / gap |
|---|---|---|
| BYOK LLM providers | DONE | `ollama`, `openai_compatible`, `anthropic`, `google`, `azure_openai`, `none`; AES-GCM key storage; per-capability model discovery. |
| Local-only data mode | DONE | `assertAiPolicy()` blocks cloud endpoints when `dataMode==='local_only'`; private/LAN endpoints stay allowed. |
| Embeddings (independent config) | DONE | `local_neural` default; `ollama`/`openai_compatible`/`local_lexical`. |
| RAG pipeline | DONE | chunk → embed → hybrid cosine+BM25 → approved-only search. |
| BYO external data sources | DONE | 4 kinds; read-only SQL + DNS-aware SSRF guard; per-source sync lease. |
| Reranking | DONE | `src/lib/ai/rerank.ts` — second-stage ranking of the hybrid retrieval against a real `/rerank` endpoint; optional and off by default. |
| Vision | DONE | `src/lib/ai/vision.ts` + `/api/ai/vision` — real multimodal call; optional and off by default. |
| STT / TTS (server) | DONE | `openai_compatible` or `local_speech` (ONNX Whisper/MMS-TTS in `.models/`); browser Web Speech path works client-side. |
| Real-time voice | DONE | WebRTC via OpenAI-compatible realtime endpoint; no local/browser realtime implementation. |
| Streaming token output | DONE | `POST /api/ai/stream` — SSE (`delta`/`tool`/`done`/`error`); non-streaming providers answer in one `delta` + `done`. |
| Native tool-calling | DONE | Provider function-calling when the endpoint supports `tools`; automatic fallback to the strict JSON tool loop otherwise. |
| SMS | DONE | Twilio plus `sms_gateway` adapters: TextBee, httpSMS, android-sms-gateway, Telnyx, Vonage, MessageBird, Plivo, generic HTTP. |
| WhatsApp | DONE | Twilio inbound/outbound; inbound webhook signature-verified. |
| Outbound email | DONE | SMTP via nodemailer or `email_api` (SendGrid/Mailgun/Postmark/Resend/Brevo); invoice HTML/text templates; dispatcher prefers the API and never double-sends. |
| Inbound email | **MISSING** | No IMAP/webhook ingest. |
| Calendar | DONE | ICS feed + per-booking `.ics` + two-way CalDAV push/pull + Google Calendar OAuth sync + Microsoft 365 Graph OAuth sync. External busy times become `CalendarBlock` rows, so a busy diary removes slots from availability and blocks new bookings. |
| Payments online | DONE | Stripe + Square Payment Links, signature-verified webhooks, generic webhook; Stripe preferred when both are enabled. |
| Accounting push | DONE | QuickBooks Online, Xero, MYOB: refresh-token OAuth rotation, customer match/create, invoice push with duplicate guard. |
| Commerce/CRM sync | DONE | Shopify, WooCommerce, Wix, Mailchimp contact import; match by external ref/email/phone; SSRF guard. |
| Website → knowledge | DONE | Same-origin crawler, SSRF validation, optional AI cleanup, deterministic fallback; requires an active LLM. |
| Automations | DONE | 60s lease-protected worker tick; manual run shares the lease. |
| Outbox delivery | DONE | 30s lease-protected dispatcher; backoff and honest statuses. |
| Hardware detection / model catalog | DONE | `GET /api/system/hardware` — CPU/RAM/GPU/disk probe plus a model catalog with fit reasons. |
| Audit log | DONE | `src/lib/audit.ts`; append-only rows. |
| Rate limiting / CSRF | DONE | In-memory sliding window per route plus a DB-backed `RateBucket` limiter for login; `x-requested-with: ais` on mutations. |
| Security headers | DONE | Configured in `next.config.ts` (HSTS/CSP in production). No middleware. |
| 2FA / session revocation | DONE | TOTP RFC 6238; DB sessions with `revokedAt`; revoke-all endpoint. |
| Worker single-flight | DONE | `WorkerLease` + TTL recovery; manual endpoints return 409 while busy. |
| Conversation turn serialization | DONE | DB lock + token; stale-lock takeover; 409 `conversation_busy`. |
| PABX routing | DONE | least-busy/round-robin/redirect, line pause/disable, real load, call records. |
| Receptionist runtime switch | DONE | Org-wide `running \| paused \| stopped` (`Organization.receptionistStatus`): dashboard control, audited changes, gates inbound SMS/WhatsApp/voice/web chat and realtime sessions. |
| SSO (SAML/OIDC) | DONE | SAML 2.0 + OIDC (PKCE) + SCIM 2.0; encrypted IdP/client secrets; audited. |
| Team user management | DONE | `/api/users*`: members, one-time invitations (7-day TTL, hashed token, emailed via the outbox), invitation revocation, role changes, deactivation, session revocation, password reset; Team section in the SPA + public Join/Reset screens. Owners manage owners, admins manage agents/viewers, the last active owner is protected. |
| Shared-store rate limiting | DONE | `RateBucket` rows (DB-backed) for the login limiter — survives restarts, shared across replicas. |
| Local speech models (STT/TTS) | DONE | `src/lib/ai/localSpeech.ts` — Whisper/MMS-TTS ONNX models in `.models/`, downloaded on demand, run through transformers.js; WAV codec in `src/lib/ai/audio-wav.ts`. |
| Scheduled backups | DONE | `src/lib/backup.ts` + `/api/admin/backups*` — hourly worker, retention policy, snapshot list, audited schedule changes. |
