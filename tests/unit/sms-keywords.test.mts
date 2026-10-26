import test from 'node:test'
import assert from 'node:assert/strict'
import { consentKeyword } from '../../src/lib/telephony/sms-keywords.ts'

test('recognizes stop keywords case-insensitively and with punctuation', () => {
  for (const body of ['STOP', ' stop ', 'Stop.', 'UNSUBSCRIBE', 'cancel!', 'END', 'quit', 'STOPALL']) {
    assert.equal(consentKeyword(body), 'stop', body)
  }
})

test('recognizes start keywords', () => {
  for (const body of ['START', 'Unstop', 'Resume.']) {
    assert.equal(consentKeyword(body), 'start', body)
  }
})

test('does not treat normal messages as consent changes', () => {
  assert.equal(consentKeyword('I want to stop by tomorrow'), null)
  assert.equal(consentKeyword('Can I start at 9?'), null)
  assert.equal(consentKeyword(''), null)
  assert.equal(consentKeyword('YES please book it'), null)
  assert.equal(consentKeyword('yes'), null)
  assert.equal(consentKeyword('STOPPING by'), null)
})
