import { z } from 'zod'
import { withAuth, json, fail, parseBody, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { BACKUP_SETTING_KEY, DEFAULT_BACKUP_SCHEDULE } from '@/lib/backup'

const schema = z.object({
  enabled: z.boolean(),
  hour: z.number().int().min(0).max(23),
  retention: z.number().int().min(1).max(60),
})

/**
 * PUT /api/admin/backups/schedule — configure the automatic daily backup.
 * The worker checks once an hour and keeps only the newest N snapshots.
 */
export const PUT = withAuth(async (req, ctx) => {
  let body: z.infer<typeof schema>
  try {
    body = await parseBody(req, schema)
  } catch (err) {
    if (err instanceof ApiError) return fail(err.status, err.message, { code: err.code })
    return fail(400, 'Invalid request body', { code: 'bad_request' })
  }

  await db.appSetting.upsert({
    where: { orgId_key: { orgId: ctx.org.id, key: BACKUP_SETTING_KEY } },
    create: { orgId: ctx.org.id, key: BACKUP_SETTING_KEY, value: JSON.stringify(body) },
    update: { value: JSON.stringify(body) },
  })

  await audit({
    orgId: ctx.org.id,
    actorType: 'user',
    actorId: ctx.user.id,
    action: 'admin.backup_schedule_updated',
    entity: 'backup',
    entityId: BACKUP_SETTING_KEY,
    meta: body,
  })

  return json({ schedule: { ...DEFAULT_BACKUP_SCHEDULE, ...body } })
}, { roles: ['owner', 'admin'] })
