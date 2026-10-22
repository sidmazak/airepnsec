# infra/ — self-host packaging

Docker and reverse-proxy assets for running AI Secretary as a self-hosted service. Both the
PostgreSQL and SQLite Compose profiles were built and smoke-tested on 2026-10-22 (healthy services,
schema boot, demo seed, login, readiness, ONNX embeddings, backups, SSRF blocking). Re-run the smoke
test after upgrading.

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage `node:24-bookworm-slim` build → Next.js standalone runtime with Prisma CLI/engines, OpenSSL, writable `db/`, `.data/`, `backups/`, `.models/`. Boots with additive-only `prisma db push` and a readiness healthcheck. |
| `docker-compose.yml` | App + `pgvector/pgvector:pg16` (Postgres is the production target). Required DB password, healthy dependency gating, restart policy, log rotation, graceful stop. |
| `docker-compose.sqlite.yml` | Single-container SQLite profile for one-box installs. Never run multiple replicas against one SQLite file. |
| `.env.example` | Compose environment template; copy to `.env` and set strong values. |
| `Caddyfile.example` | TLS reverse proxy example with bounded timeouts and forwarded headers. |

Full deployment guide: [docs/SELF_HOSTING.md](../docs/SELF_HOSTING.md).

## Quick start

```bash
cd infra
cp .env.example .env
# set POSTGRES_PASSWORD and APP_SECRET:
#   openssl rand -hex 24   (POSTGRES_PASSWORD)
#   openssl rand -hex 32   (APP_SECRET)
docker compose up -d --build
docker compose ps
curl -fsS http://localhost:3000/api/health/ready
```

SQLite profile:

```bash
cd infra
cp .env.example .env       # set APP_SECRET; POSTGRES_* unused
docker compose -f docker-compose.sqlite.yml up -d --build
```

Open `http://localhost:3000`, create the owner account, and complete the setup wizard. Put TLS in
front before real use; do not expose port 3000 publicly.

## Health and operations

- Liveness: `GET /api/health` (no DB access).
- Readiness: `GET /api/health/ready` (real DB query; `503` if unavailable). The image's Docker
  `HEALTHCHECK` uses this endpoint.
- Diagnostics after sign-in: `GET /api/health/detail` (DB tuning, worker leases, provider tests,
  counts).
- Logs: `docker compose logs -f app`; Docker log rotation is configured (10 MB × 3).
- Workers: lease-protected and safe across replicas. On web-only replicas set
  `AIS_DISABLE_WORKERS=1`; run one worker-enabled instance. `409 worker_busy`/`sync_busy` means a
  tick is already running.
- Graceful shutdown: `init: true` + `stop_grace_period` are set; the process receives SIGTERM.

## Schema changes and rollback

The container runs `prisma db push --skip-generate` (additive changes only). It deliberately does
**not** pass `--accept-data-loss`; a destructive schema change fails the boot instead of dropping
data. Back up first and apply any breaking change deliberately:

```bash
docker compose exec -T db pg_dump -U ais ais > pre-upgrade.sql
```

Roll back by checking out the previous tag/commit and rebuilding. Restore the pre-upgrade database if
a destructive change was applied.

## Backups / restore

- SQLite: `POST /api/admin/backup` (owner/admin) writes a `VACUUM INTO` snapshot into the
  `app_backups` volume. Restore by stopping the app, copying the file back to the `app_db` volume,
  and starting it. Details in [docs/SELF_HOSTING.md](../docs/SELF_HOSTING.md#8-backups-and-restore).
- PostgreSQL: `docker compose exec -T db pg_dump -U ais ais > backup.sql`; restore with `psql` after
  stopping the app.
- JSON export: `GET /api/admin/export` (owner/admin) — secrets-free business data.
- **Back up the encryption key** (`APP_SECRET` or `app_data/secret.key`) with the database; without it,
  stored integration/provider credentials cannot be decrypted.
- No scheduled backup job is shipped — schedule and test one.

## Smoke test (run on your host)

1. `docker compose up -d --build` → `docker compose ps` shows `app` and `db` healthy.
2. `curl -s localhost:3000/api/health` → `{"ok":true,...}`.
3. `curl -s localhost:3000/api/health/ready` → `{"ok":true,"db":"ok",...}`.
4. Sign in, create the owner account, run the setup wizard's end-to-end test.
5. Configure one optional integration and use its **Test** button; confirm no secret is returned.
6. Trigger an admin backup and copy it off-host.

## Known unverified risks

- `prisma db push` at container start relies on the copied `node_modules/prisma` + `node_modules/@prisma`
  CLI/engines — confirm they resolve on your architecture.
- The ONNX embedding model downloads into `app_models` on first boot (needs outbound network then;
  afterwards it is cached).
- The ONNX native module must be present in the standalone trace on your platform; if it fails, search
  degrades honestly to lexical scoring. Verify diagnostics after first boot.
- Compose TLS is not included; use Caddy/nginx (example provided) and keep the app port private.
- Re-run the smoke test after upgrades; provider credentials and reverse-proxy TLS remain your
  responsibility.
