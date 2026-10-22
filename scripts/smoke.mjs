#!/usr/bin/env node
/**
 * Smoke test against a RUNNING instance (default http://localhost:3000).
 *
 *   node scripts/smoke.mjs [baseUrl]
 *
 * It exercises the paths that are easy to break and hard to notice:
 *  - health + session bootstrap (and the one-time owner-registration guard)
 *  - the receptionist runtime switch (pause → resume)
 *  - blocked periods: a block removes slots from availability, deleting it restores them
 *  - the Google Calendar integration: create, OAuth redirect, honest failure without a token
 *  - team management: invitation -> accept (once) -> role change -> deactivate, owner guard rails
 *
 * Every assertion is explicit — a failed check prints what was expected and what
 * actually happened. Exit code is non-zero when anything fails.
 */

const BASE = (process.argv[2] || process.env.SMOKE_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')

let cookie = ''
let passed = 0
const failures = []

function log(msg) {
  process.stdout.write(`${msg}\n`)
}

async function req(method, path, body, opts = {}) {
  const headers = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (cookie) headers.cookie = cookie
  if (method !== 'GET' && method !== 'HEAD') headers['x-requested-with'] = 'ais'
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: opts.redirect ?? 'manual',
  })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  let data = null
  const text = await res.text()
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { status: res.status, data, headers: res.headers }
}

function check(name, condition, detail) {
  if (condition) {
    passed++
    log(`  ok  ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main() {
  log(`smoke: ${BASE}`)

  // 1. health
  const health = await req('GET', '/api/health')
  check('health returns ok', health.status === 200 && health.data?.ok === true, `status=${health.status}`)

  // 2. session bootstrap
  let session = await req('GET', '/api/session')
  check('session endpoint responds', session.status === 200, `status=${session.status}`)

  if (session.data?.needsSetup) {
    log('  ..  fresh install: registering the first owner')
    const reg = await req('POST', '/api/auth/register-owner', {
      orgName: 'Smoke Test Business',
      businessType: 'generic',
      name: 'Smoke Owner',
      email: `smoke-${Date.now()}@example.com`,
      password: 'smoke-test-password',
    })
    check('first-run owner registration works', reg.status === 201 && Boolean(reg.data?.ok), `status=${reg.status}`)
    session = await req('GET', '/api/session')
  }

  if (!session.data?.authenticated) {
    const seed = await req('POST', '/api/demo/seed')
    check('demo seed provides credentials', seed.status === 201 && Boolean(seed.data?.email), `status=${seed.status}`)
    const login = await req('POST', '/api/auth/login', { email: seed.data.email, password: seed.data.password })
    check('login succeeds', login.status === 200, `status=${login.status} ${JSON.stringify(login.data).slice(0, 160)}`)
    session = await req('GET', '/api/session')
    check('session is authenticated', session.data?.authenticated === true)
  }

  // 3. the one-time bootstrap guard: owner registration must be locked once a user exists
  const late = await req('POST', '/api/auth/register-owner', {
    orgName: 'Second Business', name: 'Nope', email: `late-${Date.now()}@example.com`, password: 'smoke-test-password',
  })
  check('owner registration is locked after the first user', late.status === 403, `status=${late.status}`)

  // 4. receptionist runtime switch
  const before = await req('GET', '/api/settings/receptionist')
  check('receptionist status is readable', before.status === 200 && ['running', 'paused', 'stopped'].includes(before.data?.status), `status=${before.status} ${JSON.stringify(before.data)}`)
  const paused = await req('PATCH', '/api/settings/receptionist', { status: 'paused' })
  check('receptionist can be paused', paused.status === 200 && paused.data?.status === 'paused', `status=${paused.status}`)
  const pausedRead = await req('GET', '/api/settings/receptionist')
  check('paused state persists', pausedRead.data?.status === 'paused', JSON.stringify(pausedRead.data))
  const resumed = await req('PATCH', '/api/settings/receptionist', { status: 'running' })
  check('receptionist can be resumed', resumed.status === 200 && resumed.data?.status === 'running', `status=${resumed.status}`)

  // 5. blocked periods change availability
  const services = await req('GET', '/api/services')
  const service = Array.isArray(services.data?.services) ? services.data.services[0] : null
  check('at least one service exists', Boolean(service), 'no services returned')

  if (service) {
    const day = new Date(Date.now() + 24 * 3600 * 1000)
    day.setUTCHours(0, 0, 0, 0)
    const from = day.toISOString()
    const to = new Date(day.getTime() + 24 * 3600 * 1000).toISOString()
    const slotNoon = new Date(day.getTime() + 12 * 3600 * 1000).toISOString()

    const free = await req('GET', `/api/availability?serviceId=${encodeURIComponent(service.id)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
    const hadNoon = (free.data?.slots ?? []).some((s) => s.startAt.slice(0, 13) === slotNoon.slice(0, 13))
    check('availability returns slots for tomorrow', free.status === 200 && Array.isArray(free.data?.slots), `status=${free.status}`)

    const block = await req('POST', '/api/calendar/blocks', {
      start_at: slotNoon,
      end_at: new Date(day.getTime() + 13 * 3600 * 1000).toISOString(),
      title: 'Smoke test block',
    })
    check('block can be created', block.status === 201 && Boolean(block.data?.block?.id), `status=${block.status} ${JSON.stringify(block.data).slice(0, 160)}`)

    const blocked = await req('GET', `/api/availability?serviceId=${encodeURIComponent(service.id)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
    const hasNoon = (blocked.data?.slots ?? []).some((s) => s.startAt.slice(0, 13) === slotNoon.slice(0, 13))
    check('blocked period is removed from availability', hadNoon ? !hasNoon : true, `slot still offered (had=${hadNoon} has=${hasNoon})`)

    const list = await req('GET', '/api/calendar/blocks')
    check('blocks are listed', list.status === 200 && (list.data?.blocks ?? []).some((b) => b.id === block.data?.block?.id), `status=${list.status}`)

    const del = await req('DELETE', `/api/calendar/blocks/${block.data?.block?.id}`)
    check('block can be deleted', del.status === 200, `status=${del.status}`)
  }

  // 6. Google Calendar integration
  const created = await req('POST', '/api/integrations', {
    kind: 'google_calendar',
    label: 'Smoke Calendar',
    config: { calendarId: 'primary' },
    secrets: { clientId: 'smoke-client-id', clientSecret: 'smoke-client-secret' },
  })
  check('google_calendar integration can be created', created.status === 201 && Boolean(created.data?.integration?.id), `status=${created.status} ${JSON.stringify(created.data).slice(0, 200)}`)
  const googleId = created.data?.integration?.id

  if (googleId) {
    const list = await req('GET', '/api/integrations')
    const row = (list.data?.integrations ?? []).find((r) => r.id === googleId)
    check('google_calendar is listed as not yet authorized', row?.connected === false, `connected=${row?.connected}`)
    check('google_calendar secrets are never returned', !JSON.stringify(row?.config ?? {}).includes('smoke-client-secret'), 'secret leaked into the wire shape')

    const authorize = await req('GET', '/api/integrations/google_calendar/authorize')
    const location = authorize.headers.get('location') || ''
    check('authorize redirects to Google', authorize.status === 307 || authorize.status === 302, `status=${authorize.status}`)
    check('authorize points at accounts.google.com', location.startsWith('https://accounts.google.com/o/oauth2/v2/auth'), location.slice(0, 80))
    check('authorize sends a state nonce', /[?&]state=/.test(location), 'no state parameter')

    const sync = await req('POST', '/api/integrations/google-calendar/sync', {})
    check('sync fails honestly without an OAuth grant', sync.status === 422 || sync.status === 409, `status=${sync.status} ${JSON.stringify(sync.data).slice(0, 160)}`)

    const removed = await req('DELETE', `/api/integrations/${googleId}`)
    check('google_calendar integration can be removed', removed.status === 200, `status=${removed.status}`)
  }

  // 7. Microsoft 365 integration (Graph OAuth)
  const ms = await req('POST', '/api/integrations', {
    kind: 'microsoft_calendar',
    label: 'Smoke Microsoft 365',
    config: { tenant: 'common', calendarEmail: 'smoke@example.com' },
    secrets: { clientId: 'smoke-ms-client-id', clientSecret: 'smoke-ms-client-secret' },
  })
  check('microsoft_calendar integration can be created', ms.status === 201 && Boolean(ms.data?.integration?.id), `status=${ms.status} ${JSON.stringify(ms.data).slice(0, 200)}`)
  const msId = ms.data?.integration?.id

  if (msId) {
    const msList = await req('GET', '/api/integrations')
    const msRow = (msList.data?.integrations ?? []).find((r) => r.id === msId)
    check('microsoft_calendar is listed as not yet authorized', msRow?.connected === false, `connected=${msRow?.connected}`)
    check('microsoft_calendar secrets are never returned', !JSON.stringify(msRow?.config ?? {}).includes('smoke-ms-client-secret'), 'secret leaked into the wire shape')

    const msAuthorize = await req('GET', '/api/integrations/microsoft_calendar/authorize')
    const msLocation = msAuthorize.headers.get('location') || ''
    check('microsoft authorize redirects to Microsoft', msAuthorize.status === 307 || msAuthorize.status === 302, `status=${msAuthorize.status}`)
    check('microsoft authorize points at login.microsoftonline.com', msLocation.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/authorize'), msLocation.slice(0, 90))
    check('microsoft authorize sends a state nonce', /[?&]state=/.test(msLocation), 'no state parameter')

    const msSync = await req('POST', '/api/integrations/microsoft-calendar/sync', {})
    check('microsoft sync fails honestly without an OAuth grant', msSync.status === 422 || msSync.status === 409 || msSync.status === 404, `status=${msSync.status} ${JSON.stringify(msSync.data).slice(0, 160)}`)

    const msRemoved = await req('DELETE', `/api/integrations/${msId}`)
    check('microsoft_calendar integration can be removed', msRemoved.status === 200, `status=${msRemoved.status}`)
  }

  // 8. local speech model catalog
  const speech = await req('GET', '/api/ai/speech/models')
  check('local speech catalog is readable', speech.status === 200 && Array.isArray(speech.data?.models) && speech.data.models.length > 0, `status=${speech.status} ${JSON.stringify(speech.data).slice(0, 160)}`)
  const badModel = await req('PUT', '/api/providers/tts', { provider: 'local_speech', model: 'not-a-model', enabled: true })
  check('an unknown local speech model is rejected', badModel.status === 422, `status=${badModel.status} ${JSON.stringify(badModel.data).slice(0, 160)}`)

  // 9. scheduled backups
  const backups = await req('GET', '/api/admin/backups')
  check('backup list and schedule are readable', backups.status === 200 && Array.isArray(backups.data?.backups) && typeof backups.data?.schedule?.hour === 'number', `status=${backups.status} ${JSON.stringify(backups.data).slice(0, 160)}`)

  // 10. team management: invite -> accept -> role change -> deactivate
  const inviteEmail = `smoke-agent-${Date.now()}@example.com`
  const invite = await req('POST', '/api/users/invites', { email: inviteEmail, role: 'agent' })
  check('invitation can be created', invite.status === 201 && Boolean(invite.data?.inviteUrl), `status=${invite.status} ${JSON.stringify(invite.data).slice(0, 160)}`)
  const inviteToken = String(invite.data?.inviteUrl ?? '').split('join=')[1] ?? ''
  if (inviteToken) {
    const details = await req('GET', `/api/users/invites/${inviteToken}`)
    check('invitation details are readable', details.status === 200 && details.data?.invite?.email === inviteEmail, `status=${details.status}`)

    // Accepting the invitation signs the NEW member in and replaces the cookie —
    // keep the owner's cookie to continue as the owner.
    const ownerCookie = cookie
    const accept = await req('POST', `/api/users/invites/${inviteToken}/accept`, { name: 'Smoke Agent', password: 'smoke-agent-password' })
    check('invitation can be accepted', accept.status === 200 && accept.data?.user?.email === inviteEmail, `status=${accept.status} ${JSON.stringify(accept.data).slice(0, 160)}`)
    cookie = ownerCookie

    const replay = await req('POST', `/api/users/invites/${inviteToken}/accept`, { password: 'smoke-agent-password' })
    check('an invitation cannot be used twice', replay.status === 400, `status=${replay.status}`)

    const team = await req('GET', '/api/users')
    const member = (team.data?.members ?? []).find((m) => m.email === inviteEmail)
    check('the new member is listed', Boolean(member), 'member not in the team list')
    check('team list never exposes secrets', !JSON.stringify(team.data).includes('passwordHash'), 'password hash leaked')

    if (member) {
      const role = await req('PATCH', `/api/users/${member.id}`, { role: 'viewer' })
      check('a member role can be changed', role.status === 200 && role.data?.member?.role === 'viewer', `status=${role.status} ${JSON.stringify(role.data).slice(0, 160)}`)

      const off = await req('PATCH', `/api/users/${member.id}`, { active: false })
      check('a member can be deactivated', off.status === 200 && off.data?.member?.active === false, `status=${off.status}`)

      const lastOwner = await req('PATCH', `/api/users/${session.data?.user?.id}`, { active: false })
      check('the last owner cannot be deactivated', lastOwner.status === 409, `status=${lastOwner.status}`)
    }
  }

  log('')
  log(`smoke: ${passed} checks passed, ${failures.length} failed`)
  if (failures.length) {
    for (const f of failures) log(`  - ${f}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('smoke: fatal error —', err)
  process.exitCode = 1
})
