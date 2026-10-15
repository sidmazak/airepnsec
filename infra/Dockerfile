# infra/Dockerfile — AI Secretary (self-host packaging)
#
# Stage 1 builds the Next.js standalone bundle with Node.js + npm.
# Stage 2 is a slim runtime that carries the standalone output, the Prisma CLI
# (for `db push` at container start) and the SQLite data dir.
#
# DATABASE_URL decides the database:
#   - file:/app/db/custom.db            → SQLite (dev/default; no other services needed)
#   - postgresql://user:pass@host:5432  → PostgreSQL (production target; see infra/docker-compose.yml)
#
# NOTE (honest): this Dockerfile is delivered but NOT verified inside the build
# sandbox (no Docker daemon). Run a smoke test on your host before relying on it
# (see infra/README.md).

# ---------------------------------------------------------------- stage 1: build
FROM node:24-bookworm-slim AS build
WORKDIR /app

# Install dependencies first (cached layer), then the rest of the source.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY prisma ./prisma
COPY src ./src
COPY public ./public
COPY next.config.ts tsconfig.json tailwind.config.ts postcss.config.mjs eslint.config.mjs ./

RUN npx prisma generate

# `build` script = `next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/`
# (output: "standalone" in next.config.ts — static assets and public/ end up inside .next/standalone)
RUN npm run build

# --------------------------------------------------------------- stage 2: runtime
FROM node:24-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# SQLite default — override with a postgresql:// URL in production (compose does this).
ENV DATABASE_URL=file:/app/db/custom.db

# The standalone output is self-contained (server.js + traced node_modules + static + public).
COPY --from=build /app/.next/standalone ./.next/standalone

# Prisma CLI + engines for `db push` at container start (schema + generated client).
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/prisma ./node_modules/prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/package.json ./package.json

# Directories the app writes to:
#   db/       SQLite database file (only used when DATABASE_URL=file:…)
#   .data/    server-held key file (secret.key) when APP_SECRET is unset
#   backups/  POST /api/admin/backup snapshots (SQLite VACUUM INTO)
#   .models/  local embedding model cache (ONNX MiniLM, downloaded on first boot)
RUN mkdir -p /app/db /app/.data /app/backups /app/.models

EXPOSE 3000

# Apply the portable schema to the configured DATABASE_URL, then start the server.
# --accept-data-loss matches the repo's `db:push` convention; with an empty volume
# on first boot this is a no-op. Prisma's interactive prompt cannot run in CMD.
CMD ["sh", "-c", "node ./node_modules/prisma/build/index.js db push --accept-data-loss --skip-generate && exec node .next/standalone/server.js"]
