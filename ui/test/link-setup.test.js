import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { blockedBy, continueBody, hostOf, invalidText, linksFact, linksGate, MODES, problemFor, TAILSCALE_STATE } from '../src/lib/link-setup.js'

const ADDRESS = 'https://mac.tail1234.ts.net:8443'

test('the panel offers Tailscale, My own URL and Only on this Mac, in that order', () => {
  assert.deepEqual(MODES.map(mode => mode.label), ['Tailscale', 'My own URL', 'Only on this Mac'])
})

test('Turn on pickup waits for links, unlocks for ready or Only on this Mac, and stays on for an older backend', () => {
  assert.deepEqual(linksGate({ status: 'missing' }), { ready: false, local: false, known: true })
  assert.deepEqual(linksGate({ status: 'invalid', reason: 'not_https' }), { ready: false, local: false, known: true })
  assert.deepEqual(linksGate({ status: 'restart_needed' }), { ready: false, local: false, known: true })
  assert.deepEqual(linksGate({ status: 'ready' }), { ready: true, local: false, known: true })
  assert.deepEqual(linksGate({ status: 'local', mode: 'local' }), { ready: true, local: true, known: true })
  assert.deepEqual(linksGate(null), { ready: true, local: false, known: false })
  assert.deepEqual(linksGate({}), { ready: true, local: false, known: false })
})

test('the Task links row: Not set up · Set up, This Mac only · Set up phone access, or the host', () => {
  assert.deepEqual(linksFact({ status: 'missing' }), { text: 'Not set up', host: null, action: 'Set up' })
  assert.deepEqual(linksFact({ status: 'invalid' }), { text: 'Not set up', host: null, action: 'Set up' })
  assert.deepEqual(linksFact({ status: 'local' }), { text: 'This Mac only', host: null, action: 'Set up phone access' })
  assert.deepEqual(linksFact({ status: 'restart_needed' }), { text: 'Restart needed', host: null, action: 'Set up' })
  assert.deepEqual(linksFact({ status: 'ready' }, ADDRESS), { text: null, host: 'mac.tail1234.ts.net:8443', action: 'Change' })
  assert.deepEqual(linksFact({ status: 'ready' }), { text: 'Ready', host: null, action: 'Change' })
  assert.equal(linksFact(null), null)
})

test('the panel is blocked before any write that would expose or break the dashboard', () => {
  const ok = { running: true, local: 'http://127.0.0.1:9119', signin: 'password' }
  assert.equal(blockedBy({ dashboard: ok, can_write: true }), null)
  assert.equal(blockedBy({ dashboard: { ...ok, running: false }, can_write: true }), 'dashboard')
  assert.equal(blockedBy({ dashboard: { ...ok, signin: null }, can_write: true }), 'signin')
  assert.equal(blockedBy({ dashboard: ok, can_write: false }), 'env')
  assert.equal(blockedBy(undefined), null)
})

test('Check again after Restart needed continues the same setup', () => {
  const tailscale = { state: 'ready', address: ADDRESS }
  assert.deepEqual(continueBody({ address: ADDRESS, tailscale }), { mode: 'tailscale', expected: ADDRESS })
  assert.deepEqual(continueBody({ address: 'https://hermes.example.com', tailscale }), { mode: 'own', address: 'https://hermes.example.com' })
  assert.equal(continueBody({ address: null }), null)
})

test('every refusal reads as one plain line; ok and ready read as none', () => {
  for (const status of ['not_https', 'loopback', 'has_path', 'has_credentials', 'unreachable', 'other_server', 'no_signin', 'password_on_public', 'no_dashboard', 'env_override', 'stale', 'funnel_on', 'changed_since', 'unavailable', 'something_new']) {
    const line = problemFor(status)
    assert.ok(line && line.endsWith('.'), status)
    assert.doesNotMatch(line, /_/, status)
  }
  assert.equal(problemFor('ok'), null)
  assert.equal(problemFor('ready'), null)
  assert.match(invalidText('not_https'), /https:\/\//)
  assert.equal(hostOf(ADDRESS), 'mac.tail1234.ts.net:8443')
  assert.equal(TAILSCALE_STATE.signed_out.fix.label, 'Open Tailscale')
})

test('a shipped build never carries the task-link setup stub', () => {
  const bundle = readFileSync(new URL('../../desktop/plugin.js', import.meta.url), 'utf8')
  assert.doesNotMatch(bundle, /__rkLinkStub/)
  assert.match(bundle, /Open tasks from your phone/)
})

test('Restart needed shows the saved address until a tab is chosen, so an unreachable one can be replaced', async () => {
  const { savedAddress } = await import('../src/lib/link-setup.js')
  const stuck = { status: 'restart_needed', address: ADDRESS, reason: 'unreachable' }
  assert.equal(savedAddress(stuck, null, { mode: 'tailscale', editing: false }), ADDRESS)
  // Choosing My own URL (or Tailscale) leaves the saved view for a new address.
  assert.equal(savedAddress(stuck, null, { mode: 'own', editing: true }), null)
  assert.equal(savedAddress(stuck, null, { mode: 'local', editing: false }), null)
  // In local mode the read says `local`; the apply answer carries the saved address.
  assert.equal(savedAddress({ status: 'local' }, ADDRESS, { mode: 'tailscale', editing: false }), ADDRESS)
  assert.equal(savedAddress({ status: 'ready', address: ADDRESS }, ADDRESS, { mode: 'tailscale', editing: false }), null)
  assert.equal(savedAddress({ status: 'missing' }, null, { mode: 'tailscale', editing: false }), null)
})
