import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/crypto'
import { decryptSecrets, integrationConfig, sanitizeMessage, str } from '@/lib/integrations/connectors'
import {
  ACCOUNTING_LABELS,
  ACCOUNTING_PROVIDER_IDS,
  myobContactBody,
  myobInvoiceBody,
  myobTokenRequest,
  parseMyobId,
  parseQuickbooksId,
  parseTokenResponse,
  parseXeroId,
  quickbooksCustomerBody,
  quickbooksInvoiceBody,
  quickbooksTokenRequest,
  xeroContactBody,
  xeroInvoiceBody,
  xeroTokenRequest,
  type AccountingCustomer,
  type AccountingInvoice,
  type AccountingProviderId,
} from '@/lib/integrations/accounting-protocol'

export * from '@/lib/integrations/accounting-protocol'

type IntegrationRow = { id: string; orgId: string; kind: string; configJson: string; secretsEnc: string }

/* ---------------- token refresh ---------------- */

async function ensureAccessToken(integration: IntegrationRow): Promise<{ accessToken: string; config: Record<string, unknown>; secrets: Record<string, string> }> {
  const config = integrationConfig(integration)
  const secrets = decryptSecrets(integration)
  const kind = integration.kind as AccountingProviderId
  const now = Date.now()
  const expiresAt = str(secrets, 'accessTokenExpiresAt')
  const current = str(secrets, 'accessToken')
  if (current && expiresAt && new Date(expiresAt).getTime() > now + 30_000) {
    return { accessToken: current, config, secrets }
  }
  const clientId = str(secrets, 'clientId')
  const clientSecret = str(secrets, 'clientSecret')
  const refreshToken = str(secrets, 'refreshToken')
  if (!clientId || !clientSecret || !refreshToken) throw new Error(`${ACCOUNTING_LABELS[kind]} needs clientId, clientSecret and refreshToken`)

  const request =
    kind === 'quickbooks'
      ? quickbooksTokenRequest(clientId, clientSecret, refreshToken)
      : kind === 'xero'
        ? xeroTokenRequest(clientId, clientSecret, refreshToken)
        : myobTokenRequest(clientId, clientSecret, refreshToken)
  try {
    const res = await fetch(request.url, { method: 'POST', headers: request.headers, body: request.body, signal: AbortSignal.timeout(15_000) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const detail = (data as { error_description?: string; error?: string }).error_description || (data as { error?: string }).error
      throw new Error(`${ACCOUNTING_LABELS[kind]} token refresh was rejected (HTTP ${res.status})${detail ? `: ${detail}` : ''}`)
    }
    const token = parseTokenResponse(data)
    const nextSecrets: Record<string, string> = {
      ...secrets,
      accessToken: token.accessToken,
      accessTokenExpiresAt: token.expiresAt,
      ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
    }
    await db.integration.update({ where: { id: integration.id }, data: { secretsEnc: encryptSecret(JSON.stringify(nextSecrets)) } })
    return { accessToken: token.accessToken, config, secrets: nextSecrets }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(ACCOUNTING_LABELS[kind])) throw err
    throw new Error(sanitizeMessage(err instanceof Error ? err.message : String(err), integration))
  }
}

function accountingBase(kind: AccountingProviderId, config: Record<string, unknown>): string {
  if (kind === 'quickbooks') {
    const realmId = str(config, 'realmId')
    if (!realmId) throw new Error('QuickBooks config needs the company realmId')
    return `https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(realmId)}`
  }
  if (kind === 'xero') {
    const tenantId = str(config, 'tenantId')
    if (!tenantId) throw new Error('Xero config needs the tenantId')
    return 'https://api.xero.com/api.xro/2.0'
  }
  const companyFileId = str(config, 'companyFileId')
  if (!companyFileId) throw new Error('MYOB config needs the companyFileId')
  return `https://api.myob.com/accountright/${encodeURIComponent(companyFileId)}`
}

function authHeaders(kind: AccountingProviderId, accessToken: string, secrets: Record<string, string>, config: Record<string, unknown>): Record<string, string> {
  if (kind === 'quickbooks') {
    return { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'content-type': 'application/json' }
  }
  if (kind === 'xero') {
    return {
      authorization: `Bearer ${accessToken}`,
      'xero-tenant-id': str(config, 'tenantId'),
      accept: 'application/json',
      'content-type': 'application/json',
    }
  }
  return {
    authorization: `Bearer ${accessToken}`,
    'x-myobapi-key': str(secrets, 'clientId'),
    'x-myobapi-version': 'v2',
    accept: 'application/json',
    'content-type': 'application/json',
  }
}

async function apiJson(url: string, init: RequestInit, integration: IntegrationRow): Promise<unknown> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) })
    const text = await res.text()
    let data: unknown = {}
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = { raw: text.slice(0, 500) }
    }
    if (!res.ok) {
      const payload = data as { message?: string; Message?: string; error?: string; Errors?: Array<{ Message?: string; Detail?: string }>; Fault?: { Error?: Array<{ Message?: string; Detail?: string }> } }
      const detail =
        payload.Errors?.[0]?.Message ||
        payload.Errors?.[0]?.Detail ||
        payload.Fault?.Error?.[0]?.Message ||
        payload.Fault?.Error?.[0]?.Detail ||
        payload.message ||
        payload.Message ||
        payload.error ||
        `HTTP ${res.status} ${res.statusText}`
      throw new Error(sanitizeMessage(detail, integration))
    }
    return data
  } catch (err) {
    throw new Error(sanitizeMessage(err instanceof Error ? err.message : String(err), integration))
  }
}

export async function testAccounting(kind: string, integration: IntegrationRow) {
  if (!ACCOUNTING_PROVIDER_IDS.includes(kind as AccountingProviderId)) return { ok: false, detail: `Unknown accounting kind ${kind}` }
  const provider = kind as AccountingProviderId
  try {
    const { accessToken, config, secrets } = await ensureAccessToken(integration)
    const base = accountingBase(provider, config)
    const headers = authHeaders(provider, accessToken, secrets, config)
    if (provider === 'quickbooks') {
      const data = (await apiJson(`${base}/companyinfo/${encodeURIComponent(str(config, 'realmId'))}`, { headers }, integration)) as {
        CompanyInfo?: { CompanyName?: string }
      }
      return { ok: true, detail: `QuickBooks verified — company "${data.CompanyInfo?.CompanyName ?? 'unknown'}"` }
    }
    if (provider === 'xero') {
      const data = (await apiJson(`${base}/Organisation`, { headers }, integration)) as { Organisations?: Array<{ Name?: string }> }
      return { ok: true, detail: `Xero verified — organisation "${data.Organisations?.[0]?.Name ?? 'unknown'}"` }
    }
    const data = (await apiJson(`${base}/CompanyFile`, { headers }, integration)) as { CompanyName?: string; Name?: string }
    return { ok: true, detail: `MYOB verified — company file "${data.CompanyName ?? data.Name ?? 'unknown'}"` }
  } catch (err) {
    return { ok: false, detail: `${ACCOUNTING_LABELS[provider]} test failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/* ---------------- invoice push ---------------- */

export type PushResult = { provider: AccountingProviderId; externalId: string; number: string; customerId: string }

export async function pushInvoiceToAccounting(
  kind: string,
  integration: IntegrationRow,
  invoice: AccountingInvoice,
  customer: AccountingCustomer
): Promise<PushResult> {
  if (!ACCOUNTING_PROVIDER_IDS.includes(kind as AccountingProviderId)) throw new Error(`Unknown accounting kind ${kind}`)
  const provider = kind as AccountingProviderId

  const prior = await db.auditEvent.findFirst({
    where: {
      orgId: integration.orgId,
      action: 'invoice.pushed',
      entity: 'invoice',
      entityId: invoice.id,
      meta: { contains: `"provider":"${provider}"` },
    },
    select: { id: true },
  })
  if (prior) {
    throw new Error(`Invoice ${invoice.number} was already pushed to ${ACCOUNTING_LABELS[provider]} — refusing to create a duplicate`)
  }

  const { accessToken, config, secrets } = await ensureAccessToken(integration)
  const base = accountingBase(provider, config)
  const headers = authHeaders(provider, accessToken, secrets, config)
  const accountCode = str(config, 'salesAccountCode')

  let customerRef = ''
  if (provider === 'quickbooks') {
    customerRef = customer.externalRef.startsWith('quickbooks:') ? customer.externalRef.slice('quickbooks:'.length) : ''
    if (!customerRef) {
      const created = await apiJson(`${base}/customer?minorversion=65`, { method: 'POST', headers, body: JSON.stringify(quickbooksCustomerBody(customer)) }, integration)
      customerRef = parseQuickbooksId(created, 'customer')
      await db.customer.update({ where: { id: customer.id }, data: { externalRef: `quickbooks:${customerRef}` } })
    }
    const data = (await apiJson(`${base}/invoice?minorversion=65`, { method: 'POST', headers, body: JSON.stringify(quickbooksInvoiceBody(invoice, customerRef)) }, integration)) as {
      Invoice?: { Id?: string; DocNumber?: string }
    }
    const id = parseQuickbooksId(data, 'invoice')
    return { provider, externalId: id, number: data.Invoice?.DocNumber ?? invoice.number, customerId: customerRef }
  }

  if (provider === 'xero') {
    if (!accountCode) throw new Error('Xero config needs a salesAccountCode for invoice line items')
    customerRef = customer.externalRef.startsWith('xero:') ? customer.externalRef.slice('xero:'.length) : ''
    if (!customerRef) {
      const created = await apiJson(`${base}/Contacts`, { method: 'POST', headers, body: JSON.stringify({ Contacts: [xeroContactBody(customer)] }) }, integration)
      customerRef = parseXeroId(created, 'contact')
      await db.customer.update({ where: { id: customer.id }, data: { externalRef: `xero:${customerRef}` } })
    }
    const data = (await apiJson(`${base}/Invoices`, { method: 'POST', headers, body: JSON.stringify(xeroInvoiceBody(invoice, customerRef, accountCode)) }, integration)) as {
      Invoices?: Array<{ InvoiceID?: string; InvoiceNumber?: string }>
    }
    const id = parseXeroId(data, 'invoice')
    return { provider, externalId: id, number: data.Invoices?.[0]?.InvoiceNumber ?? invoice.number, customerId: customerRef }
  }

  if (!accountCode) throw new Error('MYOB config needs a salesAccountCode for invoice line items')
  customerRef = customer.externalRef.startsWith('myob:') ? customer.externalRef.slice('myob:'.length) : ''
  if (!customerRef) {
    const created = await apiJson(`${base}/Contact/Customer`, { method: 'POST', headers, body: JSON.stringify(myobContactBody(customer)) }, integration)
    customerRef = parseMyobId(created)
    await db.customer.update({ where: { id: customer.id }, data: { externalRef: `myob:${customerRef}` } })
  }
  const data = (await apiJson(`${base}/Sale/Invoice/Item`, { method: 'POST', headers, body: JSON.stringify(myobInvoiceBody(invoice, customerRef, accountCode)) }, integration)) as {
    UID?: string
    Number?: string
  }
  const id = parseMyobId(data)
  return { provider, externalId: id, number: data.Number ?? invoice.number, customerId: customerRef }
}
