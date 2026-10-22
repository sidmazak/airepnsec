import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import {
  buildSpMetadataXml,
  buildIdpMetadataXml,
  certToBase64,
  createSamlLoginUrl,
  parseSamlLoginResponse,
} from '../../src/lib/security/saml.ts'

import * as saml from 'samlify'

// Check if openssl is available for generating test certificates
let opensslAvailable = false
try {
  const result = spawnSync('openssl', ['version'], { encoding: 'utf8' })
  opensslAvailable = result.status === 0
} catch {
  opensslAvailable = false
}

// Generate a test certificate/key pair using openssl
async function generateTestCert(): Promise<{ keyPem: string; certPem: string } | null> {
  if (!opensslAvailable) return null
  const dir = join(tmpdir(), `saml-test-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const keyPath = join(dir, 'key.pem')
  const certPath = join(dir, 'cert.pem')

  // Generate private key
  spawnSync('openssl', ['genrsa', '-out', keyPath, '2048'], { encoding: 'utf8' })
  // Generate self-signed cert
  spawnSync('openssl', ['req', '-x509', '-new', '-key', keyPath, '-out', certPath, '-days', '1', '-nodes', '-subj', '/CN=Test IdP'], { encoding: 'utf8' })

  if (!existsSync(keyPath) || !existsSync(certPath)) {
    rmSync(dir, { recursive: true, force: true })
    return null
  }

  const keyPem = readFileSync(keyPath, 'utf8')
  const certPem = readFileSync(certPath, 'utf8')
  rmSync(dir, { recursive: true, force: true })
  return { keyPem, certPem }
}

test('buildSpMetadataXml includes entityID and ACS URL', () => {
  const config = {
    label: 'Test SP',
    entityId: 'https://sp.example.com/metadata',
    acsUrl: 'https://sp.example.com/acs',
    idpEntityId: 'https://idp.example.com',
    idpSsoUrl: 'https://idp.example.com/sso',
    idpCertificate: 'MIID...',
  }
  const xml = buildSpMetadataXml(config)
  assert.ok(xml.includes('entityID="https://sp.example.com/metadata"'))
  assert.ok(xml.includes('AssertionConsumerService'))
  assert.ok(xml.includes('https://sp.example.com/acs'))
  assert.ok(xml.includes('HTTP-POST'))
  assert.ok(xml.includes('NameIDFormat'))
})

test('buildIdpMetadataXml includes entityID, SSO URL, and certificate', () => {
  const config = {
    label: 'Test IdP',
    entityId: 'https://sp.example.com/metadata',
    acsUrl: 'https://sp.example.com/acs',
    idpEntityId: 'https://idp.example.com',
    idpSsoUrl: 'https://idp.example.com/sso',
    idpCertificate: '-----BEGIN CERTIFICATE-----\nMIID...\n-----END CERTIFICATE-----',
  }
  const xml = buildIdpMetadataXml(config)
  assert.ok(xml.includes('entityID="https://idp.example.com"'))
  assert.ok(xml.includes('SingleSignOnService'))
  assert.ok(xml.includes('https://idp.example.com/sso'))
  assert.ok(xml.includes('X509Certificate'))
  assert.ok(xml.includes('MIID...'))
})

test('certToBase64 strips PEM headers', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nMIID...\n-----END CERTIFICATE-----'
  const base64 = certToBase64(pem)
  assert.equal(base64, 'MIID...')
})

test('certToBase64 handles raw base64', () => {
  const raw = 'MIID...'
  const base64 = certToBase64(raw)
  assert.equal(base64, 'MIID...')
})

test('createSamlLoginUrl returns redirect URL and requestId', async () => {
  const { keyPem, certPem } = await generateTestCert()
  if (!keyPem) {
    test.skip('openssl not available, skipping')
    return
  }

  const config = {
    label: 'Test SAML',
    entityId: 'https://sp.example.com/metadata',
    acsUrl: 'https://sp.example.com/acs',
    idpEntityId: 'https://idp.example.com',
    idpSsoUrl: 'https://idp.example.com/sso',
    idpCertificate: certPem,
  }

  const { url, requestId } = createSamlLoginUrl(config, '/after-login')
  assert.ok(url.startsWith('https://idp.example.com/sso'))
  assert.ok(url.includes('SAMLRequest='))
  assert.ok(url.includes('RelayState=%2Fafter-login'))
  assert.ok(typeof requestId === 'string' && requestId.length > 0)
})

test('parseSamlLoginResponse rejects empty SAMLResponse', async () => {
  const config = {
    label: 'Test SAML',
    entityId: 'https://sp.example.com/metadata',
    acsUrl: 'https://sp.example.com/acs',
    idpEntityId: 'https://idp.example.com',
    idpSsoUrl: 'https://idp.example.com/sso',
    idpCertificate: 'MIID...',
  }

  const result = await parseSamlLoginResponse(config, { SAMLResponse: '' })
  assert.equal(result.ok, false)
  assert.ok(result.reason.includes('did not send'))
})

test('parseSamlLoginResponse rejects garbage SAMLResponse', async () => {
  const config = {
    label: 'Test SAML',
    entityId: 'https://sp.example.com/metadata',
    acsUrl: 'https://sp.example.com/acs',
    idpEntityId: 'https://idp.example.com',
    idpSsoUrl: 'https://idp.example.com/sso',
    idpCertificate: 'MIID...',
  }

  const result = await parseSamlLoginResponse(config, { SAMLResponse: 'not-base64!' })
  assert.equal(result.ok, false)
})

test('parseSamlLoginResponse normalizes spaces to plus in base64', async () => {
  const { keyPem, certPem } = await generateTestCert()
  if (!keyPem) {
    test.skip('openssl not available, skipping')
    return
  }

  const config = {
    label: 'Test SAML',
    entityId: 'https://sp.example.com/metadata',
    acsUrl: 'https://sp.example.com/acs',
    idpEntityId: 'https://idp.example.com',
    idpSsoUrl: 'https://idp.example.com/sso',
    idpCertificate: certPem,
  }

  const { sp } = await import('../../src/lib/security/saml.ts').then(m => m.buildSamlEntities(config))
  // Create IdP with private key for signing AND loginResponseTemplate for attributes
  const signingIdp = saml.IdentityProvider({
    metadata: buildIdpMetadataXml(config),
    privateKey: keyPem,
    loginResponseTemplate: {
      context: saml.SamlLib.defaultLoginResponseTemplate.context,
      attributes: [
        { name: 'email', valueTag: 'email', nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic' },
      ],
    },
  })

  // Create a valid signed response
  const { context: redirectUrl } = sp.createLoginRequest(signingIdp, 'redirect', { relayState: '/' })
  const raw = redirectUrl.match(/SAMLRequest=([^&]+)/)![1]
  const requestInfo: any = await signingIdp.parseLoginRequest(sp, 'redirect', { query: { SAMLRequest: raw } })

  // Create response using loginResponseTemplate (no customTagReplacement needed)
  const response = await signingIdp.createLoginResponse(sp, requestInfo, 'post', {
    email: 'test@example.com',
  })

  // Normal base64 should work
  const goodResult = await parseSamlLoginResponse(config, { SAMLResponse: response.context })
  assert.equal(goodResult.ok, true)
  assert.equal(goodResult.nameId, 'test@example.com')

  // With spaces instead of + (simulating form-urlencoded corruption)
  const withSpaces = response.context.replace(/\+/g, ' ')
  const spaceResult = await parseSamlLoginResponse(config, { SAMLResponse: withSpaces })
  assert.equal(spaceResult.ok, true, 'Should normalize spaces back to +')
  assert.equal(spaceResult.nameId, 'test@example.com')
})

test('SAML round-trip: signed response parses, tampered/unsigned rejected', async () => {
  const { keyPem, certPem } = await generateTestCert()
  if (!keyPem) {
    test.skip('openssl not available, skipping')
    return
  }

  const config = {
    label: 'Test SAML',
    entityId: 'https://sp.example.com/metadata',
    acsUrl: 'https://sp.example.com/acs',
    idpEntityId: 'https://idp.example.com',
    idpSsoUrl: 'https://idp.example.com/sso',
    idpCertificate: certPem,
  }

  const { sp } = await import('../../src/lib/security/saml.ts').then(m => m.buildSamlEntities(config))
  const signingIdp = saml.IdentityProvider({
    metadata: buildIdpMetadataXml(config),
    privateKey: keyPem,
    loginResponseTemplate: {
      context: saml.SamlLib.defaultLoginResponseTemplate.context,
      attributes: [
        { name: 'email', valueTag: 'email', nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic' },
        { name: 'firstName', valueTag: 'firstName', nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic' },
      ],
    },
  })

  // 1. SP creates AuthnRequest
  const { context: redirectUrl, id: requestId } = sp.createLoginRequest(signingIdp, 'redirect', { relayState: '/after-login' })

  // 2. IdP parses request
  const raw = redirectUrl.match(/SAMLRequest=([^&]+)/)![1]
  const requestInfo: any = await signingIdp.parseLoginRequest(sp, 'redirect', { query: { SAMLRequest: raw } })

  // 3. IdP creates signed response
  const response = await signingIdp.createLoginResponse(sp, requestInfo, 'post', {
    email: 'user@example.com',
    firstName: 'John',
  })

  // 4. SP parses response - verify signature, InResponseTo, tamper detection
  const parsed = await parseSamlLoginResponse(config, { SAMLResponse: response.context }, { inResponseTo: requestId })
  assert.equal(parsed.ok, true, `Parse failed: ${parsed.reason}`)
  assert.equal(parsed.nameId, 'user@example.com')
  assert.ok(parsed.inResponseTo === requestId, 'InResponseTo should match request ID')

  // 5. Tampered response rejected
  const tampered = Buffer.from(response.context, 'base64')
  tampered[20] ^= 0xff
  const bad = await parseSamlLoginResponse(config, { SAMLResponse: tampered.toString('base64') })
  assert.equal(bad.ok, false, 'Tampered response should be rejected')

  // 6. Unsigned response rejected
  const unsigned = Buffer.from(response.context.replace(/<ds:Signature>[\s\S]*?<\/ds:Signature>/, ''), 'utf8').toString('base64')
  const bad2 = await parseSamlLoginResponse(config, { SAMLResponse: unsigned })
  assert.equal(bad2.ok, false, 'Unsigned response should be rejected')
})

test('fetchAndParseIdpMetadata is exported', async () => {
  const mod = await import('../../src/lib/security/saml.ts')
  assert.ok(typeof mod.fetchAndParseIdpMetadata === 'function')
})