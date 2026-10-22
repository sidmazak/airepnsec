import fs from 'node:fs'
import path from 'node:path'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { getDbTuning } from '@/lib/db-tuning'

/**
 * Scheduled database backups with a retention policy.
 *
 * The artifact is a full snapshot (every org, encrypted secrets included), so
 * the file is written with 0600 permissions and the caller is responsible for
 * shipping it off-site. The scheduler is per organization: the settings live in
 * `AppSetting` (`backup_schedule`), the worker checks them once an hour and
 * keeps only the newest N snapshots.
 */

export type BackupSchedule = {
  enabled: boolean
  /** Hour of day (0-23, server local time) the daily backup runs. */
  hour: number
  /** How many snapshots to keep. */
  retention: number
}

export const DEFAULT_BACKUP_SCHEDULE: BackupSchedule = { enabled: false, hour: 3, retention: 7 }

export const BACKUP_SETTING_KEY = 'backup_schedule'

export function backupDir(): string {
  return path.join(process.cwd(), 'backups')
}

export function parseSchedule(raw: string | null | undefined): BackupSchedule {
  if (!raw) return { ...DEFAULT_BACKUP_SCHEDULE }
  try {
    const parsed = JSON.parse(raw) as Partial<BackupSchedule>
    return {
      enabled: parsed.enabled === true,
      hour: Math.min(23, Math.max(0, Number(parsed.hour ?? DEFAULT_BACKUP_SCHEDULE.hour))),
      retention: Math.min(60, Math.max(1, Number(parsed.retention ?? DEFAULT_BACKUP_SCHEDULE.retention))),
    }
  } catch {
    return { ...DEFAULT_BACKUP_SCHEDULE }
  }
}

export type BackupFile = {
  filename: string
  bytes: number
  createdAt: string
}

export async function listBackups(): Promise<BackupFile[]> {
  const dir = backupDir()
  if (!fs.existsSync(dir)) return []
  const names = await fs.promises.readdir(dir)
  const files: BackupFile[] = []
  for (const name of names) {
    if (!name.startsWith('backup-') || !name.endsWith('.db')) continue
    try {
      const stat = await fs.promises.stat(path.join(dir, name))
      files.push({ filename: name, bytes: stat.size, createdAt: stat.mtime.toISOString() })
    } catch {
      /* the file vanished between readdir and stat */
    }
  }
  return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/**
 * Create a snapshot. Throws with the real reason when the database is not
 * SQLite (PostgreSQL must use pg_dump) or the write fails.
 */
export async function createBackup(orgId: string, actor: { type: 'user' | 'system'; id: string }): Promise<BackupFile> {
  const tuning = await getDbTuning()
  if (tuning && tuning.kind !== 'sqlite') {
    throw new Error('In-app backups use SQLite VACUUM INTO. On PostgreSQL use pg_dump (see docs/SELF_HOSTING.md).')
  }

  const dir = backupDir()
  await fs.promises.mkdir(dir, { recursive: true })
  const filename = `backup-${Date.now()}.db`
  const filePath = path.join(dir, filename)

  // VACUUM INTO fails if the target exists; the timestamp name keeps it unique.
  await db.$executeRawUnsafe(`VACUUM INTO '${filePath.replace(/'/g, "''")}'`)
  const bytes = fs.statSync(filePath).size
  // Read 0600: a backup contains every org's encrypted secrets and raw config.
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    /* not supported on every filesystem (Windows) */
  }

  await audit({
    orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'admin.backup_created',
    entity: 'backup',
    entityId: filename,
    meta: { filename, bytes },
  })

  return { filename, bytes, createdAt: new Date().toISOString() }
}

/** Delete the oldest snapshots beyond the retention count. */
export async function pruneBackups(retention: number): Promise<string[]> {
  const files = await listBackups()
  const keep = Math.max(1, retention)
  const excess = files.slice(keep)
  const removed: string[] = []
  for (const file of excess) {
    try {
      await fs.promises.unlink(path.join(backupDir(), file.filename))
      removed.push(file.filename)
    } catch {
      /* ignore: the file may already be gone */
    }
  }
  return removed
}

/**
 * Run the scheduled backup for one organization if it is due.
 * Returns null when nothing was due.
 */
export async function runScheduledBackupIfDue(orgId: string, now = new Date()): Promise<BackupFile | null> {
  const row = await db.appSetting.findFirst({ where: { orgId, key: BACKUP_SETTING_KEY }, select: { value: true } })
  const schedule = parseSchedule(row?.value)
  if (!schedule.enabled) return null

  // One snapshot per day, at (or after) the configured hour. The marker records
  // the day so a restart inside the same hour does not create a second backup.
  const dayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
  const markerKey = `backup_last_run`
  const marker = await db.appSetting.findFirst({ where: { orgId, key: markerKey }, select: { value: true } })
  if (marker?.value === dayKey) return null
  if (now.getHours() < schedule.hour) return null

  const file = await createBackup(orgId, { type: 'system', id: 'backup-worker' })
  const removed = await pruneBackups(schedule.retention)
  if (removed.length) {
    await audit({
      orgId,
      actorType: 'system',
      actorId: 'backup-worker',
      action: 'admin.backup_pruned',
      entity: 'backup',
      entityId: file.filename,
      meta: { removed, retention: schedule.retention },
    })
  }
  await db.appSetting.upsert({
    where: { orgId_key: { orgId, key: markerKey } },
    create: { orgId, key: markerKey, value: dayKey },
    update: { value: dayKey },
  })
  return file
}

/** Run the schedule for every organization that enabled it. */
export async function runBackupScheduler(now = new Date()): Promise<{ orgId: string; filename: string }[]> {
  const orgs = await db.organization.findMany({ select: { id: true } })
  const done: Array<{ orgId: string; filename: string }> = []
  for (const org of orgs) {
    try {
      const file = await runScheduledBackupIfDue(org.id, now)
      if (file) done.push({ orgId: org.id, filename: file.filename })
    } catch (err) {
      console.error('[backup] scheduled backup failed:', err instanceof Error ? err.message : err)
    }
  }
  return done
}
