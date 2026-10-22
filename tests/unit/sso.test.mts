import test from 'node:test'
import assert from 'node:assert/strict'
import { createPkcePair, base64url, signSsoState, verifySsoState, SSO_STATE_TTL_MS } from '../../src/lib/security/sso.ts'
import { extractSamlIdentity, resolveExternalIdentity, normalizeEmail, emailDomain } from '../../src/lib/security/sso.ts'
import { createHash } from 'node:crypto'

test('createPkcePair produces verifier and challenge', () => {
  const { verifier, challenge } = createPkcePair()
  assert.ok(typeof verifier === 'string' && verifier.length >= 43)
  assert.ok(typeof challenge === 'string' && challenge.length > 0)
  // challenge should be S256 of the base64url-encoded verifier string (not raw bytes)
  const expectedChallenge = base64url(createHash('sha256').update(verifier).digest())
  assert.equal(challenge, expectedChallenge)
})

test('base64url encodes and decodes correctly', () => {
  const input = Buffer.from('hello world!')
  const encoded = base64url(input)
  assert.ok(!encoded.includes('+') && !encoded.includes('/') && !encoded.includes('='))
  // round-trip
  const decoded = Buffer.from(encoded, 'base64url')
  assert.deepEqual(decoded, input)
})

test('signSsoState and verifySsoState round-trip', () => {
  const secret = 'test-secret-key'
  const state = {
    orgId: 'org-1',
    kind: 'oidc' as const,
    nonce: 'abc123',
    codeVerifier: 'verifier',
    returnTo: '/dashboard',
    createdAt: Date.now(),
  }
  const token = signSsoState(state, secret)
  const result = verifySsoState(token, secret)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.state.orgId, state.orgId)
    assert.equal(result.state.kind, state.kind)
    assert.equal(result.state.nonce, state.nonce)
    assert.equal(result.state.codeVerifier, state.codeVerifier)
    assert.equal(result.state.returnTo, state.returnTo)
  }
})

test('verifySsoState rejects tampered token', () => {
  const secret = 'test-secret-key'
  const state = { orgId: 'org-1', kind: 'oidc' as const, nonce: '', codeVerifier: '', returnTo: '/', createdAt: Date.now() }
  const token = signSsoState(state, secret)
  const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a')
  const result = verifySsoState(tampered, secret)
  assert.equal(result.ok, false)
})

test('verifySsoState rejects expired token', () => {
  const secret = 'test-secret-key'
  const state = { orgId: 'org-1', kind: 'oidc' as const, nonce: '', codeVerifier: '', returnTo: '/', createdAt: Date.now() - SSO_STATE_TTL_MS - 1000 }
  const token = signSsoState(state, secret)
  const result = verifySsoState(token, secret)
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.reason.includes('expired'))
})

test('extractSamlIdentity maps common attributes', () => {
  const attrs = {
    email: 'user@example.com',
    mail: 'user@example.com',
    displayName: 'John Doe',
    givenName: 'John',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'user@example.com',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name': 'John Doe',
    uid: 'user123',
    nameId: 'user@example.com',
    email_verified: 'true',
  }
  const identity = extractSamlIdentity(attrs)
  assert.equal(identity.email, 'user@example.com')
  assert.equal(identity.name, 'John Doe')
  assert.equal(identity.subject, 'user123')
  assert.equal(identity.emailVerified, true)
})

test('extractSamlIdentity handles array values', () => {
  const attrs = { email: ['user@example.com', 'alt@example.com'], nameId: 'user@example.com' }
  const identity = extractSamlIdentity(attrs)
  assert.equal(identity.email, 'user@example.com')
})

test('extractSamlIdentity defaults emailVerified to true when absent', () => {
  const attrs = { email: 'user@example.com' }
  const identity = extractSamlIdentity(attrs)
  assert.equal(identity.emailVerified, true)
})

test('resolveExternalIdentity provisions when autoProvision=true', () => {
  const policy = { autoProvision: true, defaultRole: 'agent', domainAllowlist: [], linkExisting: true, requireVerifiedEmail: true }
  const result = resolveExternalIdentity({
    identity: { subject: 'sub-1', email: 'new@example.com', emailVerified: true, name: 'New User' },
    orgId: 'org-1',
    config: policy,
  })
  assert.deepEqual(result, { action: 'provision', role: 'agent', name: 'New User' })
})

test('resolveExternalIdentity rejects when autoProvision=false and no account', () => {
  const policy = { autoProvision: false, defaultRole: 'agent', domainAllowlist: [], linkExisting: true, requireVerifiedEmail: true }
  const result = resolveExternalIdentity({
    identity: { subject: 'sub-1', email: 'new@example.com', emailVerified: true },
    orgId: 'org-1',
    config: policy,
  })
  assert.deepEqual(result, { action: 'reject', reason: 'No account exists for this identity. Ask an administrator for an invitation.' })
})

test('resolveExternalIdentity links existing by subject', () => {
  const policy = { autoProvision: true, defaultRole: 'agent', domainAllowlist: [], linkExisting: true, requireVerifiedEmail: true }
  const result = resolveExternalIdentity({
    identity: { subject: 'sub-1', email: 'existing@example.com', emailVerified: true },
    existingBySubject: { id: 'user-1', orgId: 'org-1', active: true },
    orgId: 'org-1',
    config: policy,
  })
  assert.deepEqual(result, { action: 'link', userId: 'user-1' })
})

test('resolveExternalIdentity links existing by email when linkExisting=true', () => {
  const policy = { autoProvision: true, defaultRole: 'agent', domainAllowlist: [], linkExisting: true, requireVerifiedEmail: true }
  const result = resolveExternalIdentity({
    identity: { subject: 'sub-new', email: 'existing@example.com', emailVerified: true },
    existing: { id: 'user-1', orgId: 'org-1', active: true },
    orgId: 'org-1',
    config: policy,
  })
  assert.deepEqual(result, { action: 'link', userId: 'user-1' })
})

test('resolveExternalIdentity rejects when linkExisting=false and email exists', () => {
  const policy = { autoProvision: true, defaultRole: 'agent', domainAllowlist: [], linkExisting: false, requireVerifiedEmail: true }
  const result = resolveExternalIdentity({
    identity: { subject: 'sub-new', email: 'existing@example.com', emailVerified: true },
    existing: { id: 'user-1', orgId: 'org-1', active: true },
    orgId: 'org-1',
    config: policy,
  })
  assert.deepEqual(result, { action: 'reject', reason: 'This e-mail already has a local account. Sign in with your password instead.' })
})

test('resolveExternalIdentity rejects unverified email when requireVerifiedEmail=true', () => {
  const policy = { autoProvision: true, defaultRole: 'agent', domainAllowlist: [], linkExisting: true, requireVerifiedEmail: true }
  const result = resolveExternalIdentity({
    identity: { subject: 'sub-1', email: 'user@example.com', emailVerified: false },
    orgId: 'org-1',
    config: policy,
  })
  assert.deepEqual(result, { action: 'reject', reason: 'The identity provider has not verified this e-mail address.' })
})

test('resolveExternalIdentity rejects disallowed domain', () => {
  const policy = { autoProvision: true, defaultRole: 'agent', domainAllowlist: ['allowed.com'], linkExisting: true, requireVerifiedEmail: true }
  const result = resolveExternalIdentity({
    identity: { subject: 'sub-1', email: 'user@blocked.com', emailVerified: true },
    orgId: 'org-1',
    config: policy,
  })
  assert.deepEqual(result, { action: 'reject', reason: 'E-mail domain "blocked.com" is not allowed to sign in.' })
})

test('normalizeEmail lowercases and trims', () => {
  assert.equal(normalizeEmail('  User@Example.COM  '), 'user@example.com')
})

test('emailDomain extracts domain part', () => {
  assert.equal(emailDomain('user@example.com'), 'example.com')
  assert.equal(emailDomain('user@sub.example.com'), 'sub.example.com')
  assert.equal(emailDomain('invalid'), '')
})