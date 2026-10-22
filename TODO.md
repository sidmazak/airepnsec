# Backlog — AI Secretary

Live list of what is **not** implemented yet. Everything else is done and verified — see
[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the phase history and
[docs/AUDIT/FEATURE_MATRIX.md](docs/AUDIT/FEATURE_MATRIX.md) for the per-feature status.

Items are ordered by value, not by urgency. Nothing here blocks a self-hosted deployment.

## 1. Live external provider E2E — BLOCKED_EXTERNAL

Every connector has a **real** connection test (`POST /api/integrations/[id]/test`) that talks to the
provider. What cannot be done in this environment is signing up for third-party accounts on the
user's behalf (Twilio, Stripe, Google Cloud, an SMTP relay, a CalDAV server). Those tests are
honest: they report the provider's real answer instead of a fake success.

To close this: run the app against real credentials and record the results in
[docs/TEST_PLAN.md](docs/TEST_PLAN.md).

## 2. Microsoft 365 / Graph calendar OAuth

CalDAV covers Outlook (Microsoft publishes a CalDAV endpoint) and Google Calendar has a native
OAuth integration. A first-class Graph implementation would need a second OAuth provider in
`src/lib/integrations/` plus Graph event/freebusy calls — the `CalendarBlock` model and the sync
route shape would be reused.

## 3. Multi-user team management + SSO

Roles (`owner | admin | agent | viewer`) are enforced on every route, but there is no user or
invite API/UI, no SSO/SAML/OIDC, and no password-reset flow. This is the biggest functional gap
for a multi-person business.

## 4. Local speech models (Kokoro TTS / Whisper STT / Piper TTS)

Current speech support: the browser's own Web Speech API (Voice Console, zero setup) and
OpenAI-compatible `/audio/transcriptions` + `/audio/speech` for server-side STT/TTS. A fully local
pipeline would add ONNX models (Kokoro-82M ≈ 80 MB, Piper ≈ 30–50 MB per voice, Whisper via
`transformers.js`) and new provider kinds (`kokoro`, `piper`, `whisper`) in
`src/lib/ai/speech.ts` + `src/lib/ai/providers.ts`, with on-demand model downloads into `.models/`.
Not required: `local_only` mode already works with the browser speech path.

## 5. Server-side streaming and native provider tool calling

The receptionist uses a strict JSON tool loop and answers in one synchronous response. Streaming
(SSE) and provider-native function calling would improve latency and robustness on slow models.

## 6. Reranking and vision

Declared capabilities (`rerank`, `vision`) exist in the provider matrix but have no implementation.
Reranking is a small addition on top of the existing hybrid retrieval; vision needs an image
pipeline that the product does not have a use case for yet.

## 7. Hardware detection / model catalog

No GPU/RAM probe and no recommended-model endpoint, so "which model should I run?" is answered by
the docs instead of the app.

## 8. Shared-store rate limiting and role-matrix E2E

Rate limiting is an in-memory sliding window (per process). Multi-replica deployments should put a
limiter in front of the app. The role matrix is enforced in code and covered by unit tests, but
there is no automated per-role endpoint sweep.

## 9. Scheduled backups and retention

Backup endpoints exist (`POST /api/admin/backup`, `VACUUM INTO` / `pg_dump` documented) but no
scheduler and no retention policy ship with the app — run them from cron/systemd.

## Removed from this list

- ~~First-run owner registration~~ — implemented (`POST /api/auth/register-owner`, one-time while
  zero users exist; the auth screen switches to the setup form automatically).
- ~~Organisation-wide pause/stop for the receptionist~~ — implemented
  (`Organization.receptionistStatus`, dashboard control card, audited changes).
- ~~Google Calendar sync~~ — implemented (`google_calendar` integration, OAuth two-way sync,
  busy windows block availability).
