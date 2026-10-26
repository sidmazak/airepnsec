import { PrismaClient } from '@prisma/client'

// Dev hot-reload support: when `prisma db push`/`generate` adds models to the
// generated client while the dev server keeps running, the module cache still
// serves the OLD client class. We version the global key and, in dev, rebuild
// the singleton from a freshly required @prisma/client when the key changes.
// Bump PRISMA_GLOBAL_VERSION whenever the schema gains new models at runtime.
const PRISMA_GLOBAL_VERSION = 8 // v8: Organization.receptionistSchedule for receptionist scheduling
const LEGACY_KEYS = ['prisma', '__aisPrisma_v2', '__aisPrisma_v3', '__aisPrisma_v4', '__aisPrisma_v5', '__aisPrisma_v6', '__aisPrisma_v7'] // stale class instances

const globalForPrisma = globalThis as unknown as Record<string, PrismaClient | undefined>

function buildClient(): PrismaClient {
  if (process.env.NODE_ENV === 'production') {
    return new PrismaClient({ log: ['error', 'warn'] })
  }
  try {
    // Server-side dynamic require bypasses the bundler's cached copy of the
    // generated client so a db push during a running dev session is picked up.
    const nodeRequire = eval('require') as NodeRequire
    for (const id of Object.keys(nodeRequire.cache)) {
      if (id.includes('node_modules/@prisma/client') || id.includes('node_modules/.prisma/client')) {
        delete nodeRequire.cache[id]
      }
    }
    const Fresh = nodeRequire('@prisma/client').PrismaClient as typeof PrismaClient
    return new Fresh({ log: ['error', 'warn'] })
  } catch {
    return new PrismaClient({ log: ['error', 'warn'] })
  }
}

function currentGlobal(): PrismaClient | undefined {
  return globalForPrisma[`__aisPrisma_v${PRISMA_GLOBAL_VERSION}`]
}

function createClient(): PrismaClient {
  // Drop legacy singletons so their engines do not linger (dev convenience only).
  for (const key of LEGACY_KEYS) {
    const legacy = globalForPrisma[key]
    if (legacy && legacy !== globalForPrisma[`__aisPrisma_v${PRISMA_GLOBAL_VERSION}`]) {
      void legacy.$disconnect().catch(() => undefined)
    }
    delete globalForPrisma[key]
  }
  const client = buildClient()
  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma[`__aisPrisma_v${PRISMA_GLOBAL_VERSION}`] = client
  }
  return client
}

export const db = currentGlobal() ?? createClient()
