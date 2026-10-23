import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mailchimpMembersRequest,
  parseMailchimpContacts,
  parseShopifyContacts,
  parseWixContacts,
  parseWooCommerceContacts,
  shopifyCustomersRequest,
  wixContactsRequest,
  wooCommerceCustomersRequest,
} from '../../src/lib/integrations/commerce-protocol.ts'

test('Shopify request pins the admin API version and access-token header', () => {
  const req = shopifyCustomersRequest('https://my-store.myshopify.com/admin', 'shpat_x')
  assert.equal(req.url, 'https://my-store.myshopify.com/admin/api/2024-10/customers.json?limit=250')
  assert.equal(req.headers['x-shopify-access-token'], 'shpat_x')
  assert.throws(() => shopifyCustomersRequest('not a domain', 'x'))
})

test('WooCommerce request uses basic auth and the v3 customers endpoint', () => {
  const req = wooCommerceCustomersRequest('shop.example.com/', 'ck_1', 'cs_1')
  assert.equal(req.url, 'https://shop.example.com/wp-json/wc/v3/customers?per_page=100')
  assert.equal(req.headers.authorization, `Basic ${Buffer.from('ck_1:cs_1').toString('base64')}`)
})

test('Wix request sends the API key and site id headers', () => {
  const req = wixContactsRequest('site-1', 'IST.key')
  assert.equal(req.url, 'https://www.wixapis.com/contacts/v4/contacts?paging.limit=100')
  assert.equal(req.headers.authorization, 'IST.key')
  assert.equal(req.headers['wix-site-id'], 'site-1')
})

test('Mailchimp request derives the datacenter from the server prefix', () => {
  const req = mailchimpMembersRequest('us21', 'list/1', 'key-us21')
  assert.equal(req.url, 'https://us21.api.mailchimp.com/3.0/lists/list%2F1/members?count=500')
  assert.equal(req.headers.authorization, `Basic ${Buffer.from('anystring:key-us21').toString('base64')}`)
  assert.throws(() => mailchimpMembersRequest('', 'list', 'key'))
})

test('Shopify parser maps names, emails, phones and comma-separated tags', () => {
  const contacts = parseShopifyContacts({
    customers: [{ id: 1, first_name: 'Jane', last_name: 'Doe', email: 'Jane@Example.com', phone: '+1555', tags: 'vip, wholesale' }],
  })
  assert.deepEqual(contacts, [{ externalId: '1', name: 'Jane Doe', email: 'jane@example.com', phone: '+1555', tags: ['vip', 'wholesale'] }])
})

test('WooCommerce parser falls back to billing email/phone', () => {
  const contacts = parseWooCommerceContacts([
    { id: 2, first_name: 'Sam', last_name: '', username: 'sam', email: '', billing: { email: 'sam@example.com', phone: '+1666' } },
  ])
  assert.deepEqual(contacts, [{ externalId: '2', name: 'Sam', email: 'sam@example.com', phone: '+1666', tags: [] }])
})

test('Wix parser reads nested info name/emails/phones and labels', () => {
  const contacts = parseWixContacts({
    contacts: [
      {
        id: 'w1',
        info: {
          name: { first: 'Ada', last: 'Lovelace' },
          emails: { items: [{ email: 'ada@example.com' }] },
          phones: { items: [{ phone: '+1777' }] },
        },
        labels: [{ name: 'vip' }, 'newsletter'],
      },
    ],
  })
  assert.deepEqual(contacts, [{ externalId: 'w1', name: 'Ada Lovelace', email: 'ada@example.com', phone: '+1777', tags: ['vip', 'newsletter'] }])
})

test('Mailchimp parser reads merge fields, phone and tag names', () => {
  const contacts = parseMailchimpContacts({
    members: [{ id: 'm1', email_address: 'Mia@Example.com', merge_fields: { FNAME: 'Mia', LNAME: 'Ng', PHONE: '+1888' }, tags: [{ name: 'customer' }] }],
  })
  assert.deepEqual(contacts, [{ externalId: 'm1', name: 'Mia Ng', email: 'mia@example.com', phone: '+1888', tags: ['customer'] }])
})

test('parsers drop rows without an external id or any contact detail', () => {
  assert.deepEqual(parseShopifyContacts({ customers: [{ id: 1 }] }), [])
  assert.deepEqual(parseMailchimpContacts({ members: [{ email_address: 'x@y.com' }] }), [])
})
