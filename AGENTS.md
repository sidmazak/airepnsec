# AGENTS.md — guidance for AI agents working in this repo

Read `/home/z/my-project/worklog.md` first — it contains the build history and environment facts. Append your own entry when done (never overwrite).

## What this is

"AI Secretary" — self-hosted AI business assistant (receptionist + bookings + invoices + ledger + knowledge + automations). Single Next.js 16 App Router project; single user-visible route `/` (SPA with client-side sections); all backend logic via `/api/*` route handlers.

## Hard rules

1. **TypeScript everywhere.** Run `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v '^examples/' | grep -v '^skills/'` — zero errors from your files before finishing.
2. **Money is integer cents** (`priceCents`, `amountCents`). Never floats.
3. **Organization scoping:** every DB query for business data filters `orgId` (from the session ctx).
4. **Validation at the boundary:** `parseBody(req, zodSchema)` in every mutating route; throw `ApiError(status, message, code)`.
5. **Never fake success.** If an operation fails, the API/UI must say so. Queued ≠ sent. Claim ≠ paid. Test-mode ≠ executed.
6. **LLMs never touch the DB directly.** The assistant only calls validated tools (`src/lib/ai/receptionist.ts`) that wrap business services.
7. **Financial history is append-only.** Corrections = reversal entries (`reverseEntry`), never updates/deletes.
8. **Payments are idempotent** — respect `idempotencyKey` / `externalEventId` uniqueness; duplicate webhooks return the original result.
9. **Secrets stay server-side.** Provider API keys: AES-256-GCM encrypted (`src/lib/crypto.ts`), never returned after save. `z-ai-web-dev-sdk` is backend-only.
10. **Local-only mode must be honored:** `assertAiPolicy()` blocks cloud providers when `org.dataMode === 'local_only'`.
11. **Audit consequential actions** with `src/lib/audit.ts` (bookings, payments, settings, automations, exports, logins).
12. **No test-framework code** in this sandbox. Verify via tsc + `bun run lint` + dev.log + browser.
13. **Don't run `bun run build`**; dev server on port 3000 is already running (`dev.log` is the log). Don't restart it.
14. **Prisma on SQLite:** no `mode: 'insensitive'` filters, no enum types, no native Json columns (use String + `parseJson` from `src/lib/org.ts`).

## Where things live

- `prisma/schema.prisma` — 26 models (org-scoped). After edits: `bun run db:push`.
- `src/lib/db.ts` — Prisma client singleton (`import { db } from '@/lib/db'`).
- `src/lib/api.ts` — `withAuth`/`withPublic` wrappers (CSRF header `x-requested-with: ais` on mutations, rate limiting, session loading), `json`/`fail`/`parseBody`.
- `src/lib/business/` — availability, booking, invoice, payments, ledger, collections (deterministic core; routes are thin).
- `src/lib/ai/` — providers (BYOK/encryption/tests), llm (adapters + local-only enforcement), embeddings (local lexical retriever), receptionist (tool loop).
- `src/lib/automation/` — engine (tick, triggers, runs) + instrumentation worker (60s).
- `src/lib/demo/seed.ts` — idempotent demo org (`/api/demo/seed`).
- `src/app/api/**` — route handlers; contract in `docs/API.md`.
- `src/components/sections/*` — the 12 SPA sections + auth screen + sidebar; state in `src/lib/client/store.ts`; typed client in `src/lib/client/api.ts` (attaches the CSRF header automatically).
- `src/components/ui/*` — shadcn/ui (use them; don't hand-roll).
- `docs/` — product/architecture/data/security/licensing/setup/test/API docs.

## Conventions

- shadcn/ui components; tokens only (no raw blue/indigo); amber for warnings, emerald for success.
- Every section: loading (Skeleton), empty (CTA), error (Alert + retry), success states. Long lists: `max-h-96 overflow-y-auto`. 44px touch targets. aria-labels on icon-only controls.
- Toasts via `useToast()` from `@/hooks/use-toast`; destructive actions confirmed via AlertDialog.
- Timezones: fixed-offset model (`UTC+05:30` style) — documented simplification in ARCHITECTURE.md.
