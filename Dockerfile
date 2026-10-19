# AI Secretary — self-hosted production image.
# SQLite by default (volume at /app/db); point DATABASE_URL at Postgres instead if you prefer.

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Build-time placeholders (inline, never persisted) — real values are supplied at runtime.
RUN npx prisma generate && DATABASE_URL="file:/app/db/build.db" APP_SECRET="build-time-placeholder-not-used-at-runtime" npm run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
# Defaults work out of the box with the /app/db volume; override for Postgres.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 DATABASE_URL=file:/app/db/custom.db
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
RUN mkdir -p /app/db /app/.data
EXPOSE 3000
# Apply the schema (idempotent) then serve. Set APP_SECRET and PUBLIC_BASE_URL in the environment.
CMD ["sh", "-c", "npx prisma db push --accept-data-loss --skip-generate && npm start"]
