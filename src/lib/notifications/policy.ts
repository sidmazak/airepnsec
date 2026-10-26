function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    const parsed = JSON.parse(value)
    return (parsed ?? fallback) as T
  } catch {
    return fallback
  }
}

export const NOTIFICATION_CHANNELS = ['email', 'sms', 'whatsapp', 'inapp'] as const
export const CUSTOMER_EVENTS = ['service', 'booking', 'invoice', 'reminder', 'marketing'] as const
export const STAFF_EVENTS = ['missed_call', 'voicemail', 'escalation', 'integration_failure'] as const

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]
export type CustomerEvent = (typeof CUSTOMER_EVENTS)[number]
export type StaffEvent = (typeof STAFF_EVENTS)[number]

export type EventRule = { enabled: boolean; channels: NotificationChannel[] }

export type NotificationConfig = {
  customer: Record<CustomerEvent, EventRule>
  staff: Record<StaffEvent, EventRule>
  quietHours: { start: string; end: string }
  consent: { requireForMarketing: boolean; requireForReminders: boolean }
}

export type CustomerPrefs = {
  email: boolean
  sms: boolean
  whatsapp: boolean
  service: boolean
  booking: boolean
  invoice: boolean
  reminder: boolean
  marketing: boolean
}

export const NOTIFICATION_SETTING_KEY = 'notification_routing'

const ALL_CUSTOMER_CHANNELS: NotificationChannel[] = ['email', 'sms', 'whatsapp']

export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  customer: {
    service: { enabled: true, channels: [...ALL_CUSTOMER_CHANNELS] },
    booking: { enabled: true, channels: [...ALL_CUSTOMER_CHANNELS] },
    invoice: { enabled: true, channels: [...ALL_CUSTOMER_CHANNELS] },
    reminder: { enabled: true, channels: [...ALL_CUSTOMER_CHANNELS] },
    marketing: { enabled: false, channels: ['email'] },
  },
  staff: {
    missed_call: { enabled: true, channels: ['inapp', 'email'] },
    voicemail: { enabled: true, channels: ['inapp', 'email'] },
    escalation: { enabled: true, channels: ['inapp'] },
    integration_failure: { enabled: true, channels: ['inapp', 'email'] },
  },
  quietHours: { start: '21:00', end: '08:00' },
  consent: { requireForMarketing: true, requireForReminders: true },
}

export const DEFAULT_CUSTOMER_PREFS: CustomerPrefs = {
  email: true,
  sms: true,
  whatsapp: true,
  service: true,
  booking: true,
  invoice: true,
  reminder: true,
  marketing: false,
}

export type EventAudience = 'customer' | 'staff'
export type NotificationEvent = CustomerEvent | StaffEvent
export type OutboxEvent = { audience: EventAudience; event: NotificationEvent }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function channelList(value: unknown, fallback: NotificationChannel[]): NotificationChannel[] {
  if (!Array.isArray(value)) return [...fallback]
  const allowed = new Set<string>(NOTIFICATION_CHANNELS)
  const out = value.filter((v): v is NotificationChannel => typeof v === 'string' && allowed.has(v))
  return Array.from(new Set(out))
}

function hhmm(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim())
  return match ? match[0] : fallback
}

function normalizeRule(value: unknown, fallback: EventRule): EventRule {
  if (!isRecord(value)) return { enabled: fallback.enabled, channels: [...fallback.channels] }
  return {
    enabled: bool(value.enabled, fallback.enabled),
    channels: channelList(value.channels, fallback.channels),
  }
}

export function normalizeNotificationConfig(raw: unknown): NotificationConfig {
  const value = isRecord(raw) ? raw : {}
  const customerRaw = isRecord(value.customer) ? value.customer : {}
  const staffRaw = isRecord(value.staff) ? value.staff : {}
  const quietRaw = isRecord(value.quietHours) ? value.quietHours : {}
  const consentRaw = isRecord(value.consent) ? value.consent : {}

  const customer = {} as Record<CustomerEvent, EventRule>
  for (const event of CUSTOMER_EVENTS) customer[event] = normalizeRule(customerRaw[event], DEFAULT_NOTIFICATION_CONFIG.customer[event])

  const staff = {} as Record<StaffEvent, EventRule>
  for (const event of STAFF_EVENTS) staff[event] = normalizeRule(staffRaw[event], DEFAULT_NOTIFICATION_CONFIG.staff[event])

  return {
    customer,
    staff,
    quietHours: {
      start: hhmm(quietRaw.start, DEFAULT_NOTIFICATION_CONFIG.quietHours.start),
      end: hhmm(quietRaw.end, DEFAULT_NOTIFICATION_CONFIG.quietHours.end),
    },
    consent: {
      requireForMarketing: bool(consentRaw.requireForMarketing, DEFAULT_NOTIFICATION_CONFIG.consent.requireForMarketing),
      requireForReminders: bool(consentRaw.requireForReminders, DEFAULT_NOTIFICATION_CONFIG.consent.requireForReminders),
    },
  }
}

export function parseNotificationConfig(raw: string | null | undefined): NotificationConfig {
  return normalizeNotificationConfig(parseJson<unknown>(raw, {}))
}

export function normalizeCustomerPrefs(raw: unknown): CustomerPrefs {
  const value = isRecord(raw) ? raw : {}
  const out = {} as CustomerPrefs
  for (const key of Object.keys(DEFAULT_CUSTOMER_PREFS) as Array<keyof CustomerPrefs>) {
    out[key] = bool(value[key], DEFAULT_CUSTOMER_PREFS[key])
  }
  return out
}

export function parseCustomerPrefs(raw: string | null | undefined): CustomerPrefs {
  return normalizeCustomerPrefs(parseJson<unknown>(raw, {}))
}

export type DeliveryDecision =
  | { allowed: true; event: OutboxEvent }
  | { allowed: false; event: OutboxEvent | null; reason: string; deferUntil?: Date }
  | { allowed: true; event: OutboxEvent; deferUntil: Date }

function minutes(value: string): number {
  const [h, m] = value.split(':').map(Number)
  return h * 60 + m
}

export function inQuietHours(now: Date, start: string, end: string): boolean {
  const current = now.getHours() * 60 + now.getMinutes()
  const from = minutes(start)
  const to = minutes(end)
  if (from === to) return false
  if (from < to) return current >= from && current < to
  return current >= from || current < to
}

export function quietHoursEnd(now: Date, end: string): Date {
  const [h, m] = end.split(':').map(Number)
  const next = new Date(now)
  next.setHours(h, m, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)
  return next
}

const CUSTOMER_EVENT_SET = new Set<string>(CUSTOMER_EVENTS)
const STAFF_EVENT_SET = new Set<string>(STAFF_EVENTS)

export function eventForOutbox(message: {
  channel: string
  subject: string
  relatedType: string
  dedupeKey?: string | null
}): OutboxEvent {
  if (message.relatedType === 'telephony_call') {
    const text = `${message.subject} ${message.dedupeKey ?? ''}`.toLowerCase()
    return { audience: 'staff', event: text.includes('voicemail') ? 'voicemail' : 'missed_call' }
  }
  if (message.channel === 'inapp') return { audience: 'staff', event: 'escalation' }

  const text = `${message.subject} ${message.dedupeKey ?? ''}`.toLowerCase()
  const related = message.relatedType
  if (related === 'invoice') {
    return { audience: 'customer', event: text.includes('reminder') ? 'reminder' : 'invoice' }
  }
  if (related === 'booking') {
    return { audience: 'customer', event: text.includes('reminder') ? 'reminder' : 'booking' }
  }
  if (related === 'conversation') return { audience: 'customer', event: 'service' }
  if (related === 'automation') return { audience: 'customer', event: 'marketing' }
  return { audience: 'customer', event: 'service' }
}

/** Map an automation trigger to the closest customer notification event. */
export function eventForAutomation(triggerType: string): CustomerEvent {
  if (triggerType === 'invoice_overdue') return 'reminder'
  if (triggerType === 'booking_created') return 'booking'
  if (triggerType === 'conversation_escalated') return 'service'
  return 'marketing'
}

export function eventLabel(event: NotificationEvent): string {
  const labels: Record<NotificationEvent, string> = {
    service: 'Conversation replies',
    booking: 'Booking confirmations',
    invoice: 'Invoices and receipts',
    reminder: 'Reminders',
    marketing: 'Marketing',
    missed_call: 'Missed calls',
    voicemail: 'Voicemail',
    escalation: 'Conversation escalations',
    integration_failure: 'Integration failures',
  }
  return labels[event]
}

export function isCustomerEvent(value: string): value is CustomerEvent {
  return CUSTOMER_EVENT_SET.has(value)
}

export function isStaffEvent(value: string): value is StaffEvent {
  return STAFF_EVENT_SET.has(value)
}

export type DeliveryInput = {
  config: NotificationConfig
  event: OutboxEvent
  channel: string
  customer: { optOut: boolean; consentContact: boolean; prefs: CustomerPrefs } | null
  now?: Date
}

export function decideDelivery(input: DeliveryInput): DeliveryDecision {
  const { config, event, channel, customer } = input
  const now = input.now ?? new Date()

  if (!NOTIFICATION_CHANNELS.includes(channel as NotificationChannel)) {
    return { allowed: true, event }
  }
  const channelKey = channel as NotificationChannel

  if (event.audience === 'staff') {
    const rule = config.staff[event.event as StaffEvent]
    if (!rule.enabled) return { allowed: false, event, reason: `staff ${eventLabel(event.event)} disabled in notification settings` }
    if (!rule.channels.includes(channelKey)) {
      return { allowed: false, event, reason: `${channelKey} not allowed for staff ${eventLabel(event.event)}` }
    }
    return { allowed: true, event }
  }

  const customerEvent = event.event as CustomerEvent
  const rule = config.customer[customerEvent]
  if (!rule.enabled) {
    return { allowed: false, event, reason: `${eventLabel(customerEvent)} disabled in notification settings` }
  }
  if (!rule.channels.includes(channelKey)) {
    return { allowed: false, event, reason: `${channelKey} not allowed for ${eventLabel(customerEvent)}` }
  }

  const prefs = customer?.prefs ?? DEFAULT_CUSTOMER_PREFS
  if (customer?.optOut) return { allowed: false, event, reason: 'customer opted out of all messages' }
  if (channelKey === 'email' && !prefs.email) return { allowed: false, event, reason: 'customer opted out of email' }
  if (channelKey === 'sms' && !prefs.sms) return { allowed: false, event, reason: 'customer opted out of SMS' }
  if (channelKey === 'whatsapp' && !prefs.whatsapp) return { allowed: false, event, reason: 'customer opted out of WhatsApp' }
  if (!prefs[customerEvent]) return { allowed: false, event, reason: `customer opted out of ${eventLabel(customerEvent).toLowerCase()}` }

  if (customerEvent === 'marketing' && config.consent.requireForMarketing) {
    if (!customer || !customer.consentContact) {
      return { allowed: false, event, reason: 'marketing consent missing (customer did not opt in)' }
    }
  }
  if (customerEvent === 'reminder' && config.consent.requireForReminders) {
    if (customer && !customer.consentContact) {
      return { allowed: false, event, reason: 'reminder consent missing (customer did not opt in)' }
    }
  }

  if (channelKey !== 'inapp' && (customerEvent === 'marketing' || customerEvent === 'reminder')) {
    if (inQuietHours(now, config.quietHours.start, config.quietHours.end)) {
      return { allowed: true, event, deferUntil: quietHoursEnd(now, config.quietHours.end) }
    }
  }

  return { allowed: true, event }
}

export function filterCustomerEvents(events: string[]): string[] {
  return events.filter((event) => CUSTOMER_EVENT_SET.has(event) || STAFF_EVENT_SET.has(event))
}
