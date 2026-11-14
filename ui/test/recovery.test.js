import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  currentRecovery,
  historyFor,
  nextCheckDue,
  recoveryView,
  retryOutcome
} from '../src/lib/recovery.js'

const NOW = new Date('2026-11-06T16:00:00Z')

// Rows shaped like reminders_kanban/execution/recovery.py observe(): column and action are the
// backend's; an unreconciled attempt is Needs you / reconcile whatever its cause.
const recovery = (cause, overrides = {}) => {
  const base = {
    run_id: 3,
    cause,
    reconciliation: 'resolved',
    evidence: 'checked',
    access_repaired: false,
    authorized: false,
    next_check_at: null,
    occupied: false,
    column: cause === 'capacity' ? 'In progress' : 'Needs you',
    action: { capacity: 'wait', balance: 'fund_account', access: 'repair_access', ordinary: 'retry' }[cause]
  }
  return { ...base, ...overrides }
}
const row = (id, rec, extra = {}) => ({
  expected: { id },
  task_id: `t_${id}`,
  status: 'failed',
  guard: { status: 'active' },
  recovery: rec,
  ...extra
})

test('each action offers only its permitted control, occupied or not', () => {
  const matrix = {
    wait: null,
    fund_account: 'billing',
    repair_access: 'repair',
    retry: 'retry',
    reconcile: null
  }
  for (const [action, control] of Object.entries(matrix)) {
    for (const occupied of [false, true]) {
      const view = recoveryView({ action, occupied, column: 'Needs you', run_id: 1 }, { now: NOW })
      assert.equal(view.control, control, `${action} occupied=${occupied}`)
      assert.equal(view.occupied, occupied)
    }
  }
})

test('a usage wait stays in In progress with only the native next-check time', () => {
  const view = recoveryView(recovery('capacity', { next_check_at: '2026-11-06T16:05:00+00:00' }), { now: NOW })
  assert.equal(view.label, 'Waiting for capacity')
  assert.equal(view.tone, 'waiting')
  assert.equal(view.column, 'In progress')
  assert.equal(view.control, null)
  assert.equal(view.nextCheck.toISOString(), '2026-11-06T16:05:00.000Z')
  assert.equal(view.due, false)
  assert.match(view.line.text, /try again on its own/)
  assert.doesNotMatch(view.line.text, /reset|credit|buy|purchase/i)
  const later = recoveryView(recovery('capacity', { next_check_at: '2026-11-06T15:59:00+00:00' }), { now: NOW })
  assert.equal(later.due, true)
})

test('an empty balance never shows a time, a purchase or a button', () => {
  // A refined balance row still carries the exit-75 cooldown time; it must not read as a promise.
  const view = recoveryView(
    recovery('balance', { next_check_at: '2026-11-06T16:05:00+00:00', column: 'Needs you' }),
    { now: NOW }
  )
  assert.equal(view.label, 'Balance empty')
  assert.equal(view.column, 'Needs you')
  assert.equal(view.nextCheck, null)
  assert.equal(view.control, 'billing')
  assert.match(view.line.text, /Add funds to your model provider account/)
  assert.match(view.line.text, /starts again on its own/)
  assert.doesNotMatch(view.line.text, /buy|purchase|top up/i)
  assert.equal(recoveryView(recovery('balance'), { canRepair: false }).control, null)
})

test('a broken sign-in offers repair on Desktop, text in the browser, nothing once repaired', () => {
  const broken = recovery('access')
  assert.equal(recoveryView(broken).control, 'repair')
  assert.equal(recoveryView(broken).column, 'Needs you')
  const browser = recoveryView(broken, { canRepair: false })
  assert.equal(browser.control, null)
  assert.match(browser.line.text, /on your Mac/)
  const repaired = recoveryView({ ...broken, access_repaired: true })
  assert.equal(repaired.control, null)
  assert.match(repaired.line.text, /repaired/)
})

test('an ordinary failure offers Retry with its run id', () => {
  const view = recoveryView(recovery('ordinary', { run_id: 7 }))
  assert.equal(view.control, 'retry')
  assert.equal(view.label, 'Needs a retry')
  assert.equal(view.card, view.label)
  assert.equal(view.runId, 7)
  assert.equal(view.tone, 'danger')
  assert.match(recoveryView(recovery('ordinary', { occupied: true })).line.text, /still closing/)
})

test('unknown effects are checked before any retry, whatever the cause', () => {
  for (const cause of ['capacity', 'balance', 'access', 'ordinary']) {
    const view = recoveryView(
      recovery(cause, { reconciliation: 'required', column: 'Needs you', action: 'reconcile', next_check_at: '2026-11-06T16:05:00+00:00' }),
      { now: NOW }
    )
    assert.equal(view.label, 'Needs a check')
    assert.doesNotMatch(view.line.text, /is checking/)
    assert.equal(view.column, 'Needs you')
    assert.equal(view.control, null)
    assert.equal(view.nextCheck, null)
  }
})

test('a stale row never covers a live, asked, delivered or finished task', () => {
  const r = row('a', recovery('ordinary'))
  assert.ok(currentRecovery(r))
  for (const state of ['active', 'question', 'result', 'done']) {
    assert.equal(currentRecovery(r, state), null, state)
    assert.equal(currentRecovery({ ...r, status: state }), null, state)
  }
  assert.ok(currentRecovery(r, 'ready'))
  assert.ok(currentRecovery(r, 'failed'))
  assert.equal(currentRecovery({ ...r, guard: { status: 'deleted' } }), null)
  // A permitted new attempt (Retry, resumed wait) ends the recovery before its worker shows up.
  assert.equal(currentRecovery({ ...r, recovery: { ...r.recovery, authorized: true } }), null)
  assert.equal(currentRecovery({ ...r, recovery: undefined }), null)
  assert.equal(recoveryView({ action: 'something_new' }), null)
})

test('the next check is the earliest usage wait', () => {
  const feed = {
    tasks: [
      row('a', recovery('capacity', { next_check_at: '2026-11-06T16:09:00+00:00' })),
      row('b', recovery('capacity', { next_check_at: '2026-11-06T16:05:00+00:00' })),
      row('c', recovery('balance', { next_check_at: '2026-11-06T16:01:00+00:00' }))
    ]
  }
  assert.equal(nextCheckDue(feed).toISOString(), '2026-11-06T16:05:00.000Z')
  assert.equal(nextCheckDue({ tasks: [] }), null)
  assert.equal(nextCheckDue(null), null)
})

test('retry outcomes', () => {
  assert.equal(retryOutcome({ status: 'ok', tasks: [row('a', undefined, { status: 'active' })] }, 'a').kind, 'started')
  assert.equal(retryOutcome({ status: 'ok', tasks: [row('a', recovery('ordinary'))] }, 'a').kind, 'refused')
  // The owner marks a permitted retry authorized before it observes the new worker.
  assert.equal(retryOutcome({ status: 'ok', tasks: [row('a', recovery('ordinary', { authorized: true }))] }, 'a').kind, 'started')
  assert.equal(retryOutcome({ status: 'attention', task: row('a', recovery('ordinary')) }, 'a').kind, 'refused')
  assert.equal(retryOutcome({ status: 'inactive' }, 'a').kind, 'refused')
  assert.equal(retryOutcome({ status: 'setup_required' }, 'a').kind, 'problem')
  assert.equal(retryOutcome({ status: 'access_denied' }, 'a').kind, 'problem')
  assert.equal(retryOutcome(null, 'a').kind, 'problem')
})

test("a balance recovery names its own run (by the recovery's run id) for what it was", () => {
  const thread = [
    { type: 'activity', label: 'Waited for capacity', at: 1, runId: 2 },
    { type: 'activity', label: 'Waited for capacity', at: 2, runId: 3 },
    { type: 'activity', label: 'Stopped before finishing', at: 3, runId: null }
  ]
  const rec = recoveryView(recovery('balance', { run_id: 3 }))
  assert.deepEqual(historyFor(thread, rec).map(item => item.label), ['Waited for capacity', 'Balance ran out', 'Stopped before finishing'])
  assert.equal(historyFor(thread, recoveryView(recovery('capacity', { next_check_at: '2026-11-06T16:05:00+00:00' }))), thread)
  assert.equal(historyFor(thread, null), thread)
})
