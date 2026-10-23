export type AccountingProviderId = 'quickbooks' | 'xero' | 'myob'
export const ACCOUNTING_PROVIDER_IDS: AccountingProviderId[] = ['quickbooks', 'xero', 'myob']

export const ACCOUNTING_LABELS: Record<AccountingProviderId, string> = {
  quickbooks: 'QuickBooks Online',
  xero: 'Xero',
  myob: 'MYOB AccountRight',
}

export type AccountingInvoice = {
  id: string
  number: string
  currency: string
  totalCents: number
  issueDate: Date
  dueDate: Date
  notes: string
}

export type AccountingCustomer = { id: string; name: string; email: string; phone: string; externalRef: string }

type IntegrationRow = { id: string; orgId: string; kind: string; configJson: string; secretsEnc: string }

/* ---------------- pure request builders ---------------- */

export function quickbooksTokenRequest(clientId: string, clientSecret: string, refreshToken: string) {
  return {
    url: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
  }
}

export function xeroTokenRequest(clientId: string, clientSecret: string, refreshToken: string) {
  return {
    url: 'https://identity.xero.com/connect/token',
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
  }
}

export function myobTokenRequest(clientId: string, clientSecret: string, refreshToken: string) {
  return {
    url: 'https://secure.myob.com/oauth2/v1/authorize',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  }
}

export function parseTokenResponse(data: unknown): { accessToken: string; refreshToken: string; expiresAt: string } {
  const payload = data as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown }
  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    const reason = typeof payload.error_description === 'string' ? payload.error_description : typeof payload.error === 'string' ? payload.error : 'no access_token returned'
    throw new Error(`OAuth token refresh failed: ${reason}`)
  }
  const expiresIn = typeof payload.expires_in === 'number' && payload.expires_in > 0 ? payload.expires_in : 3600
  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === 'string' && payload.refresh_token ? payload.refresh_token : '',
    expiresAt: new Date(Date.now() + Math.max(60, expiresIn - 60) * 1000).toISOString(),
  }
}

const money = (cents: number) => Number((cents / 100).toFixed(2))

export function quickbooksCustomerBody(customer: AccountingCustomer) {
  return {
    DisplayName: customer.name || customer.email || `Customer ${customer.id}`,
    ...(customer.email ? { PrimaryEmailAddr: { Address: customer.email } } : {}),
    ...(customer.phone ? { PrimaryPhone: { FreeFormNumber: customer.phone } } : {}),
  }
}

export function quickbooksInvoiceBody(invoice: AccountingInvoice, customerRef: string) {
  return {
    DocNumber: invoice.number,
    CustomerRef: { value: customerRef },
    TxnDate: invoice.issueDate.toISOString().slice(0, 10),
    DueDate: invoice.dueDate.toISOString().slice(0, 10),
    ...(invoice.notes ? { PrivateNote: invoice.notes.slice(0, 1000) } : {}),
    Line: [
      {
        Amount: money(invoice.totalCents),
        DetailType: 'SalesItemLineDetail',
        Description: `Invoice ${invoice.number}`,
        SalesItemLineDetail: { Qty: 1, UnitPrice: money(invoice.totalCents) },
      },
    ],
  }
}

export function parseQuickbooksId(data: unknown, kind: 'invoice' | 'customer'): string {
  const payload = data as { Invoice?: { Id?: unknown }; Customer?: { Id?: unknown }; Fault?: { Error?: Array<{ Message?: string; Detail?: string }> } }
  const id = kind === 'invoice' ? payload.Invoice?.Id : payload.Customer?.Id
  if (typeof id !== 'string' || !id) {
    const fault = payload.Fault?.Error?.[0]
    throw new Error(fault?.Message || fault?.Detail || `QuickBooks returned no ${kind} id`)
  }
  return id
}

export function xeroContactBody(customer: AccountingCustomer) {
  return {
    Name: customer.name || customer.email || `Customer ${customer.id}`,
    ...(customer.email ? { EmailAddress: customer.email } : {}),
    ...(customer.phone ? { Phones: [{ PhoneType: 'DEFAULT', PhoneNumber: customer.phone }] } : {}),
  }
}

export function xeroInvoiceBody(invoice: AccountingInvoice, contactId: string, accountCode: string) {
  return {
    Invoices: [
      {
        Type: 'ACCREC',
        Contact: { ContactID: contactId },
        InvoiceNumber: invoice.number,
        Date: invoice.issueDate.toISOString().slice(0, 10),
        DueDate: invoice.dueDate.toISOString().slice(0, 10),
        ...(invoice.currency ? { CurrencyCode: invoice.currency.toUpperCase() } : {}),
        Status: 'AUTHORISED',
        LineItems: [
          {
            Description: `Invoice ${invoice.number}`,
            Quantity: 1,
            UnitAmount: money(invoice.totalCents),
            AccountCode: accountCode,
          },
        ],
      },
    ],
  }
}

export function parseXeroId(data: unknown, kind: 'invoice' | 'contact'): string {
  const payload = data as {
    Invoices?: Array<{ InvoiceID?: unknown }>
    Contacts?: Array<{ ContactID?: unknown }>
    Elements?: Array<{ ValidationErrors?: Array<{ Message?: string }> }>
  }
  const id = kind === 'invoice' ? payload.Invoices?.[0]?.InvoiceID : payload.Contacts?.[0]?.ContactID
  if (typeof id !== 'string' || !id) {
    const message = payload.Elements?.[0]?.ValidationErrors?.[0]?.Message
    throw new Error(message || `Xero returned no ${kind} id`)
  }
  return id
}

export function myobContactBody(customer: AccountingCustomer) {
  const name = customer.name || customer.email || `Customer ${customer.id}`
  const sellingDetails: Record<string, string> = {}
  if (customer.email) sellingDetails.SaleEmail = customer.email
  if (customer.phone) sellingDetails.SalePhone1 = customer.phone
  return {
    CompanyName: name,
    ...(Object.keys(sellingDetails).length > 0 ? { SellingDetails: sellingDetails } : {}),
  }
}

export function myobInvoiceBody(invoice: AccountingInvoice, customerUid: string, accountCode: string) {
  return {
    Number: invoice.number,
    Date: invoice.issueDate.toISOString().slice(0, 10),
    Customer: { UID: customerUid },
    Terms: { DueDate: invoice.dueDate.toISOString().slice(0, 10) },
    ...(invoice.notes ? { JournalMemo: invoice.notes.slice(0, 255) } : {}),
    Lines: [
      {
        Type: 'Transaction',
        Description: `Invoice ${invoice.number}`,
        ...(accountCode ? { Account: { DisplayID: accountCode } } : {}),
        Total: money(invoice.totalCents),
      },
    ],
  }
}

export function parseMyobId(data: unknown): string {
  const payload = data as { UID?: unknown; Errors?: Array<{ Message?: string; Detail?: string }> }
  if (typeof payload.UID !== 'string' || !payload.UID) {
    const error = payload.Errors?.[0]
    throw new Error(error?.Message || error?.Detail || 'MYOB returned no record id')
  }
  return payload.UID
}

