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

## 2. SSO (SAML / OIDC) — DONE

Federated sign-in is implemented with full SAML 2.0 (SP-initiated Web Browser SSO) and OIDC
(authorization code flow with PKCE) support:

- SAML: SP metadata endpoint (`/api/auth/sso/saml/metadata`), ACS endpoint with signature
  verification, InResponseTo binding for replay protection, base64 normalization for form-posted
  responses, IdP metadata URL fetching with SSRF guard.
- OIDC: Discovery document fetch/caching, PKCE (S256), nonce, state cookie (HMAC, TTL-bounded),
  ID token verification (JWKS, RS256/HS256/ES256, iss/aud/exp/nonce checks).
- Account linking / auto-provisioning with domain allowlist, role assignment, email verification
  policy (configurable per org).
- SCIM 2.0 provisioning (`/api/scim/v2/Users`, `/ServiceProviderConfig`, bearer token auth,
  create/read/update/deactivate users).
- Admin UI: SSO settings tab with OIDC/SAML fields, SCIM settings, client secret / IdP cert
  stored encrypted (never returned after save).
- Audit logging for config changes, sign-ins, provisioning events.

## 3. Local speech models — Kokoro / Piper voices

Whisper (speech-to-text) and MMS-TTS (text-to-speech) run fully locally through transformers.js
(`src/lib/ai/localSpeech.ts`); the weights are downloaded on demand into `.models/`. What is
missing are the two higher-quality voice families: **Kokoro-82M** and **Piper** are not supported by
the transformers.js v4 model registry (their ONNX model type is unknown to it), so they are not in
the local catalog. Both work today through the OpenAI-compatible provider path — point the `tts`
capability at a local Kokoro-FastAPI or piper-http server and the Voice Console uses it like any
other endpoint.

## 4. Role-matrix E2E

The role matrix is enforced in code and covered by unit tests. The smoke script exercises the team
flow end to end, but there is still no automated per-role sweep over every endpoint.

## Removed from this list

- ~~Microsoft 365 / Graph calendar OAuth~~ — implemented (`microsoft_calendar` integration, OAuth
  2.0 against the Microsoft identity platform, Graph event + free/busy calls, two-way sync through
  the same `CalendarBlock` model as Google Calendar).
- ~~Server-side streaming and native provider tool calling~~ — implemented (`POST /api/ai/stream`
  streams SSE deltas/tools; provider-native tool calling is used when the endpoint supports it,
  with the strict JSON tool loop as the fallback).
- ~~Reranking and vision~~ — implemented (`src/lib/ai/rerank.ts` + `/api/ai/vision`; both optional
  capabilities that are off by default).
- ~~Hardware detection / model catalog~~ — implemented (`GET /api/system/hardware`).
- ~~Scheduled backups and retention~~ — implemented (`src/lib/backup.ts`, hourly worker, retention
  policy, `/api/admin/backups*`).
- ~~First-run owner registration~~ — implemented (`POST /api/auth/register-owner`, one-time while
  zero users exist; the auth screen switches to the setup form automatically).
- ~~Organisation-wide pause/stop for the receptionist~~ — implemented
  (`Organization.receptionistStatus`, dashboard control card, audited changes).
- ~~Google Calendar sync~~ — implemented (`google_calendar` integration, OAuth two-way sync,
  busy windows block availability).
- ~~Multi-user team management~~ — implemented (`/api/users*`: members, one-time invitations,
  role changes, deactivation, session revocation, password reset; Team section in the SPA).
- ~~Shared-store rate limiting~~ — implemented (`RateBucket` rows; the login limiter and the
  shared limiter survive a restart and work across replicas).
