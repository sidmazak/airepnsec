# Self-hosting — AI Secretary

Run the app on your own machine. One Node-compatible runtime (Bun), one
database, no telemetry, no required third-party accounts.

> The Docker packaging in [`infra/`](../infra/README.md) is delivered but
> **not verified inside the build sandbox (no Docker daemon)** — verify the
> compose stack on your host first.

## Requirements

- **Bun 1.x** (the runtime the build and docs are verified with) — or Node 20+
  with the equivalent `next start` flow, untested here.
- **PostgreSQL 16 + pgvector** for the production target (`pgvector/pgvector:pg16`
  image provided), or plain **SQLite** for a single-box dev/edge install.
- Outbound network only for the things you opt into: your SMTP relay, Twilio,
  Stripe, and (on first boot) the local ONNX embedding model download.
- 1 vCPU / 1 GB RAM is enough to start; the embedding model adds ~100 MB in
  `.models/`.

## Quick start (Docker Compose)

```bash
cd infra
cp .env.example .env        # set POSTGRES_PASSWORD, APP_SECRET
docker compose up -d --build
# http://localhost:3000 → create the owner account → setup wizard
```

The compose stack starts `app` + `pgvector/pgvector:pg16`, waits for the
database healthcheck, applies the schema (`prisma db push`) and boots the
standalone server on port 3000. Details: [`infra/README.md`](../infra/README.md).

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | Prisma connection string. `file:/abs/path/custom.db` for SQLite; `postgresql://user:pass@host:5432/db?schema=public` for Postgres. |
| `APP_SECRET` | recommended | Server-held secret; its SHA-256 is the **AES-256-GCM key** that encrypts stored credentials (integration secrets, provider API keys). If unset, a random key file is generated at `.data/secret.key` on first boot (mode 0600) — fine for single-box installs as long as that file persists. |
| `NODE_ENV` | yes (prod) | `production` — enables `Secure` session cookies and quieter Prisma logging. |
| `NEXT_PUBLIC_APP_URL` | no | Reserved convenience var for public links in outbound emails; current email templates embed relative `.ics` paths, so nothing breaks if unset. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | compose | Credentials for the `db` service; compose builds the default `DATABASE_URL` from them. |

`OLLAMA_BASE_URL` is **not** read by the app — Ollama/OpenAI-compatible AI
endpoints are configured per org in the UI (AI Providers, encrypted at rest).

## SQLite → PostgreSQL migration

The Prisma schema is written **portable** from day one (see
[ARCHITECTURE.md](./ARCHITECTURE.md) §2):

- **No Prisma enums** — role/status fields are `String` validated by zod.
- **No native `Json` columns** — structured blobs are `String` columns holding
  JSON, parsed/validated in services.
- **Money is `Int` cents** everywhere.
- No DB-specific types in the shared schema.

Switching is therefore a datasource change, not a rewrite:

1. Set `DATABASE_URL` to the `postgresql://…` URL.
2. Run `bunx prisma db push` against the empty Postgres database (the Docker
   image does this at start; the schema is created from scratch).
3. To move *data*, export from the SQLite install via `GET /api/admin/export`
   (secrets-free JSON) or copy rows with a script — there is no automated
   SQLite→Postgres data migration tool in this build (honest gap).
4. **pgvector note (future):** the current RAG stores chunk vectors as JSON
   strings and computes cosine similarity in-process (see
   [ARCHITECTURE.md](./ARCHITECTURE.md) §5). On Postgres you can keep that
   layout unchanged; moving vectors to a pgvector column + index is the
   planned optimization, not a requirement to run on Postgres.

## APP_SECRET rotation — read before rotating

**Rotating `APP_SECRET` does NOT re-encrypt stored secrets.** All
AES-256-GCM ciphertexts in the database (integration credentials, provider API
keys) were encrypted with the key derived from the previous value; after
rotation, decryption fails and those credentials are effectively invalidated
(the app treats them as empty and integrations must be **re-entered** by an
owner/admin — or, if you had no `APP_SECRET` set and used the `.data/secret.key`
file, keep that file backed up and its volume mounted). Plan rotations as a
credential re-entry exercise, not a drop-in env change.

## Backups

- **SQLite**: `POST /api/admin/backup` (owner/admin) runs `VACUUM INTO` and
  writes `backups/backup-<ts>.db` (the compose file mounts this dir as the
  `app_backups` volume). Copy those files out like any SQLite DB.
- **Postgres**: `docker compose exec db pg_dump -U ais ais > backup.sql`.
- **Portable export**: `GET /api/admin/export` (owner/admin) produces a
  secrets-free JSON snapshot of org data (customers, bookings, invoices,
  payments, ledger, knowledge, conversations, automations).
- Stored integration/API credentials are encrypted with your `APP_SECRET`
  key material — a DB backup without the key (or `.data/secret.key`) restores
  data but not credentials. Back up both deliberately.

## Updating

```bash
cd /path/to/repo && git pull
cd infra && docker compose up -d --build   # rebuilds the image; prisma db push applies schema changes
```

The schema push on boot is additive for new columns/tables; breaking schema
changes are called out in release notes. Data lives in named volumes
(`pgdata`, `app_data`, `app_backups`, `app_models`) — `docker compose down`
keeps them, `docker compose down -v` does not.

## Reverse proxy & TLS

The app serves plain HTTP on port 3000. Terminate TLS in front of it (Caddy,
nginx, your existing proxy) and forward to `app:3000`. Session cookies are set
`Secure` when `NODE_ENV=production`, so serve the app over HTTPS in production.
Webhook endpoints that must be reachable by providers (`/api/stripe/webhook`,
`/api/payments/webhook`) should be exposed through the same proxy — keep them
on HTTPS so secrets/tokens travel encrypted.

## Zero telemetry

This app **sends nothing anywhere by itself**: no analytics, no crash
reporting, no phone-home, no update checks. The only outbound requests are the
ones you configure (AI provider endpoints, SMTP/Twilio/Stripe, webhook
destinations) plus the one-time ONNX embedding model download on first boot.
Audit data stays in your database.
