import test from 'node:test'
import assert from 'node:assert/strict'
import { assertOutboundUrl, isPrivateIp } from '../../src/lib/security/outbound.ts'

test('isPrivateIp blocks loopback, RFC1918, link-local and IPv6 local ranges', () => {
  for (const ip of [
    '127.0.0.1',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`)
  }
})

test('isPrivateIp allows public addresses and hostnames starting with fc/fd/fe80', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', 'fdic.gov', 'fc2.com', 'fe80.example.com']) {
    assert.equal(isPrivateIp(ip), false, `${ip} should be public`)
  }
})

test('assertOutboundUrl rejects non-http protocols and private literals', async () => {
  await assert.rejects(() => assertOutboundUrl('ftp://example.com/file'), /http:\/\/ or https:\/\//)
  await assert.rejects(() => assertOutboundUrl('http://127.0.0.1:8080/hook'), /private\/local/)
  await assert.rejects(() => assertOutboundUrl('http://localhost/hook'), /private\/local/)
  await assert.rejects(() => assertOutboundUrl('http://[::1]/hook'), /private\/local/)
})

test('assertOutboundUrl permits an explicit admin opt-in for private endpoints', async () => {
  const url = await assertOutboundUrl('http://127.0.0.1:8080/hook', { allowPrivate: true, label: 'Webhook URL' })
  assert.equal(url.hostname, '127.0.0.1')
})

test('assertOutboundUrl accepts a public literal IP without DNS', async () => {
  const url = await assertOutboundUrl('https://93.184.216.34/hook')
  assert.equal(url.protocol, 'https:')
})
