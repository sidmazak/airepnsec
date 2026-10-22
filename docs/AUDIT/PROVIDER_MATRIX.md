# Provider Matrix — AI Secretary

Kinds (`ProviderKind`): `ollama | openai_compatible | browser | local_neural | local_lexical | none`.
There is **no managed/bundled AI provider** — the app is BYOK (local Ollama or any OpenAI-compatible endpoint).

| Capability | Allowed kinds (`CAPABILITY_INFO`) | Implemented kinds | Default | Enabled by default | Notes |
|---|---|---|---|---|---|
| `llm` | ollama, openai_compatible, none | ollama, openai_compatible, none | `none` | no | Conversation model is deliberately disabled until configured; `assertAiPolicy` blocks external endpoints in `local_only`. |
| `embedding` | local_neural, ollama, openai_compatible, local_lexical | all four | `local_neural` | yes | Independent of chat; built-in ONNX MiniLM runs on the server. |
| `stt` | browser, openai_compatible | browser (client), openai_compatible (server) | `browser` | yes | Server ASR requires an OpenAI-compatible `/audio/transcriptions` endpoint; browser uses Web Speech. |
| `tts` | browser, openai_compatible | browser (client), openai_compatible (server) | `browser` | yes | Server TTS requires `/audio/speech`; browser uses speechSynthesis. |
| `realtime` | none, openai_compatible | none, openai_compatible | `none` | no | WebRTC client secret minted only when configured; falls back to the LLM row for normal turns. |
| `rerank` | none, openai_compatible | **none** | `none` | no | Not implemented; test reports honestly without making a request. |
| `vision` | none, openai_compatible | **none** | `none` | no | Not implemented; test reports honestly. |

## Connection tests

`POST /api/providers/[capability]/test` (owner/admin) → `runAndStoreTest` → real probe:

- `llm/ollama`: `GET /api/tags` + model-presence check.
- `llm/openai_compatible`: `GET /models` (auth header when a key is stored).
- `embedding/local_neural`: real in-process embedding, reports dimension.
- `embedding/ollama`: real `/api/embeddings` call.
- `embedding/openai_compatible`: real `/embeddings` call.
- `embedding/local_lexical`: deterministic keyword index, no network.
- `stt`/`tts`/`realtime`/`openai_compatible`: endpoint `/models` probe.
- `browser`: reports "runs in the browser" without a network call.
- `rerank`/`vision` (non-none): explicit **not implemented** result, no request.

Results are stored in `lastTestAt/lastTestOk/lastTestError`; responses never include secrets.

## Integration (channel) providers

| Integration kind | Send | Real test | Notes |
|---|---|---|---|
| `smtp` | nodemailer | `transport.verify()` | Anonymous relay allowed. |
| `twilio_sms` | Twilio Messages API | account fetch | First-choice SMS sender. |
| `sms_gateway` | adapter per `config.provider` | provider-specific probe (or a real test SMS for generic HTTP with `testRecipient`) | TextBee, httpSMS, android-sms-gateway, generic HTTP. |
| `twilio_whatsapp` | Twilio Messages API | account fetch | `whatsapp:` normalization; inbound webhook. |
| `twilio_voice` | Twilio Messages API (SMS fallback) | account fetch | Inbound calls via TwiML; PABX line routing; can send SMS. |
| `caldav` | PUT/DELETE events | PROPFIND | Two-way sync (push + pull) via `/api/integrations/caldav-sync`. |
| `stripe` | Payment Links | `/v1/account` | Payment links + signature-verified webhook. |
| `webhook_out` | signed POST | real signed test POST | HMAC-SHA256; one row per destination. |
