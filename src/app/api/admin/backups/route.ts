import { withAuth, json, fail, parseBody } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { createBackup, listBackups, pruneBackups, parseSchedule, BACKUP_SETTING_KEY, DEFAULT_BACKUP_SCHEDULE } from '@/lib/backup'

/**
 * GET /api/admin/backups (owner/admin) — the snapshots on disk plus the
 * retention policy. POST runs a snapshot now, DELETE prunes old ones.
 */
export const GET = withAuth(async (_req, ctx) => {
  const setting = await db.appSetting.findFirst({ where: { orgId: ctx.org.id, key: BACKUP_SETTING_KEY }, select: { value: true } })
  const files = await listBackups()
  return json({ backups: files, schedule: parseSchedule(setting?.value) })
}, { roles: ['owner', 'admin'] })

/** POST /api/admin/backups — take a snapshot now and apply the retention policy. */
export const POST = withAuth(async (_req, ctx) => {
  try {
    const file = await createBackup(ctx.org.id, { type: 'user', id: ctx.user.id })
    const setting = await db.appSetting.findFirst({ where: { orgId: ctx.org.id, key: BACKUP_SETTING_KEY }, select: { value: true } })
    const schedule = parseSchedule(setting?.value)
    const removed = await pruneBackups(schedule.retention)
    return json({ file, removed }, 201)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return fail(500, `Backup failed: ${message}`)
  }
}, { roles: ['owner', 'admin'] })
