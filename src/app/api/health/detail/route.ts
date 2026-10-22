import { withAuth, json } from '@/lib/api'
import { db } from '@/lib/db'
import { getServerKey } from '@/lib/crypto'
import { workerHeartbeat } from '@/lib/automation/engine'
import { getWorkerStatuses } from '@/lib/concurrency'
import { getDbTuning } from '@/lib/db-tuning'

/**
 * GET /api/health/detail — real diagnostics only, every value is honestly measured:
 * database round-trip, server key presence, webhook secret, automation worker
 * heartbeat, provider states, and record counts.
 */
export const GET = withAuth(async (req, ctx) => {
  const orgId = ctx.org.id

  let dbOk = true
  try {
    await db.$queryRaw`SELECT 1`
  } catch {
    dbOk = false
  }

  let encryptionKey = false
  try {
    encryptionKey = getServerKey().length > 0
  } catch {
    encryptionKey = false
  }

  const [secretRow, heartbeat, llmRow, embeddingRow, customers, bookings, invoices, conversations, outboxQueued, workers] =
    await Promise.all([
      db.appSetting.findUnique({ where: { orgId_key: { orgId, key: 'webhook_secret' } }, select: { id: true } }),
      workerHeartbeat(orgId),
      db.providerConfig.findUnique({ where: { orgId_capability: { orgId, capability: 'llm' } } }),
      db.providerConfig.findUnique({ where: { orgId_capability: { orgId, capability: 'embedding' } } }),
      db.customer.count({ where: { orgId } }),
      db.booking.count({ where: { orgId } }),
      db.invoice.count({ where: { orgId } }),
      db.conversation.count({ where: { orgId } }),
      db.outboxMessage.count({ where: { orgId, status: 'queued' } }),
      getWorkerStatuses(),
    ])

  return json({
    db: dbOk,
    database: await getDbTuning(),
    encryptionKey,
    webhookSecret: Boolean(secretRow),
    workerHeartbeat: heartbeat,
    workers,
    providers: {
      llm: {
        provider: llmRow?.provider ?? 'not_configured',
        enabled: llmRow?.enabled ?? false,
        lastTestOk: llmRow?.lastTestOk ?? false,
      },
      embedding: {
        provider: embeddingRow?.provider ?? 'not_configured',
        enabled: embeddingRow?.enabled ?? false,
        lastTestOk: embeddingRow?.lastTestOk ?? false,
      },
    },
    counts: { customers, bookings, invoices, conversations, outboxQueued },
    dataMode: ctx.org.dataMode,
  })
})
