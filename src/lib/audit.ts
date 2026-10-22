import { db } from '@/lib/db'

export type AuditInput = {
  orgId: string
  actorType?: 'user' | 'ai' | 'system' | 'webhook' | 'scim'
  actorId?: string
  action: string
  entity?: string
  entityId?: string
  meta?: Record<string, unknown>
}

/** Append-only audit trail for consequential actions. Never throws. */
export async function audit(input: AuditInput): Promise<void> {
  try {
    await db.auditEvent.create({
      data: {
        orgId: input.orgId,
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? '',
        action: input.action,
        entity: input.entity ?? '',
        entityId: input.entityId ?? '',
        meta: JSON.stringify(input.meta ?? {}),
      },
    })
  } catch (err) {
    console.error('[audit] failed to record event', input.action, err instanceof Error ? err.message : err)
  }
}
