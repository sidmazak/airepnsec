import test from 'node:test'
import assert from 'node:assert/strict'
import {
  myobContactBody,
  myobInvoiceBody,
  myobTokenRequest,
  parseMyobId,
  parseQuickbooksId,
  parseTokenResponse,
  parseXeroId,
  quickbooksInvoiceBody,
  quickbooksTokenRequest,
  xeroInvoiceBody,
  xeroTokenRequest,
} from '../../src/lib/integrations/accounting-protocol.ts'

const invoice = {
  id: 'inv_1',
  number: 'INV-100',
  currency: 'usd',
  totalCents: 12345,
  issueDate: new Date('2026-01-02T00:00:00Z'),
  dueDate: new Date('2026-01-31T00:00:00Z'),
  notes: 'Thanks',
}
const customer = { id: 'cus_1', name: 'Jane Doe', email: 'jane@example.com', phone: '+15551234567', externalRef: '' }

test('token requests use Basic auth for QuickBooks/Xero and form credentials for MYOB', () => {
  const qbo = quickbooksTokenRequest('cid', 'secret', 'refresh')
  assert.equal(qbo.url, 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer')
  assert.equal(qbo.headers.authorization, `Basic ${Buffer.from('cid:secret').toString('base64')}`)
  assert.match(qbo.body, /grant_type=refresh_token/)
  assert.match(qbo.body, /refresh_token=refresh/)

  const xero = xeroTokenRequest('cid', 'secret', 'refresh')
  assert.equal(xero.url, 'https://identity.xero.com/connect/token')
  assert.match(xero.body, /grant_type=refresh_token/)

  const myob = myobTokenRequest('cid', 'secret', 'refresh')
  assert.equal(myob.url, 'https://secure.myob.com/oauth2/v1/authorize')
  assert.equal(myob.headers.authorization, undefined)
  assert.match(myob.body, /client_id=cid/)
  assert.match(myob.body, /client_secret=secret/)
})

test('parseTokenResponse normalizes tokens and keeps a rotated refresh token', () => {
  const parsed = parseTokenResponse({ access_token: 'at', refresh_token: 'rt2', expires_in: 3600 })
  assert.equal(parsed.accessToken, 'at')
  assert.equal(parsed.refreshToken, 'rt2')
  const ttl = new Date(parsed.expiresAt).getTime() - Date.now()
  assert.ok(ttl > 3000_000 && ttl <= 3600_000)

  const withoutRotation = parseTokenResponse({ access_token: 'at2' })
  assert.equal(withoutRotation.refreshToken, '')
})

test('parseTokenResponse throws the provider reason when refresh fails', () => {
  assert.throws(() => parseTokenResponse({ error: 'invalid_grant', error_description: 'refresh token expired' }), /refresh token expired/)
  assert.throws(() => parseTokenResponse({}), /no access_token/)
})

test('QuickBooks invoice body posts the invoice number and dollar amount', () => {
  const body = quickbooksInvoiceBody(invoice, 'qbo-customer') as any
  assert.equal(body.DocNumber, 'INV-100')
  assert.equal(body.CustomerRef.value, 'qbo-customer')
  assert.equal(body.TxnDate, '2026-01-02')
  assert.equal(body.DueDate, '2026-01-31')
  assert.equal(body.Line[0].Amount, 123.45)
  assert.equal(body.Line[0].SalesItemLineDetail.UnitPrice, 123.45)
  assert.equal(body.PrivateNote, 'Thanks')
})

test('Xero invoice body uses ACCREC with the configured account code', () => {
  const body = xeroInvoiceBody(invoice, 'xero-contact', '200') as any
  const inv = body.Invoices[0]
  assert.equal(inv.Type, 'ACCREC')
  assert.equal(inv.Contact.ContactID, 'xero-contact')
  assert.equal(inv.InvoiceNumber, 'INV-100')
  assert.equal(inv.CurrencyCode, 'USD')
  assert.equal(inv.LineItems[0].AccountCode, '200')
  assert.equal(inv.LineItems[0].UnitAmount, 123.45)
})

test('MYOB contact keeps both email and phone in one SellingDetails object', () => {
  const body = myobContactBody(customer) as any
  assert.equal(body.CompanyName, 'Jane Doe')
  assert.deepEqual(body.SellingDetails, { SaleEmail: 'jane@example.com', SalePhone1: '+15551234567' })
})

test('MYOB invoice body posts number, customer UID and account', () => {
  const body = myobInvoiceBody(invoice, 'uid-1', '200') as any
  assert.equal(body.Number, 'INV-100')
  assert.equal(body.Customer.UID, 'uid-1')
  assert.equal(body.Terms.DueDate, '2026-01-31')
  assert.equal(body.Lines[0].Account.DisplayID, '200')
  assert.equal(body.Lines[0].Total, 123.45)
})

test('id parsers extract provider ids and surface provider errors', () => {
  assert.equal(parseQuickbooksId({ Invoice: { Id: 'qbo-1' } }, 'invoice'), 'qbo-1')
  assert.throws(() => parseQuickbooksId({ Fault: { Error: [{ Message: 'Duplicate DocNumber' }] } }, 'invoice'), /Duplicate DocNumber/)
  assert.equal(parseXeroId({ Contacts: [{ ContactID: 'x-1' }] }, 'contact'), 'x-1')
  assert.throws(() => parseXeroId({ Elements: [{ ValidationErrors: [{ Message: 'Account code required' }] }] }, 'invoice'), /Account code required/)
  assert.equal(parseMyobId({ UID: 'm-1' }), 'm-1')
  assert.throws(() => parseMyobId({ Errors: [{ Message: 'Invalid customer' }] }), /Invalid customer/)
})
