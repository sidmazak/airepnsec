# infra/ — self-host packaging

Files for running AI Secretary as a self-hosted service. **Honest note: this
packaging is delivered but not verified inside the build sandbox (no Docker
daemon); verify on your host before relying on it** — see "Smoke test" below.

| File | What it is |
|---|---|
| `Dockerfile` | Multi-stage build: `oven/bun:1` build stage (`bun install --frozen-lockfile` → `bunx prisma generate` → `bun run build`, which emits the Next.js standalone output) + `oven/bun:1-slim` runtime carrying the standalone server, the Prisma CLI and writable dirs (`db/`, `.data/`, `backups/`, `.models/`). `CMD` runs `bunx prisma db push` against `DATABASE_URL`, then `bun .next/standalone/server.js`. |
| `docker-compose.yml` | Two services: `app` (this Dockerfile, port 3000, volumes for `.data` / `backups` / `.models`) and `db` (`pgvector/pgvector:pg16` with `pg_isready` healthcheck + `pgdata` volume). Both `restart: unless-stopped`. Postgres+pgvector is the production target; set `DATABASE_URL` accordingly — the SQLite dev database is used when `DATABASE_URL=file:…`. |
| `.env.example` | Environment template. Copy to `infra/.env`; no real secrets inside. |

## Quick start

```bash
cd infra
cp .env.example .env      # edit POSTGRES_PASSWORD / APP_SECRET
docker compose up -d --build
# → http://localhost:3000 (first boot creates the owner account)
```

`docker compose logs -f app` shows the Prisma push + server start lines.

## Backups / restore

- In-app: `POST /api/admin/backup` (owner/admin) writes a SQLite `VACUUM INTO`
  snapshot into the `app_backups` volume (`backups/` in the container). On
  Postgres use `pg_dump` on the `db` service instead:
  `docker compose exec db pg_dump -U ais ais > backup.sql`.
- `GET /api/admin/export` (owner/admin) produces a secrets-free JSON export of
  org data.

## Smoke test (run on your host)

1. `docker compose up -d --build` → `docker compose ps` shows `app` and `db` healthy.
2. `curl -s localhost:3000/api/health` → `{"ok":true,...}`.
3. `curl -s localhost:3000/api/health/detail` (after signing in) shows `db` ok.
4. Log in, create the owner account, run the setup wizard's end-to-end test.

If the standalone bundle is missing native modules (`onnxruntime-node`,
`sharp`, `@huggingface/transformers` are marked `serverExternalPackages` and
traced into the output), report it — the fallback is honest degradation to
lexical search, but it should not be needed.

## Known unverified risks

- `bunx prisma db push` at container start relies on the copied `node_modules/prisma`
  + `node_modules/@prisma` (CLI + engines) — confirm it resolves on your arch.
- The ONNX embedding model downloads into the `app_models` volume on first boot
  (needs outbound network at that moment; afterwards zero egress).
- No reverse proxy in this compose file — put Caddy/nginx in front for TLS (see
  [docs/SELF_HOSTING.md](../docs/SELF_HOSTING.md)).
