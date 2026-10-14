import { z } from 'zod'
import { withAuth, json, fail, parseBody } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { parseJson } from '@/lib/org'

export type SetupStepState = { done: boolean; savedAt: string }

/** GET /api/setup → current wizard state + org profile */
export const GET = withAuth(async (req, ctx) => {
  const org = await db.organization.findUnique({ where: { id: ctx.org.id } })
  if (!org) return fail(404, 'Organization not found', { code: 'not_found' })
  return json({
    state: parseJson<Record<string, SetupStepState>>(org.setupState, {}),
    org,
  })
})

const DATA_MODES = ['local_only', 'hybrid', 'cloud_first'] as const

const putSchema = z.object({
  step: z.string().min(1).max(64),
  data: z.record(z.string(), z.unknown()).default({}),
})

/**
 * PUT /api/setup {step, data}
 * Marks the step done in setupState and applies whitelisted business fields
 * from `data` onto the organization row. JSON-typed columns are stringified.
 */
export const PUT = withAuth(
  async (req, ctx) => {
    const body = await parseBody(req, putSchema)
    const org = await db.organization.findUnique({ where: { id: ctx.org.id } })
    if (!org) return fail(404, 'Organization not found', { code: 'not_found' })

    const d = body.data
    const orgData: Partial<{
      name: string
      businessType: string
      timezone: string
      locale: string
      currency: string
      address: string
      phone: string
      email: string
      openingHours: string
      holidays: string
      policies: string
      aiIdentity: string
      collectionsCfg: string
      dataMode: string
    }> = {}
    const applied: string[] = []

    if (typeof d.name === 'string' && d.name.trim()) {
      orgData.name = d.name.trim().slice(0, 200)
      applied.push('name')
    }
    const scalarKeys = ['businessType', 'timezone', 'locale', 'currency', 'address', 'phone', 'email'] as const
    for (const key of scalarKeys) {
      const v = d[key]
      if (typeof v === 'string') {
        orgData[key] = v.trim().slice(0, 1000)
        applied.push(key)
      }
    }
    // JSON columns are stored as serialized strings
    const jsonKeys = ['openingHours', 'policies', 'aiIdentity', 'collectionsCfg'] as const
    for (const key of jsonKeys) {
      const v = d[key]
      if (v !== undefined && v !== null && typeof v === 'object' && !Array.isArray(v)) {
        orgData[key] = JSON.stringify(v)
        applied.push(key)
      }
    }
    if (Array.isArray(d.holidays)) {
      orgData.holidays = JSON.stringify(d.holidays.filter((x): x is string => typeof x === 'string'))
      applied.push('holidays')
    }
    if (typeof d.dataMode === 'string' && (DATA_MODES as readonly string[]).includes(d.dataMode)) {
      orgData.dataMode = d.dataMode
      applied.push('dataMode')
    }

    const state = parseJson<Record<string, SetupStepState>>(org.setupState, {})
    state[body.step] = { done: true, savedAt: new Date().toISOString() }

    const updated = await db.organization.update({
      where: { id: org.id },
      data: { ...orgData, setupState: JSON.stringify(state) },
    })

    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'setup.step_saved',
      entity: 'organization',
      entityId: org.id,
      meta: { step: body.step, applied },
    })

    return json({
      state: parseJson<Record<string, SetupStepState>>(updated.setupState, {}),
      org: updated,
    })
  },
  { roles: ['owner', 'admin'] }
)
