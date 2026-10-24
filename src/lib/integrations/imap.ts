import dns from 'node:dns/promises'
import { simpleParser, type AddressObject } from 'mailparser'
import type { FetchMessageObject } from 'imapflow'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { decryptSecrets, integrationConfig, str } from '@/lib/integrations/connectors'
import { isMetadataHost, isPrivateIp } from '@/lib/security/outbound'
import { handleReceptionistTurn } from '@/lib/ai/receptionist'
import { emitEvent } from '@/lib/automation/engine'
import { normalizeReceptionistStatus } from '@/lib/receptionist/status'
import type { Conversation, Integration, Organization } from '@prisma/client'

interface ImapConfig {
  host: string
  port: number
  secure: boolean
  username: string
  folders: string[]
  pollIntervalMinutes: number
  maxMessagesPerPoll: number
  allowPrivate: boolean
}

interface EmailMessage {
  uid: string
  messageId: string
  inReplyTo?: string
  references: string[]
  from: string
  fromAddress: string
  to: string[]
  subject: string
  text: string
  html?: string
  date: Date
  folder: string
}

export type ImapSyncResult = {
  orgId: string
  integrationId: string
  processed: number
  created: number
  errors: string[]
}

function boolValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return false
  return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function numValue(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(typeof value === 'string' ? value.trim() : '')
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function parseImapConfig(integration: { configJson: string }): ImapConfig {
  const cfg = integrationConfig(integration)
  const secure = cfg.secure === undefined ? numValue(cfg.port, 993) === 993 : boolValue(cfg.secure)
  const rawFolders = str(cfg, 'folders')
  return {
    host: str(cfg, 'host'),
    port: Math.min(65535, Math.max(1, Math.round(numValue(cfg.port, secure ? 993 : 143)))),
    secure,
    username: str(cfg, 'username'),
    folders: rawFolders ? rawFolders.split(',').map((f) => f.trim()).filter(Boolean) : ['INBOX'],
    pollIntervalMinutes: Math.min(60, Math.max(1, Math.round(numValue(cfg.pollIntervalMinutes, 5)))),
    maxMessagesPerPoll: Math.min(200, Math.max(1, Math.round(numValue(cfg.maxMessagesPerPoll, 50)))),
    allowPrivate: boolValue(cfg.allowPrivate),
  }
}

/**
 * SSRF guard for raw TCP endpoints. `assertOutboundUrl` only accepts http(s), so
 * IMAP resolves the host itself and rejects loopback/LAN/metadata targets unless
 * the operator explicitly opted in for a trusted mail server.
 */
async function assertImapHostAllowed(host: string, allowPrivate: boolean): Promise<void> {
  const h = host.trim().toLowerCase()
  if (!h) throw new Error('IMAP host is required')
  if (isMetadataHost(h)) {
    throw new Error('IMAP host points to a cloud metadata endpoint — blocked to prevent credential theft')
  }
  if (allowPrivate) return
  if (isPrivateIp(h)) {
    throw new Error('IMAP host points to a private/local address. Enable "Allow private/local IMAP server" only for a trusted self-hosted mail server.')
  }
  let addresses: Array<{ address: string }>
  try {
    addresses = await dns.lookup(h, { all: true })
  } catch {
    throw new Error('Could not resolve the IMAP host (DNS lookup failed)')
  }
  if (addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error('IMAP host resolves to a private/local address. Enable "Allow private/local IMAP server" only for a trusted self-hosted mail server.')
  }
}

async function getImapClient(config: ImapConfig, password: string) {
  const { ImapFlow } = await import('imapflow')
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.username, pass: password },
    logger: false,
  })
  await client.connect()
  return client
}

function firstAddress(input: AddressObject | AddressObject[] | undefined): { name?: string; address?: string } | undefined {
  if (!input) return undefined
  const first = Array.isArray(input) ? input[0] : input
  return first?.value?.[0]
}

function addressList(input: AddressObject | AddressObject[] | undefined): string[] {
  if (!input) return []
  const list = Array.isArray(input) ? input : [input]
  return list
    .flatMap((entry) => entry.value ?? [])
    .map((entry) => entry.address)
    .filter((address): address is string => Boolean(address))
}

function formatAddress(address: { name?: string; address?: string } | undefined): string {
  if (!address?.address) return ''
  return address.name ? `${address.name} <${address.address}>` : address.address
}

function normalizeMessageId(value: string): string {
  return value.trim().replace(/^<|>$/g, '')
}

function referenceList(input: string | string[] | undefined): string[] {
  if (!input) return []
  const list = Array.isArray(input) ? input : input.split(/\s+/)
  return list.map(normalizeMessageId).filter(Boolean)
}

function replySubject(subject: string): string {
  const trimmed = (subject || '(no subject)').slice(0, 180)
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`
}

async function parseFetchedEmail(
  message: FetchMessageObject,
  folder: string,
  fallbackHost: string,
): Promise<EmailMessage | null> {
  const parsed = message.source ? await simpleParser(message.source) : null
  const messageId = parsed?.messageId
    || message.envelope?.messageId
    || `<${message.uid ?? Date.now()}@${fallbackHost}>`
  const envelopeFrom = message.envelope?.from?.[0]
  const from = parsed
    ? firstAddress(parsed.from)
    : envelopeFrom
      ? { name: envelopeFrom.name, address: envelopeFrom.address }
      : undefined
  const to = parsed ? addressList(parsed.to) : (message.envelope?.to ?? []).map((a) => a.address ?? '').filter(Boolean)
  const subject = parsed?.subject || message.envelope?.subject || '(no subject)'
  let text = (parsed?.text || '').trim()
  const html = typeof parsed?.html === 'string' ? parsed.html : ''
  if (!text && html) {
    const { extractTextFromHtml } = await import('@/lib/knowledge/extract')
    text = extractTextFromHtml(html).text.trim()
  }
  if (!text) return null
  return {
    uid: String(message.uid ?? ''),
    messageId,
    inReplyTo: parsed?.inReplyTo ? normalizeMessageId(parsed.inReplyTo) : undefined,
    references: referenceList(parsed?.references),
    from: formatAddress(from),
    fromAddress: from?.address?.toLowerCase() ?? '',
    to,
    subject,
    text: text.slice(0, 100_000),
    html: html.slice(0, 200_000) || undefined,
    date: parsed?.date instanceof Date ? parsed.date : (message.envelope?.date ? new Date(message.envelope.date) : new Date()),
    folder,
  }
}

async function processEmail(org: Organization, email: EmailMessage): Promise<{ created: boolean; reason: string }> {
  const orgId = org.id
  if (!email.fromAddress) return { created: false, reason: 'no sender email found' }
  if (!email.text.trim()) return { created: false, reason: 'empty body' }

  // Deduplicate: polling and webhook delivery can both see the same message.
  const existing = await db.message.findFirst({
    where: { orgId, meta: { contains: `"messageId":${JSON.stringify(email.messageId)}` } },
    select: { id: true },
  })
  if (existing) return { created: false, reason: 'already processed' }

  let customer = await db.customer.findFirst({ where: { orgId, email: email.fromAddress } })
  if (!customer) {
    customer = await db.customer.create({
      data: {
        orgId,
        name: email.from.replace(/<[^>]+>/, '').replace(/["']/g, '').trim() || email.fromAddress,
        email: email.fromAddress,
        phone: '',
      },
    })
  }

  const threadKey = `email:${normalizeMessageId(email.messageId)}`
  const ancestors = [...new Set([
    ...(email.references ?? []),
    ...(email.inReplyTo ? [normalizeMessageId(email.inReplyTo)] : []),
  ].filter(Boolean))].slice(0, 20)

  // Replies carry In-Reply-To/References: join the conversation that holds any
  // ancestor message so the AI keeps the thread context.
  let conversation: Conversation | null = null
  if (ancestors.length) {
    const parent = await db.message.findFirst({
      where: { orgId, OR: ancestors.map((id) => ({ meta: { contains: `"messageId":${JSON.stringify(id)}` } })) },
      select: { conversationId: true },
      orderBy: { createdAt: 'desc' },
    })
    if (parent) {
      conversation = await db.conversation.findFirst({
        where: { id: parent.conversationId, orgId, channel: 'email' },
      })
    }
  }
  if (!conversation) {
    conversation = await db.conversation.findFirst({
      where: { orgId, channel: 'email', externalRef: threadKey },
    })
  }
  if (!conversation) {
    conversation = await db.conversation.create({
      data: {
        orgId,
        channel: 'email',
        status: 'open',
        contactName: customer.name,
        customerId: customer.id,
        externalRef: `email:${ancestors[0] ?? normalizeMessageId(email.messageId)}`,
        aiEnabled: true,
      },
    })
  }

  const statusBefore = conversation.status
  await db.message.create({
    data: {
      conversationId: conversation.id,
      orgId,
      role: 'customer',
      content: email.text.slice(0, 10_000),
      meta: JSON.stringify({
        source: 'email',
        messageId: email.messageId,
        inReplyTo: email.inReplyTo ?? '',
        references: email.references,
        from: email.from,
        to: email.to.join(', '),
        subject: email.subject,
        html: email.html?.slice(0, 20_000),
        date: email.date.toISOString(),
        folder: email.folder,
      }),
    },
  })

  await audit({
    orgId,
    actorType: 'system',
    actorId: 'imap-sync',
    action: 'email.ingested',
    entity: 'conversation',
    entityId: conversation.id,
    meta: { messageId: email.messageId, from: email.fromAddress, subject: email.subject },
  })

  const status = normalizeReceptionistStatus(org.receptionistStatus)
  if (status !== 'running' || !conversation.aiEnabled) {
    return { created: true, reason: status === 'running' ? 'ai disabled for conversation' : `receptionist ${status}` }
  }

  const result = await handleReceptionistTurn(org, conversation.id, email.text.slice(0, 8_000), {
    skipInboundPersist: true,
    channel: 'email',
  })
  const fresh = await db.conversation.findUnique({ where: { id: conversation.id } })
  if (statusBefore !== 'waiting_human' && fresh?.status === 'waiting_human') {
    await emitEvent(org.id, 'conversation_escalated', { conversationId: conversation.id, entityId: conversation.id })
  }
  if (!result.reply) {
    return { created: true, reason: result.skipped ? `receptionist ${result.skipped}` : 'no reply generated' }
  }

  // Queue the reply through the outbox so the real email dispatcher delivers it
  // (email_api/SMTP) with retries. Queued is reported as queued, never as sent.
  try {
    await db.outboxMessage.create({
      data: {
        orgId,
        channel: 'email',
        recipient: email.fromAddress,
        subject: replySubject(email.subject),
        body: result.reply,
        relatedType: 'conversation',
        relatedId: conversation.id,
        dedupeKey: `email-reply:${orgId}:${email.messageId}`,
      },
    })
  } catch (err) {
    // A poll/webhook race may have already queued this exact reply.
    if ((err as { code?: string })?.code !== 'P2002') throw err
  }
  await audit({
    orgId,
    actorType: 'system',
    actorId: 'email-receptionist',
    action: 'email.reply_queued',
    entity: 'conversation',
    entityId: conversation.id,
    meta: { to: email.fromAddress, chars: result.reply.length },
  })

  return { created: true, reason: 'ingested and reply queued' }
}

export async function testImap(kind: string, integration: { configJson: string; secretsEnc: string }): Promise<{ ok: boolean; detail: string }> {
  if (kind !== 'imap') return { ok: false, detail: `Unknown integration kind ${kind}` }
  try {
    const config = parseImapConfig(integration)
    const secrets = decryptSecrets(integration)
    const password = str(secrets, 'password')
    if (!config.host) throw new Error('IMAP host is required')
    if (!config.username) throw new Error('IMAP username is required')
    if (!password) throw new Error('IMAP password is required')

    await assertImapHostAllowed(config.host, config.allowPrivate)

    const client = await getImapClient(config, password)
    let count = 0
    try {
      const lock = await client.getMailboxLock('INBOX')
      try {
        count = client.mailbox ? client.mailbox.exists : 0
      } finally {
        lock.release()
      }
    } finally {
      await client.logout().catch(() => undefined)
    }
    return { ok: true, detail: `IMAP connected — ${count} message(s) in INBOX` }
  } catch (err) {
    return { ok: false, detail: `IMAP test failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export async function syncImapEmails(integration: Integration): Promise<{
  processed: number
  created: number
  errors: string[]
}> {
  const org = await db.organization.findUnique({ where: { id: integration.orgId } })
  if (!org) throw new Error('Organization not found')
  if (normalizeReceptionistStatus(org.receptionistStatus) === 'stopped') {
    return { processed: 0, created: 0, errors: [] }
  }

  const config = parseImapConfig(integration)
  const secrets = decryptSecrets(integration)
  const password = str(secrets, 'password')
  if (!config.host) throw new Error('IMAP host is required')
  if (!config.username) throw new Error('IMAP username is required')
  if (!password) throw new Error('IMAP password is required')

  await assertImapHostAllowed(config.host, config.allowPrivate)

  let client: Awaited<ReturnType<typeof getImapClient>> | null = null
  const errors: string[] = []
  let processed = 0
  let created = 0

  try {
    client = await getImapClient(config, password)

    for (const folder of config.folders) {
      let lock: { release: () => void } | null = null
      try {
        lock = await client.getMailboxLock(folder)
        const mailbox = client.mailbox
        if (!mailbox || mailbox.exists === 0) continue

        const uidNext = typeof mailbox.uidNext === 'number' ? mailbox.uidNext : 0
        if (uidNext <= 1) continue
        const maxUid = uidNext - 1
        const minUid = Math.max(1, maxUid - config.maxMessagesPerPoll + 1)

        for await (const raw of client.fetch(`${minUid}:${maxUid}`, { envelope: true, source: true }, { uid: true })) {
          processed++
          try {
            const email = await parseFetchedEmail(raw, folder, config.host)
            if (!email) continue
            const result = await processEmail(org, email)
            if (result.created) created++
          } catch (err) {
            errors.push(`message ${raw.uid ?? '?'}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      } catch (err) {
        errors.push(`folder ${folder}: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        lock?.release()
      }
    }

    await audit({
      orgId: org.id,
      actorType: 'system',
      actorId: 'imap-sync',
      action: 'imap.sync_completed',
      entity: 'integration',
      entityId: integration.id,
      meta: { processed, created, errors: errors.length },
    })

    return { processed, created, errors }
  } catch (err) {
    errors.push(`sync failed: ${err instanceof Error ? err.message : String(err)}`)
    return { processed, created, errors }
  } finally {
    if (client) {
      try {
        await client.logout()
      } catch { /* ignore */ }
    }
  }
}

/** In-process poll clock so the per-integration interval is honored between ticks. */
const lastPollAt = new Map<string, number>()

/**
 * Sync every enabled IMAP integration whose poll interval is due.
 * The caller (instrumentation) already holds the `imap` worker lease; this
 * function must NOT take another lease or it would deadlock against itself.
 */
export async function syncAllImapIntegrations(): Promise<ImapSyncResult[]> {
  const integrations = await db.integration.findMany({
    where: { kind: 'imap', enabled: true },
  })

  const results: ImapSyncResult[] = []
  const now = Date.now()

  for (const integration of integrations) {
    const config = parseImapConfig(integration)
    const last = lastPollAt.get(integration.id) ?? 0
    if (now - last < config.pollIntervalMinutes * 60_000) continue
    lastPollAt.set(integration.id, now)

    try {
      const result = await syncImapEmails(integration)
      results.push({ orgId: integration.orgId, integrationId: integration.id, ...result })
    } catch (err) {
      results.push({
        orgId: integration.orgId,
        integrationId: integration.id,
        processed: 0,
        created: 0,
        errors: [err instanceof Error ? err.message : String(err)],
      })
    }
  }

  return results
}

function pickString(payload: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return ''
}

/**
 * Process a real-time email notification from a provider webhook
 * (Mailgun/Postmark/SendGrid). Authentication happens in the route.
 */
export async function handleImapWebhook(
  orgId: string,
  integration: Integration,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const org = await db.organization.findUnique({ where: { id: orgId } })
    if (!org) return { ok: false, detail: 'Organization not found' }
    if (normalizeReceptionistStatus(org.receptionistStatus) === 'stopped') {
      return { ok: false, detail: 'Receptionist is stopped' }
    }

    const config = parseImapConfig(integration)
    const messageId = pickString(payload, ['MessageId', 'message_id', 'Message-ID', 'messageId'])
    if (!messageId) return { ok: false, detail: 'No message-id in webhook payload' }

    const from = pickString(payload, ['From', 'from', 'sender'])
    const fromMatch = from.match(/<([^>]+)>/)
    const fromAddress = (fromMatch ? fromMatch[1] : from).toLowerCase()
    const subject = pickString(payload, ['Subject', 'subject']) || '(no subject)'
    const text = pickString(payload, ['text', 'body-plain', 'TextBody', 'body'])
    const html = pickString(payload, ['html', 'body-html', 'HtmlBody'])
    let body = text
    if (!body && html) {
      const { extractTextFromHtml } = await import('@/lib/knowledge/extract')
      body = extractTextFromHtml(html).text
    }
    if (!body.trim()) return { ok: false, detail: 'Webhook payload has no text body' }

    const dateValue = pickString(payload, ['Date', 'date', 'timestamp'])
    const parsedDate = dateValue ? new Date(dateValue) : new Date()

    const email: EmailMessage = {
      uid: messageId,
      messageId,
      inReplyTo: pickString(payload, ['In-Reply-To', 'in-reply-to', 'inReplyTo'])
        ? normalizeMessageId(pickString(payload, ['In-Reply-To', 'in-reply-to', 'inReplyTo']))
        : undefined,
      references: referenceList(pickString(payload, ['References', 'references'])),
      from,
      fromAddress,
      to: pickString(payload, ['To', 'to']).split(',').map((s) => s.trim()).filter(Boolean),
      subject,
      text: body.slice(0, 100_000),
      html: html ? html.slice(0, 200_000) : undefined,
      date: Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate,
      folder: config.folders[0] ?? 'INBOX',
    }

    const result = await processEmail(org, email)
    return { ok: result.created, detail: result.reason }
  } catch (err) {
    return { ok: false, detail: `Webhook processing failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
