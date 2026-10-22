import fs from 'node:fs'
import path from 'node:path'
import { withAuth, json, fail } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { getDbTuning } from '@/lib/db-tuning'

/**
 * POST /api/admin/backup (owner/admin) — SQLite `VACUUM INTO` snapshot.
 * Writes to backups/backup-<ts>.db and returns the filename + real byte size.
 * Failures surface as honest 500s with the actual message (no secrets).
 */
export const POST = withAuth(
  async (req, ctx) => {
    try {
      const tuning = await getDbTuning()
      if (tuning && tuning.kind !== 'sqlite') {
        return fail(400, 'In-app backups use SQLite VACUUM INTO. On PostgreSQL use pg_dump (see docs/SELF_HOSTING.md).', { code: 'unsupported_database' })
      }

      const dir = path.join(process.cwd(), 'backups')
      await fs.promises.mkdir(dir, { recursive: true })
      const filename = `backup-${Date.now()}.db`
      const filePath = path.join(dir, filename)

      // VACUUM INTO fails if the target exists; the timestamp name keeps it unique.
      await db.$executeRawUnsafe(`VACUUM INTO '${filePath.replace(/'/g, "''")}'`)
      const bytes = fs.statSync(filePath).size

      await audit({
        orgId: ctx.org.id,
        actorType: 'user',
        actorId: ctx.user.id,
        action: 'admin.backup_created',
        entity: 'backup',
        entityId: filename,
        meta: { filename, bytes },
      })

      return json({ file: filename, bytes })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return fail(500, `Backup failed: ${message}`)
    }
  },
  { roles: ['owner', 'admin'] }
)
