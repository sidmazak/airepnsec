# Provider Matrix — AI Secretary

Kinds (`ProviderKind`): `managed | ollama | openai_compatible | browser | local_neural | local_lexical | none`.

| Capability | Allowed kinds (CAPABILITY_INFO) | Implemented kinds | Default | Enabled by default | Notes |
|---|---|---|---|---|---|
| `llm` | managed, ollama, openai_compatible, none | managed, ollama, openai_compatible | `managed` | yes | `assertAiPolicy` blocks managed/openai_compatible under `local_only`. |
| `embedding` | local_neural, ollama, openai_compatible, local_lexical | all four | `local_neural` | yes | Independent of chat model. Stored in `KnowledgeChunk.vector` + `model`/`dim`. |
| `stt` | managed, browser, openai_compatible | managed, browser, openai_compatible | `browser` | no | `speech.ts`; browser uses Web Speech API. |
| `tts` | managed, browser, openai_compatible | managed, browser, openai_compatible | `browser` | no | |
| `rerank` | none, openai_compatible | **none** | `none`* | no | Not implemented; `testProvider` reports honestly. *Previously defaulted to invalid `browser` — fixed. |
| `vision` | none, openai_compatible, managed | **none** | `none`* | no | Not implemented; reported honestly. |

## Connection tests (this iteration)
- `POST /api/providers/[capability]/test` (owner/admin) → `runAndStoreTest` → real probe:
  - `llm/managed`: live chat completion.
  - `llm/ollama`: `/api/tags` + model-presence check.
  - `llm/openai_compatible`: `GET /models`.
  - `embedding/*`: live embed call per provider (dim returned).
  - `rerank`/`vision` (non-none): explicit **not implemented** result.
- Stores `lastTestAt/lastTestOk/lastTestError`; response never includes secrets.

## Integration (channel) providers
| Integration kind | Send | Real test | Notes |
|---|---|---|---|
| `smtp` | nodemailer | `transport.verify()` | Anonymous relay allowed. |
| `twilio_sms` | `sendTwilio` | account fetch | **Only SMS gateway supported.** |
| `twilio_whatsapp` | `sendTwilio` | account fetch | `whatsapp:` normalization. |
| `twilio_voice` | `sendTwilio` | account fetch | Can also send SMS. |
| `caldav` | one-way PUT | PROPFIND | |
| `stripe` | — | `/v1/account` | Payment links + webhook. |
| `webhook_out` | signed POST | real signed test POST | HMAC-SHA256. |
