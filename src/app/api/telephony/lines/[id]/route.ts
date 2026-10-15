import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { withAuth, json, parseBody } from '@/lib/api'
import { z } from 'zod'

const patchSchema = z.object({
  label: z.string().min(1).optional(),
  phoneNumber: z.string().min(4).optional(),
  destinationKind: z.string().optional(),
  destinationValue: z.string().optional(),
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
  acceptingCalls: z.boolean().optional(),
})

export const PATCH = withAuth(async (req, ctx, params) => {
  const data = await parseBody(req, patchSchema)
  const existing = await db.telephonyLine.findFirst({ where: { id: params.id, orgId: ctx.org.id } })
  if (!existing) return json({ error: 'not_found' }, 404)
  const row = await db.telephonyLine.update({ where: { id: params.id }, data })
  return json(row)
}, { roles: ['owner', 'admin'] })

export const DELETE = withAuth(async (_req, ctx, params) => {
  const existing = await db.telephonyLine.findFirst({ where: { id: params.id, orgId: ctx.org.id } })
  if (!existing) return json({ error: 'not_found' }, 404)
  await db.telephonyLine.delete({ where: { id: params.id } })
  return json({ ok: true })
}, { roles: ['owner', 'admin'] })
