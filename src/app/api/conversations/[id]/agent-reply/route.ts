import { z } from 'zod'
import { withAuth, json, fail, parseBody } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { getEnabledSmsSender, sendOrgSms } from '@/lib/integrations/connectors'

const replySchema = z.object({
  content: z.string().trim().min(1, 'Message content is required').max(4000),
})

type Delivery = { delivered: boolean; queued?: boolean; reason?: string }

/**
 * POST /api/conversations/[id]/agent-reply {content}
 * Human agent message. Persisted first, then delivered to the customer when the
 * channel supports outbound (SMS). Delivery status is returned honestly:
 * delivered ≠ queued in the outbox ≠ failed. If the conversation was waiting for
 * a human it flips back to open (the human has taken over).
 */
export const POST = withAuth(async (req, ctx, params) => {
  const body = await parseBody(req, replySchema)

  const conversation = await db.conversation.findFirst({
    where: { id: params.id, orgId: ctx.org.id },
  })
  if (!conversation) return fail(404, 'Conversation not found', { code: 'not_found' })

  const message = await db.message.create({
    data: {
      conversationId: conversation.id,
      orgId: ctx.org.id,
      role: 'agent',
      content: body.content,
    },
  })

  let delivery: Delivery = { delivered: false, reason: `channel "${conversation.channel}" has no outbound delivery` }
  if (conversation.channel === 'sms') {
    const to = (conversation.externalRef ?? '').replace(/^sms:/, '')
    if (!to) {
      delivery = { delivered: false, reason: 'conversation has no SMS sender number on file' }
    } else {
      const customer = conversation.customerId
        ? await db.customer.findFirst({ where: { id: conversation.customerId, orgId: ctx.org.id } })
        : null
      if (customer?.optOut) {
        delivery = { delivered: false, reason: 'customer opted out of SMS' }
      } else {
        const sender = await getEnabledSmsSender(ctx.org.id)
        if (!sender) {
          await db.outboxMessage.create({
            data: {
              orgId: ctx.org.id, channel: 'sms', recipient: to, body: body.content,
              status: 'skipped',
              statusReason: 'Staff reply saved but no enabled SMS integration (Twilio or an SMS gateway) — enable one in Integrations to deliver SMS replies',
              relatedType: 'conversation', relatedId: conversation.id,
            },
          })
          delivery = { delivered: false, reason: 'no enabled SMS integration — the reply is saved in the outbox' }
        } else {
          try {
            await sendOrgSms(ctx.org.id, { to, body: body.content })
            delivery = { delivered: true }
            await audit({
              orgId: ctx.org.id, actorType: 'user', actorId: ctx.user.id,
              action: 'telephony.sms_reply_sent', entity: 'conversation', entityId: conversation.id,
              meta: { to, chars: body.content.length, via: sender.channel },
            })
          } catch (err) {
            const reason = err instanceof Error ? err.message.slice(0, 200) : 'unknown send error'
            await db.outboxMessage.create({
              data: {
                orgId: ctx.org.id, channel: 'sms', recipient: to, body: body.content,
                status: 'queued', statusReason: `initial send failed: ${reason}`,
                relatedType: 'conversation', relatedId: conversation.id,
              },
            })
            delivery = { delivered: false, queued: true, reason: `initial send failed (${reason}) — queued in the outbox for retry` }
          }
        }
      }
    }
  }

  if (conversation.status === 'waiting_human') {
    await db.conversation.update({ where: { id: conversation.id }, data: { status: 'open' } })
  }

  await audit({
    orgId: ctx.org.id,
    actorType: 'user',
    actorId: ctx.user.id,
    action: 'conversation.agent_replied',
    entity: 'conversation',
    entityId: conversation.id,
    meta: { length: body.content.length, delivery },
  })

  return json({ message, delivery }, 201)
}, { roles: ['owner', 'admin', 'agent'] })
