# Self-hosting — AI Secretary

Run the app on infrastructure you control. One Node.js runtime, one database, no telemetry, no
required third-party accounts. AI and messaging providers are optional and BYOK.

> **Verification status:** the application and business flows are verified locally. Both Docker
> profiles (PostgreSQL and SQLite) were built and smoke-tested on 2026-10-22: healthy services,
> schema boot, demo seed, login, readiness and local ONNX embeddings. External providers
> (Twilio/Stripe/SMTP/CalDAV/pg/mysql) still require your own credentials. See
> [TEST_PLAN.md](./TEST_PLAN.md).

## 1. Choose a deployment profile

| Profile | Best for | Database | Reproducible |
|---|---|---|---|
| **Docker Compose + PostgreSQL** (recommended) | Production, multiple replicas, backups with `pg_dump` | PostgreSQL 16 | Yes |
| **Docker Compose + SQLite** | Single small business, one box, simplest ops | SQLite file in a volume | Yes |
| **Node.js + systemd** | Hosts without Docker | SQLite or PostgreSQL | Yes, if you pin Node/deps |

Requirements:

- **Node.js 24+** and npm (the Docker image uses `node:24-bookworm-slim`).
- **PostgreSQL 16+** for the recommended production profile; plain SQLite is supported for a single
  app instance. The compose file uses `pgvector/pgvector:pg16` for compatibility, but RAG currently
  stores vectors as JSON strings and does not require the pgvector extension.
- Outbound network only for what you enable: SMTP, Twilio, Stripe, CalDAV, AI endpoints, and the
  one-time local ONNX embedding-model download.
- Start with 1 vCPU / 1 GB RAM; the local embedding model adds roughly 100 MB in `.models/`. Add RAM
  for Postgres and concurrent AI requests.

## 2. Docker Compose — PostgreSQL (recommended)

```bash
cd infra
cp .env.example .env
# Edit infra/.env:
#   POSTGRES_PASSWORD=$(openssl rand -hex 24)
#   APP_SECRET=$(openssl rand -hex 32)
docker compose up -d --build
docker compose ps                       # app + db should become healthy
curl -fsS http://localhost:3000/api/health/ready
```

What happens:

1. The image is built with `DATABASE_PROVIDER=postgresql` and the Next.js standalone output.
2. Compose waits for the `db` healthcheck, then the app runs `prisma db push --skip-generate`
   (additive schema only) and starts `server.js`.
3. The app container healthcheck calls `/api/health/ready`, which performs a real DB query.
4. Logs are rotated (10 MB × 3); containers restart unless stopped.

First boot: open `http://localhost:3000`, create the owner account, and complete the 8-step wizard.
Then put TLS in front before entering real customer data.

### Ports and network

Only the reverse proxy should be publicly reachable. Keep `3000` bound to localhost/private network
in production; the compose file publishes it for first-run convenience. Configure the proxy to:

- terminate TLS and forward to `app:3000`;
- overwrite `x-forwarded-for` (the app trusts the first hop for rate limits);
- permit request bodies large enough for CSV/knowledge imports;
- use bounded timeouts (AI turns can take tens of seconds).

A Caddy example is at [`infra/Caddyfile.example`](../infra/Caddyfile.example). nginx users should set
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` only if nginx is the first trusted hop,
and disable proxy buffering only if you later add streaming.

## 3. Docker Compose — SQLite (single box)

```bash
cd infra
cp .env.example .env       # set APP_SECRET; POSTGRES_* are unused here
docker compose -f docker-compose.sqlite.yml up -d --build
curl -fsS http://localhost:3000/api/health/ready
```

Rules for SQLite:

- Run **exactly one** `app` container. Do not scale replicas against one SQLite file.
- Keep the `app_db`, `app_data`, `app_backups` and `app_models` volumes.
- WAL mode, a 5-second busy timeout and `synchronous=NORMAL` are applied at boot.
- Back up with `POST /api/admin/backup` (`VACUUM INTO`), then copy the file off-host.

## 4. Node.js + systemd (no Docker)

```bash
# as the service user
git clone <your-repo> /opt/ai-secretary
cd /opt/ai-secretary
npm ci
cp .env.example .env                       # set DATABASE_URL, APP_SECRET, NODE_ENV=production
npx prisma generate
npx prisma db push
npm run build
npm start                                  # or run under systemd
```

Example unit (`/etc/systemd/system/ai-secretary.service`):

```ini
[Unit]
Description=AI Secretary
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=ai-secretary
WorkingDirectory=/opt/ai-secretary
EnvironmentFile=/opt/ai-secretary/.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

Then `systemctl daemon-reload && systemctl enable --now ai-secretary`. Use the same readiness checks
and backups as the Docker profiles. `APP_SECRET`/`.data/secret.key` and the database must be backed up
together.

## 5. Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | `file:/abs/path/custom.db` for SQLite; `postgresql://user:pass@host:5432/db?schema=public` for Postgres. |
| `APP_SECRET` | strongly recommended | Server-held secret; its SHA-256 is the **AES-256-GCM key** encrypting stored credentials. If unset, a random `.data/secret.key` is generated on first boot (mode 0600). Generate with `openssl rand -hex 32`. |
| `NODE_ENV` | yes (prod) | `production` enables `Secure` session cookies and quieter Prisma logging. |
| `PUBLIC_BASE_URL` | Twilio/webhooks | Public HTTPS origin used as a fallback for Twilio signature validation when an integration `publicBaseUrl` is unset. |
| `NEXT_PUBLIC_APP_URL` | no | Reserved for public links; current email templates use relative `.ics` paths, so it is not required. |
| `DATABASE_PROVIDER` | Docker build arg | `sqlite` (default) or `postgresql`; Prisma bakes the provider into the generated client at build time. |
| `AIS_DISABLE_WORKERS` | no | `1` disables all in-process workers (use on web-only replicas). |
| `AIS_WORKER_AUTOMATION` / `AIS_WORKER_OUTBOX` / `AIS_WORKER_DATASOURCES` | no | `0` disables one worker. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | compose | Credentials for the `db` service; the app URL is built from them unless `DATABASE_URL` is set. |

`OLLAMA_BASE_URL` is **not** read by the app — configure AI endpoints per org in the UI. There is no
AI key in the environment and no proprietary AI SDK.

## 6. Database migration (SQLite → PostgreSQL)

The schema is portable: no Prisma enums, no native JSON columns, money is integer cents, no
DB-specific column types. There is **no automated data migration tool** in this build.

1. Provision an empty Postgres database.
2. Set `DATABASE_URL` and run `npx prisma db push` (the Docker image does this at boot).
3. Move data with the JSON export (`GET /api/admin/export`) plus a custom import script, or a
   purpose-written row-copy script. Validate counts and ledger balances afterward.
4. Keep the same `APP_SECRET`/`secret.key` if you want existing encrypted integration credentials to
   remain usable; otherwise plan to re-enter them.

RAG vectors stay JSON strings in either database. pgvector is not required and is not populated by
this build.

## 7. APP_SECRET rotation — read before rotating

**Rotating `APP_SECRET` does NOT re-encrypt stored secrets.** Ciphertexts in the database were
encrypted with the key derived from the old value; after rotation, decryption fails and integrations
and provider keys must be **re-entered** by an owner/admin.

If you rely on the generated `.data/secret.key` instead, keep that file backed up and mounted. Treat
key rotation as a credential re-entry exercise, not a drop-in env change.

## 8. Backups and restore

### SQLite

```bash
# In-app (owner/admin): POST /api/admin/backup → backups/backup-<timestamp>.db
# Copy it off-host from the app_backups volume.
docker compose -f docker-compose.sqlite.yml stop app
docker cp backup-YYYYMMDD.db "$(docker compose -f docker-compose.sqlite.yml ps -aq app)":/app/db/custom.db
docker compose -f docker-compose.sqlite.yml start app
curl -fsS http://localhost:3000/api/health/ready
```

Verify the restored install by logging in and checking counts/bookings before resuming traffic.

### PostgreSQL

```bash
# Use the real user/db names if you changed POSTGRES_USER/POSTGRES_DB.
docker compose exec -T db pg_dump -U ais ais > backup-$(date +%F-%H%M).sql

# Restore (destructive; take a fresh backup first):
docker compose stop app
docker compose exec -T db psql -U ais -d ais -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
docker compose exec -T db psql -U ais -d ais < backup-YYYY-MM-DD.sql
docker compose start app
curl -fsS http://localhost:3000/api/health/ready
```

### What to back up

| Item | Why |
|---|---|
| Database (SQLite file or `pg_dump`) | All business data, audit trail, outbox, knowledge |
| `APP_SECRET` or `.data/secret.key` | Decrypts provider keys and integration credentials |
| `app_models` volume (optional) | Avoids re-downloading the ONNX embedding model |
| `app_backups` volume | In-app SQLite snapshots |

Store backups encrypted, off-host, with a retention policy you have tested. The app does not ship a
scheduled backup job, so schedule the commands above (cron/systemd timer). Test a restore before
going live and after major upgrades.

## 9. Updating and rollback

```bash
cd infra
docker compose exec -T db pg_dump -U ais ais > pre-upgrade-$(date +%F).sql   # Postgres
cp .env ../.env.backup                                                       # keep secrets safe
git pull
docker compose up -d --build
docker compose logs -f app                                                   # watch schema + boot
curl -fsS http://localhost:3000/api/health/ready
```

- Boot applies only additive schema changes. A **destructive** change fails the boot by design
  (no `--accept-data-loss`). Restore the backup and apply a deliberate, reviewed migration.
- For rollback, check out the previous release tag/commit and rebuild. If the database already
  contains newer additive columns, the older code generally still runs; if a destructive migration
  was applied, restore the pre-upgrade database as well.
- Pin the repository tag and base image digest for reproducible production deployments.
- `docker compose down` keeps named volumes; `docker compose down -v` deletes them.

## 10. Health, monitoring and logs

| Endpoint | Auth | Semantics |
|---|---|---|
| `GET /api/health` | public | Liveness only: process is serving HTTP |
| `GET /api/health/ready` | public | Readiness: real DB `SELECT 1`; `503` if unavailable |
| `GET /api/health/detail` | session | DB tuning, worker leases, provider tests, heartbeat, counts |
| `GET /api/audit` | session | Latest audit events |
| Dashboard → Diagnostics | session | Human-readable view of the above |

Use `/api/health` for liveness and `/api/health/ready` for readiness. Alert on sustained readiness
failures, worker `lastError`, outbox backlog, and disk usage. Container logs go to stdout;
compose rotates them. No Prometheus/Grafana integration is bundled — point your existing monitoring
at the endpoints and logs.

## 11. Troubleshooting

| Symptom | Likely cause / action |
|---|---|
| `POSTGRES_PASSWORD` error on `docker compose up` | `infra/.env` missing or password not set; copy `.env.example` |
| App exits during boot | Check `docker compose logs app`; usually a DB connection error or a refused destructive schema change |
| `/api/health/ready` 503 | DB down/unreachable; check `docker compose ps`, credentials, `DATABASE_URL`, disk space |
| Login redirect loop | `NODE_ENV=production` requires HTTPS; proxy must forward cookies/host correctly |
| 429 after deployment | Check proxy forwarded headers; limits are per IP + path, per process |
| 409 `worker_busy` / `sync_busy` | A worker/tick is running; wait for it to finish or the lease TTL |
| Messages remain `queued` | No enabled channel, missing credentials, or provider error; inspect status reason |
| Twilio signature 403 | `PUBLIC_BASE_URL`/integration `publicBaseUrl` must exactly match the public webhook URL |
| Stripe webhook 400 | Wrong webhook secret or a proxy modifying the raw body |
| ONNX/embedding failure | First boot needs network access for the model; search degrades to lexical until fixed |

More detail: [ARCHITECTURE.md](./ARCHITECTURE.md), [INTEGRATIONS.md](./INTEGRATIONS.md),
[SECURITY.md](./SECURITY.md), [infra/README.md](../infra/README.md).

## 12. Zero telemetry

The app sends nothing anywhere by itself: no analytics, crash reporting, phone-home or update checks.
The only outbound requests are the ones you configure (AI endpoints, SMTP/Twilio/Stripe/CalDAV,
webhook destinations) plus the one-time ONNX embedding model download. Audit data stays in your
database.
