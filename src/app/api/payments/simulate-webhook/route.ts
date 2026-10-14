import { z } from 'zod'
import { withAuth, json, fail, parseBody } from '@/lib/api'
import { audit } from '@/lib/audit'
import { randomToken, hmacSign } from '@/lib/crypto'
import { getWebhookSecret, processWebhook, verifyWebhookSignature } from '@/lib/business/payments'

const schema = z.object({
  invoiceNumber: z.string().trim().min(1).max(100),
  amountCents: z.coerce.number().int().positive(),
  method: z.string().trim().max(50).optional(),
  reference: z.string().trim().max(200).optional(),
})

/**
 * POST /api/payments/simulate-webhook (owner/admin) — TEST HARNESS.
 * Builds a REAL signed webhook event (org secret, fresh eventId, org_slug) and
 * runs the exact same processWebhook path as the public endpoint. Results are
 * honest: invalid invoice numbers / overpayments surface as real errors.
 */
export const POST = withAuth(
  async (req, ctx) => {
    const body = await parseBody(req, schema)

    const secret = await getWebhookSecret(ctx.org.id)
    if (!secret) {
      return fail(403, 'Configure a webhook secret first (Settings → Security)', { code: 'no_webhook_secret' })
    }

    const eventId = `sim-${randomToken(12)}`
    const payload = JSON.stringify({
      event_id: eventId,
      invoice_number: body.invoiceNumber,
      amount_cents: body.amountCents,
      method: body.method ?? 'online',
      reference: body.reference ?? '',
      org_slug: ctx.org.slug,
    })
    const signature = hmacSign(payload, secret)
    // End-to-end honesty: verify the signature we just produced before processing.
    const signatureValid = verifyWebhookSignature(payload, signature, secret)

    const result = await processWebhook(
      ctx.org.id,
      'simulated',
      {
        eventId,
        invoiceNumber: body.invoiceNumber,
        amountCents: body.amountCents,
        method: body.method ?? 'online',
        reference: body.reference ?? '',
      },
      payload,
      signatureValid,
    )

    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'webhook.simulated',
      entity: 'webhook_event',
      entityId: eventId,
      meta: {
        invoiceNumber: body.invoiceNumber,
        amountCents: body.amountCents,
        result: result.result,
      },
    })

    return json({ result: result.result, eventId }, 202)
  },
  { roles: ['owner', 'admin'] }
)
