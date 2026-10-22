# infra/Dockerfile — AI Secretary (self-host packaging)
#
# Stage 1 builds the Next.js standalone bundle with Node.js + npm.
# Stage 2 is a slim runtime that carries the standalone output, the Prisma CLI
# (for `db push` at container start) and the SQLite data dir.
#
# DATABASE_PROVIDER selects the Prisma provider at BUILD time (the schema is the
# single source of truth and defaults to SQLite):
#   - sqlite       → file:/app/db/custom.db (default; no other services needed)
#   - postgresql   → postgresql://user:pass@host:5432 (see infra/docker-compose.yml)
# DATABASE_URL decides the actual connection at RUNTIME.
#
# Both SQLite and PostgreSQL variants are built and smoke-tested (2026-10-22).
# Rebuild and re-run the smoke test (infra/README.md) when upgrading.

# ---------------------------------------------------------------- stage 1: build
FROM node:24-bookworm-slim AS build
WORKDIR /app

ARG DATABASE_PROVIDER=sqlite

# Install dependencies first (cached layer), then the rest of the source.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY prisma ./prisma
COPY src ./src
COPY public ./public
COPY next.config.ts tsconfig.json tailwind.config.ts postcss.config.mjs eslint.config.mjs ./

# Prisma bakes the provider into the generated client, so switch the schema before
# `prisma generate` when building the Postgres variant of the image.
RUN if [ "$DATABASE_PROVIDER" = "postgresql" ]; then \
      sed -i 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma && \
      grep -q 'provider = "postgresql"' prisma/schema.prisma; \
    elif [ "$DATABASE_PROVIDER" != "sqlite" ]; then \
      echo "DATABASE_PROVIDER must be sqlite or postgresql" >&2; exit 1; \
    fi

RUN npx prisma generate

# Build with throwaway values; real secrets/connection strings are supplied at runtime.
# `next build` does not copy .next/static or public into the standalone bundle, so the
# runtime stage copies them explicitly (see below).
RUN NEXT_TELEMETRY_DISABLED=1 \
    APP_SECRET="build-time-placeholder-not-used-at-runtime" \
    DATABASE_URL="$([ "$DATABASE_PROVIDER" = "postgresql" ] && echo 'postgresql://build:build@localhost:5432/build' || echo 'file:/app/db/build.db')" \
    npm run build

# --------------------------------------------------------------- stage 2: runtime
FROM node:24-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# SQLite default — override with a postgresql:// URL in production (compose does this).
ENV DATABASE_URL=file:/app/db/custom.db

# The standalone output is self-contained (server.js + traced node_modules). Next does
# NOT copy static assets or public/ into .next/standalone during build — do it here or
# the container serves a broken UI with 404s for /_next/static/*.
COPY --from=build /app/.next/standalone ./.next/standalone
COPY --from=build /app/.next/static ./.next/standalone/.next/static
COPY --from=build /app/public ./.next/standalone/public

# Prisma CLI + engines for `db push` at container start (schema + generated client).
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/prisma ./node_modules/prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
# `@huggingface/transformers` loads onnxruntime-node dynamically, so Next's static
# trace does not include it. Copy it next to the traced transformers package and
# drop non-Linux binaries to keep the image size sane.
COPY --from=build /app/node_modules/onnxruntime-node ./.next/standalone/node_modules/onnxruntime-node
# Transformers traces only the ESM build of onnxruntime-common; onnxruntime-node
# requires its CJS entrypoint, so copy the complete package over the traced one.
COPY --from=build /app/node_modules/onnxruntime-common ./.next/standalone/node_modules/onnxruntime-common
COPY --from=build /app/package.json ./package.json

# Prisma's migration engine needs OpenSSL; the slim image does not always include it.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# Directories the app writes to:
#   db/       SQLite database file (only used when DATABASE_URL=file:…)
#   .data/    server-held key file (secret.key) when APP_SECRET is unset
#   backups/  POST /api/admin/backup snapshots (SQLite VACUUM INTO)
#   .models/  local embedding model cache (ONNX MiniLM, downloaded on first boot)
RUN mkdir -p /app/db /app/.data /app/backups /app/.models
RUN rm -rf .next/standalone/node_modules/onnxruntime-node/bin/napi-v6/darwin .next/standalone/node_modules/onnxruntime-node/bin/napi-v6/win32

EXPOSE 3000

# Apply additive schema changes, then start the server. We deliberately do NOT
# pass --accept-data-loss: a destructive schema change must fail the boot and be
# handled deliberately by an operator (backup first), never silently drop data.
CMD ["sh", "-c", "node ./node_modules/prisma/build/index.js db push --skip-generate && exec node .next/standalone/server.js"]

# Readiness (includes a real DB round-trip) for docker/compose/K8s probes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
