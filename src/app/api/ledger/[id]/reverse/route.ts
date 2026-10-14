import { z } from 'zod'
import { withAuth, json, parseBody } from '@/lib/api'
import { reverseEntry } from '@/lib/business/ledger'

const schema = z.object({
  memo: z.string().trim().max(500).optional(),
})

/**
 * POST /api/ledger/[id]/reverse {memo?} (owner/admin)
 * Posts an equal-and-opposite reversal entry; originals are never mutated.
 */
export const POST = withAuth(
  async (req, ctx, params) => {
    const body = await parseBody(req, schema)
    const reversal = await reverseEntry(ctx.org.id, params.id, { type: 'user', id: ctx.user.id }, body.memo)
    return json({ entry: reversal }, 201)
  },
  { roles: ['owner', 'admin'] }
)
