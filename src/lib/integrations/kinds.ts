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

export const twilioVoiceConfigSchema = z.object({
  from: z.string().min(6, 'from is required — the Twilio voice-capable number in E.164 format (e.g. +15551234567)'),
  language: z.string().max(10).optional(), // e.g. en-US
  voiceName: z.string().max(40).optional(), // Twilio <Say> voice, e.g. alice / Polly.Joanna
  transferNumber: z.string().max(20).optional(), // where <Dial> sends escalated calls
  publicBaseUrl: z.string().url().optional(), // the https base URL configured in the Twilio console (used for webhook signature validation)
})

export const smsGatewayConfigSchema = z
  .object({
    provider: z.enum(['textbee', 'httpsms', 'android_sms_gateway', 'generic_http']),
    baseUrl: z.string().url('baseUrl must be a valid http(s) URL').optional(),
    from: z.string().max(40).optional(),
    deviceId: z.string().max(200).optional(),
    // generic_http only:
    url: z.string().url('url must be a valid http(s) URL').optional(),
    method: z.enum(['POST', 'PUT']).optional(),
    authHeaderName: z.string().max(60).optional(),
    bodyTemplate: z.string().max(2000).optional(),
    testRecipient: z.string().max(40).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.provider === 'httpsms' && !val.from) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: 'httpSMS requires the sending phone number in "from"' })
    }
    if (val.provider === 'generic_http' && !val.url) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'generic_http requires the destination "url"' })
    }
  })

export const caldavConfigSchema = z.object({
  url: z.string().url('url must be the CalDAV calendar collection URL'),
  username: z.string().max(200).optional(),
})

export const stripeConfigSchema = z.object({}).partial()

export const webhookOutConfigSchema = z.object({
  url: z.string().url('url must be a valid http(s) URL'),
  // Admin opt-in for LAN/self-hosted receivers; otherwise private IPs are SSRF-blocked.
  allowPrivate: z.boolean().optional(),
})

/** Secrets accepted per kind (full-replacement semantics on PATCH). */
export const secretsSchemaFor: Record<string, z.ZodTypeAny> = {
  smtp: z.object({ user: z.string().optional(), pass: z.string().optional() }),
  twilio_sms: z.object({ accountSid: z.string().min(1, 'accountSid is required'), authToken: z.string().min(1, 'authToken is required') }),
  twilio_whatsapp: z.object({ accountSid: z.string().min(1, 'accountSid is required'), authToken: z.string().min(1, 'authToken is required') }),
  twilio_voice: z.object({ accountSid: z.string().min(1, 'accountSid is required'), authToken: z.string().min(1, 'authToken is required') }),
  sms_gateway: z.object({
    apiKey: z.string().optional(), // TextBee / httpSMS
    username: z.string().optional(), // android-sms-gateway (basic auth)
    password: z.string().optional(),
    token: z.string().optional(), // android-sms-gateway (bearer)
    authValue: z.string().optional(), // generic_http custom auth header value
  }),
  caldav: z.object({ password: z.string().optional() }),
  stripe: z.object({ secretKey: z.string().min(1, 'secretKey is required'), webhookSecret: z.string().optional() }),
  webhook_out: z.object({ secret: z.string().optional() }),
}

export const configSchemaFor: Record<string, z.ZodTypeAny> = {
  smtp: smtpConfigSchema,
  twilio_sms: twilioConfigSchema,
  twilio_whatsapp: twilioConfigSchema,
  twilio_voice: twilioVoiceConfigSchema,
  sms_gateway: smsGatewayConfigSchema,
  caldav: caldavConfigSchema,
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
    case 'twilio_voice':
      return Boolean(secrets.accountSid && secrets.authToken)
    case 'sms_gateway':
      // Credentials are provider-dependent and often legitimately absent
      // (android-sms-gateway local mode, an unauthenticated LAN/iOS bridge).
      // The real connection test and each send report honest failures instead.
      return true
    case 'caldav':
      return true // password optional (some local servers allow anonymous writes); PUT/PROPFIND will fail honestly otherwise
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
