import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { withAuth, json, parseBody } from '@/lib/api'
import { z } from 'zod'

const createSchema = z.object({
  label: z.string().min(1),
  phoneNumber: z.string().min(4),
  destinationKind: z.string().optional(),
  destinationValue: z.string().optional(),
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
  acceptingCalls: z.boolean().optional(),
  integrationId: z.string().optional(),
})

export const GET = withAuth(async (_req, ctx) => {
  const rows = await db.telephonyLine.findMany({ where: { orgId: ctx.org.id }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] })
  return json({ lines: rows })
}, { roles: ['owner', 'admin', 'viewer'] })

export const POST = withAuth(async (req, ctx) => {
  const data = await parseBody(req, createSchema)
  const row = await db.telephonyLine.create({
    data: {
      orgId: ctx.org.id,
      integrationId: data.integrationId ?? '',
      label: data.label,
      phoneNumber: data.phoneNumber,
      destinationKind: data.destinationKind ?? 'phone',
      destinationValue: data.destinationValue ?? data.phoneNumber,
      priority: data.priority ?? 100,
      enabled: data.enabled ?? true,
      acceptingCalls: data.acceptingCalls ?? true,
    },
  })
  return json(row, 201)
}, { roles: ['owner', 'admin'] })
