# AGENTS.md — guidance for AI agents working in this repo

Read `worklog.md` (repo root) first — it contains the build history and environment facts. Append your own entry when done (never overwrite).

**Runtime: Node.js + npm only.** This project does not use Bun. Use `npm`/`npx` (never `bun`/`bunx`).

**No proprietary AI SDK.** AI is BYOK only: local Ollama, or any OpenAI-compatible endpoint. Do not introduce a vendor AI SDK.

## What this is

"AI Secretary" — self-hosted AI business assistant (receptionist + bookings + invoices + ledger + knowledge + automations). Single Next.js 16 App Router project; single user-visible route `/` (SPA with client-side sections); all backend logic via `/api/*` route handlers.

## Hard rules

1. **TypeScript everywhere.** Run `npx tsc --noEmit -p tsconfig.json` — zero errors from your files before finishing.
2. **Money is integer cents** (`priceCents`, `amountCents`). Never floats.
3. **Organization scoping:** every DB query for business data filters `orgId` (from the session ctx).
4. **Validation at the boundary:** `parseBody(req, zodSchema)` in every mutating route; throw `ApiError(status, message, code)`.
5. **Never fake success.** If an operation fails, the API/UI must say so. Queued ≠ sent. Claim ≠ paid. Test-mode ≠ executed.
6. **LLMs never touch the DB directly.** The assistant only calls validated tools (`src/lib/ai/receptionist.ts`) that wrap business services.
7. **Financial history is append-only.** Corrections = reversal entries (`reverseEntry`), never updates/deletes.
8. **Payments are idempotent** — respect `idempotencyKey` / `externalEventId` uniqueness; duplicate webhooks return the original result.
9. **Secrets stay server-side.** Provider API keys: AES-256-GCM encrypted (`src/lib/crypto.ts`), never returned after save. No proprietary AI SDK is used — only your own Ollama or OpenAI-compatible endpoint.
10. **Local-only mode must be honored:** `assertAiPolicy()` blocks cloud providers when `org.dataMode === 'local_only'`.
11. **Audit consequential actions** with `src/lib/audit.ts` (bookings, payments, settings, automations, exports, logins).
12. **Unit tests use Node's built-in `node:test`** (`tests/unit/*.mts`, `npm run test:unit`) — no Vitest/Jest/Playwright. Verify via `npx tsc --noEmit`, `npm run lint`, `npm run test:unit`, dev.log + browser. CI (`.github/workflows/ci.yml`) also runs the build.
13. **Don't run `npm run build`**; dev server on port 3000 is already running (`dev.log` is the log). Don't restart it.
14. **Prisma on SQLite:** no `mode: 'insensitive'` filters, no enum types, no native Json columns (use String + `parseJson` from `src/lib/org.ts`).

## Where things live

- `prisma/schema.prisma` — 30 models (org-scoped; includes `DataSource`, `WorkerLease`, `TelephonyLine/Call`). After edits: `npm run db:push`.
- `src/lib/db.ts` — Prisma client singleton (`import { db } from '@/lib/db'`).
- `src/lib/api.ts` — `withAuth`/`withPublic` wrappers (CSRF header `x-requested-with: ais` on mutations, rate limiting, session loading), `json`/`fail`/`parseBody`.
- `src/lib/business/` — availability, booking, invoice, payments, ledger, collections (deterministic core; routes are thin).
- `src/lib/ai/` — providers (BYOK/encryption/tests), llm (adapters + local-only enforcement), embeddings (local lexical retriever), receptionist (tool loop).
- `src/lib/datasources/` — BYO external database/JSON ingestion into RAG (`registry` kinds + zod, `adapters` read-only SQL/SSRF-guarded fetchers, `sync` row→document + auto-sync). Routes under `src/app/api/datasources/**`; UI `src/components/sections/data-sources-section.tsx`.
- `src/lib/automation/` — engine (tick, triggers, runs) + instrumentation worker (60s).
- `src/lib/demo/seed.ts` — idempotent demo org (`/api/demo/seed`).
- `src/app/api/**` — route handlers; contract in `docs/API.md`.
- `src/components/sections/*` — the 13 SPA sections + auth screen + sidebar; state in `src/lib/client/store.ts`; typed client in `src/lib/client/api.ts` (attaches the CSRF header automatically).
- `src/components/ui/*` — shadcn/ui (use them; don't hand-roll).
- `docs/` — product/architecture/data/security/licensing/setup/test/API docs.

## Conventions

- shadcn/ui components; tokens only (no raw blue/indigo); amber for warnings, emerald for success.
- Every section: loading (Skeleton), empty (CTA), error (Alert + retry), success states. Long lists: `max-h-96 overflow-y-auto`. 44px touch targets. aria-labels on icon-only controls.
- Toasts via `useToast()` from `@/hooks/use-toast`; destructive actions confirmed via AlertDialog.
- Timezones: fixed-offset model (`UTC+05:30` style) — documented simplification in ARCHITECTURE.md.
