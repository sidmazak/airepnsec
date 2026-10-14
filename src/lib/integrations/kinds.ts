import { z } from 'zod'
import { parseJson } from '@/lib/org'
import type { Integration } from '@prisma/client'

/**
 * Shared per-kind validation schemas + the secret-free wire shape used by ALL
 * integration endpoints. secretsEnc/decrypted secrets NEVER appear here.
 */

export const smtpConfigSchema = z.object({
  host: z.string().min(1, 'host is required'),
  port: z.coerce.number().int('port must be an integer').positive('port must be positive'),
  secure: z.boolean().optional(),
  from: z.string().min(3, 'from must be a sender email address'),
})

export const twilioConfigSchema = z.object({
  from: z.string().min(3, 'from is required (e.g. +15551234567 or whatsapp:+15551234567)'),
})

export const stripeConfigSchema = z.object({}).partial()

export const webhookOutConfigSchema = z.object({
  url: z.string().url('url must be a valid http(s) URL'),
})

/** Secrets accepted per kind (full-replacement semantics on PATCH). */
export const secretsSchemaFor: Record<string, z.ZodTypeAny> = {
  smtp: z.object({ user: z.string().optional(), pass: z.string().optional() }),
  twilio_sms: z.object({ accountSid: z.string().min(1, 'accountSid is required'), authToken: z.string().min(1, 'authToken is required') }),
  twilio_whatsapp: z.object({ accountSid: z.string().min(1, 'accountSid is required'), authToken: z.string().min(1, 'authToken is required') }),
  stripe: z.object({ secretKey: z.string().min(1, 'secretKey is required'), webhookSecret: z.string().optional() }),
  webhook_out: z.object({ secret: z.string().optional() }),
}

export const configSchemaFor: Record<string, z.ZodTypeAny> = {
  smtp: smtpConfigSchema,
  twilio_sms: twilioConfigSchema,
  twilio_whatsapp: twilioConfigSchema,
  stripe: stripeConfigSchema,
  webhook_out: webhookOutConfigSchema,
}

/** Minimal credential check so "configured" always means "testable". */
export function secretsAreSufficient(kind: string, secrets: Record<string, unknown>): boolean {
  switch (kind) {
    case 'smtp':
      return true // anonymous relays are legitimate; send/test will fail honestly otherwise
    case 'twilio_sms':
    case 'twilio_whatsapp':
      return Boolean(secrets.accountSid && secrets.authToken)
    case 'stripe':
      return Boolean(secrets.secretKey)
    case 'webhook_out':
      return true // signing secret is optional by design
    default:
      return false
  }
}

/** Wire shape — config parsed, credentials represented ONLY by the boolean `configured`. */
export function publicIntegration(integration: Integration) {
  return {
    id: integration.id,
    kind: integration.kind,
    label: integration.label,
    config: parseJson<Record<string, unknown>>(integration.configJson, {}),
    configured: Boolean(integration.secretsEnc),
    enabled: integration.enabled,
    lastTestAt: integration.lastTestAt ? integration.lastTestAt.toISOString() : null,
    lastTestOk: integration.lastTestOk,
    lastTestError: integration.lastTestError,
    createdAt: integration.createdAt.toISOString(),
  }
}
