import { db } from '@/lib/db'

/** Count outbox messages related to an entity — used by actions and diagnostics. */
export async function outboxCountFor(orgId: string, relatedType: string, relatedId: string): Promise<number> {
  return db.outboxMessage.count({ where: { orgId, relatedType, relatedId } })
}
