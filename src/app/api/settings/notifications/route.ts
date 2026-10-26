import { z } from 'zod'
import { withAuth, json, parseBody } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { getSetting, setSetting } from '@/lib/org'
import {
  CUSTOMER_EVENTS, DEFAULT_NOTIFICATION_CONFIG, NOTIFICATION_CHANNELS, NOTIFICATION_SETTING_KEY,
  STAFF_EVENTS, eventLabel, normalizeNotificationConfig,
} from '@/lib/notifications/policy'

const ruleSchema = z.object({
  enabled: z.boolean(),
  channels: z.array(z.enum(NOTIFICATION_CHANNELS)).max(NOTIFICATION_CHANNELS.length),
})

const configSchema = z.object({
  customer: z.object({
    service: ruleSchema, booking: ruleSchema, invoice: ruleSchema, reminder: ruleSchema, marketing: ruleSchema,
  }),
  staff: z.object({
    missed_call: ruleSchema, voicemail: ruleSchema, escalation: ruleSchema, integration_failure: ruleSchema,
  }),
  quietHours: z.object({
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM'),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM'),
  }),
  consent: z.object({
    requireForMarketing: z.boolean(),
    requireForReminders: z.boolean(),
  }),
})

export const GET = withAuth(async (_req, ctx) => {
  const stored = await getSetting<unknown>(ctx.org.id, NOTIFICATION_SETTING_KEY, null)
  const config = normalizeNotificationConfig(stored)
  return json({
    config,
    defaults: DEFAULT_NOTIFICATION_CONFIG,
    channels: NOTIFICATION_CHANNELS,
    customerEvents: CUSTOMER_EVENTS.map((id) => ({ id, label: eventLabel(id) })),
    staffEvents: STAFF_EVENTS.map((id) => ({ id, label: eventLabel(id) })),
  })
})

export const PUT = withAuth(
  async (req, ctx) => {
    const body = await parseBody(req, configSchema)
    const config = normalizeNotificationConfig(body)
    await setSetting(ctx.org.id, NOTIFICATION_SETTING_KEY, config)
    await audit({
      orgId: ctx.org.id, actorType: 'user', actorId: ctx.user.id,
      action: 'settings.notifications_changed', entity: 'organization', entityId: ctx.org.id,
      meta: {
        customer: Object.fromEntries(CUSTOMER_EVENTS.map((event) => [event, config.customer[event].enabled])),
        staff: Object.fromEntries(STAFF_EVENTS.map((event) => [event, config.staff[event].enabled])),
      },
    })
    const row = await db.appSetting.findUnique({ where: { orgId_key: { orgId: ctx.org.id, key: NOTIFICATION_SETTING_KEY } }, select: { updatedAt: true } })
    return json({ config, savedAt: row?.updatedAt ?? new Date() })
  },
  { roles: ['owner', 'admin'] }
)
