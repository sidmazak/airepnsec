import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLineCandidates,
  normalizeAgentLines,
  normalizeCallStatus,
  pickLeastBusy,
  pickRedirect,
  pickRoundRobin,
} from '../../src/lib/telephony/routing.ts'

const lines = [
  { number: '+15550001', label: 'Sales', enabled: true },
  { number: '+15550002', label: 'Support', enabled: true },
  { number: '+15550003', label: 'Off', enabled: false },
]
const states = [
  { id: 'line-1', phoneNumber: '+15550001', enabled: true, acceptingCalls: true, priority: 10 },
  { id: 'line-2', phoneNumber: '+15550002', enabled: true, acceptingCalls: true, priority: 20 },
  { id: 'line-3', phoneNumber: '+15550003', enabled: true, acceptingCalls: true, priority: 30 },
]

test('normalizeAgentLines drops blank/invalid entries and keeps labels', () => {
  const parsed = normalizeAgentLines([
    { number: ' +1555 ', label: ' Desk ' },
    { number: '', label: 'nope' },
    null,
    { label: 'missing number' },
    { number: '+1666', enabled: false },
  ])
  assert.deepEqual(parsed, [
    { number: '+1555', label: 'Desk', enabled: true },
    { number: '+1666', label: '+1666', enabled: false },
  ])
  assert.deepEqual(normalizeAgentLines(undefined), [])
  assert.deepEqual(normalizeAgentLines('nope' as unknown), [])
})

test('buildLineCandidates excludes disabled and paused lines, counts load by line id', () => {
  const paused = states.map((s) => (s.id === 'line-2' ? { ...s, acceptingCalls: false } : s))
  const candidates = buildLineCandidates(lines, paused, [{ lineId: 'line-1' }, { lineId: 'line-1' }, { lineId: '' }])
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].number, '+15550001')
  assert.equal(candidates[0].load, 2)
  assert.equal(candidates[0].priority, 10)
})

test('lines without a TelephonyLine row stay eligible with zero load', () => {
  const candidates = buildLineCandidates([{ number: '+1777', label: '+1777', enabled: true }], [], [])
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].load, 0)
  assert.equal(candidates[0].priority, 100)
})

test('least busy picks the lowest active load, then priority, then config order', () => {
  const candidates = buildLineCandidates(lines, states, [{ lineId: 'line-1' }, { lineId: 'line-1' }])
  assert.equal(pickLeastBusy(candidates)?.number, '+15550002')

  const tie = buildLineCandidates(lines, states, [])
  assert.equal(pickLeastBusy(tie)?.number, '+15550001')
  assert.equal(pickLeastBusy([...tie].reverse())?.number, '+15550001')
  assert.equal(pickLeastBusy([]), null)
})

test('round robin advances through eligible candidates and wraps', () => {
  const candidates = buildLineCandidates(lines, states, [])
  assert.equal(pickRoundRobin(candidates, -1)?.number, '+15550001')
  assert.equal(pickRoundRobin(candidates, 0)?.number, '+15550002')
  assert.equal(pickRoundRobin(candidates, 1)?.number, '+15550001')
  assert.equal(pickRoundRobin([], 0), null)
})

test('redirect target is deterministic by priority, ignoring load', () => {
  const candidates = buildLineCandidates(lines, states, [{ lineId: 'line-1' }, { lineId: 'line-1' }])
  assert.equal(pickRedirect(candidates)?.number, '+15550001')
  assert.equal(pickRedirect([]), null)
})

test('normalizeCallStatus maps Twilio states', () => {
  assert.equal(normalizeCallStatus('ringing'), 'started')
  assert.equal(normalizeCallStatus('queued'), 'started')
  assert.equal(normalizeCallStatus('in-progress'), 'answered')
  assert.equal(normalizeCallStatus('no-answer'), 'missed')
  assert.equal(normalizeCallStatus('busy'), 'missed')
  assert.equal(normalizeCallStatus('canceled'), 'missed')
  assert.equal(normalizeCallStatus('failed'), 'failed')
  assert.equal(normalizeCallStatus('completed'), 'completed')
  assert.equal(normalizeCallStatus('weird'), 'weird')
  assert.equal(normalizeCallStatus(''), 'unknown')
})
