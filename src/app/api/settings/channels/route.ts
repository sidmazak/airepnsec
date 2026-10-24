import { withAuth, json } from '@/lib/api'
import { getChannelReadiness } from '@/lib/integrations/readiness'

/**
 * GET /api/settings/channels — live readiness computed from the enabled,
 * configured integrations. There is no writable channel toggle: to turn a
 * channel on, enable the corresponding integration (SMTP, Twilio, IMAP, …).
 */
export const GET = withAuth(async (_req, ctx) => {
  return json({ channels: await getChannelReadiness(ctx.org.id) })
})
