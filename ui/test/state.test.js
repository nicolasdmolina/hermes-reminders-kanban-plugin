import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classifyError, deriveView, SupersededError } from '../src/lib/state.js'

const COLUMNS = ['To do', 'Ready for Agent', 'In progress', 'Needs you', 'Done']
const card = { id: 'c1', owner: 'human', column: 'To do', imported_ready: false, source: { title: 'Milk', calendarId: 'a' } }

function envelope(status, overrides = {}) {
  return {
    status,
    error: null,
    owner_id: 'owner',
    pickup_enabled: false,
    effective_concurrency: 3,
    columns: COLUMNS,
    setup: { selected_list_ids: [], stage: 'select_lists' },
    lists: [],
    cards: [],
    observed_at: null,
    ready_count: 0,
    ...overrides
  }
}

const selected = { setup: { selected_list_ids: ['a'], stage: 'preview' }, lists: [{ id: 'a', title: 'RK Test' }] }

test('fresh install paints connect while /preview checks access', () => {
  const view = deriveView({ setup: envelope('loading'), previewPending: true })
  assert.equal(view.screen, 'onboarding')
  assert.equal(view.step, 'connect')
})

test('access granted with no selection asks for lists, including when none exist', () => {
  const view = deriveView({ setup: envelope('loading'), preview: envelope('select_lists', { lists: [] }) })
  assert.deepEqual([view.screen, view.step], ['onboarding', 'lists'])
})

test('denied before any selection stays on the connect step with recovery', () => {
  const view = deriveView({ preview: envelope('access_denied', { error: { code: 'access_denied' } }) })
  assert.deepEqual([view.screen, view.step, view.denied], ['onboarding', 'connect', true])
})

test('a first selection shows review, then the board after it is dismissed', () => {
  const ready = envelope('ready', { ...selected, cards: [card], observed_at: '2026-11-05T18:00:00+00:00' })
  assert.equal(deriveView({ preview: ready, reviewing: true }).step, 'review')
  assert.equal(deriveView({ preview: ready }).screen, 'board')
})

test('reopening paints saved cards from /setup before /preview answers', () => {
  const saved = envelope('stale', { ...selected, cards: [card], observed_at: '2026-11-05T18:00:00+00:00' })
  const view = deriveView({ setup: saved, previewPending: true })
  assert.equal(view.screen, 'board')
  assert.equal(view.notice.kind, 'checking')
})

test('a failed refresh keeps the last cards and says they are not current', () => {
  const stale = envelope('stale', { ...selected, cards: [card], observed_at: 'x', error: { code: 'failed' } })
  assert.equal(deriveView({ preview: stale }).notice.kind, 'refresh_failed')
  const gone = { ...stale, error: { code: 'list_unavailable' } }
  assert.equal(deriveView({ preview: gone }).notice.kind, 'list_unavailable')
})

test('denied after setup keeps cached cards visible as a notice', () => {
  const denied = envelope('access_denied', { ...selected, cards: [card], observed_at: 'x', error: { code: 'access_denied' } })
  assert.deepEqual([deriveView({ preview: denied }).screen, deriveView({ preview: denied }).notice.kind], ['board', 'access_denied'])
})

test('a transport failure with no saved state is a full unavailable-host screen', () => {
  const view = deriveView({ setupError: classifyError(new Error('fetch failed')) })
  assert.deepEqual([view.screen, view.problem.kind], ['problem', 'unavailable_host'])
})

test('a transport failure after a good read keeps the board with a notice', () => {
  const ready = envelope('ready', { ...selected, cards: [card], observed_at: 'x' })
  const view = deriveView({ preview: ready, previewError: classifyError(new Error('503: Service Unavailable')) })
  assert.deepEqual([view.screen, view.notice.kind], ['board', 'unavailable_host'])
})

test('read failures, removed lists and storage failures each have their own recovery', () => {
  const read = deriveView({ preview: envelope('read_failure', { ...selected, error: { code: 'uncertain' } }) })
  assert.equal(read.problem.kind, 'read_failure')
  const removed = deriveView({ preview: envelope('read_failure', { ...selected, error: { code: 'list_unavailable' } }) })
  assert.equal(removed.problem.kind, 'list_unavailable')
  assert.equal(deriveView({ preview: envelope('persistence_failed', { error: { code: 'failed' } }) }).problem.kind, 'persistence_failed')
})

test('empty selected lists still show the board', () => {
  assert.equal(deriveView({ preview: envelope('empty_list', { ...selected, observed_at: 'x' }) }).screen, 'board')
})

test('changing lists from the board reopens the picker with existing choices', () => {
  const ready = envelope('ready', { ...selected, cards: [card], observed_at: 'x' })
  const view = deriveView({ preview: ready, choosing: true })
  assert.deepEqual([view.step, view.revising], ['lists', true])
})

test('host errors map to the recovery the contract asks for', () => {
  assert.equal(classifyError(new Error('401: unauthorized')).kind, 'auth')
  assert.equal(classifyError(new Error('403: forbidden')).kind, 'auth')
  assert.equal(classifyError(new Error('404: Not Found')).kind, 'backend_missing')
  assert.equal(classifyError(new Error('Expected JSON from x but got HTML (status 200).')).kind, 'backend_missing')
  for (const message of ['502: bad gateway', '503: x', '504: x', 'Hermes desktop bridge unavailable', 'timeout']) {
    assert.equal(classifyError(new Error(message)).kind, 'unavailable_host', message)
  }
  assert.equal(classifyError(new SupersededError()).kind, 'superseded')
})

test('late responses from a previous connection never change the screen', () => {
  const ready = envelope('ready', { ...selected, cards: [card], observed_at: 'x' })
  const view = deriveView({ preview: ready, previewError: { kind: 'superseded' } })
  assert.deepEqual([view.screen, view.notice], ['board', null])
})

test('helper setup failures reopen Connect before the picker without losing saved choices', () => {
  for (const code of ['signing_required', 'toolchain_required', 'session_locked', 'setup_failed', 'unsupported_platform']) {
    for (const status of ['read_failure', 'stale']) {
      const failed = envelope(status, { ...selected, cards: [card], error: { code } })
      const view = deriveView({ preview: failed, choosing: true })
      assert.deepEqual([view.screen, view.step, view.helperStatus], ['onboarding', 'connect', code])
      assert.deepEqual(view.envelope.setup.selected_list_ids, ['a'])
      assert.equal(view.envelope.cards[0], card)
    }
  }
})

test('permission loss during list selection reopens Connect and resumes the picker after recovery', () => {
  const denied = deriveView({ preview: envelope('access_denied', selected), choosing: true })
  assert.deepEqual([denied.step, denied.denied], ['connect', true])
  const resumed = deriveView({ preview: envelope('ready', selected), choosing: true })
  assert.equal(resumed.step, 'lists')
})
