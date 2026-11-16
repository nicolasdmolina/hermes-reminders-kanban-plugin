import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as outcomes from '../src/lib/delegation-outcomes.js'
import { activationOutcome, actionOutcome, problemText } from '../src/lib/delegation-outcomes.js'

const answer = (status, tasks = [], extra = {}) => ({ status, tasks, ...extra })
const row = (id, status, extra = {}) => ({ expected: { id }, task_id: `t_${id}`, status, ...extra })

test('activation succeeds only when pickup is really on, and says why otherwise', () => {
  assert.deepEqual(activationOutcome(answer('ok', [], { pickup_enabled: true })), { ok: true })
  assert.match(activationOutcome({ status: 'select_lists' }).problem, /Choose a list/)
  assert.match(activationOutcome({ status: 'setup_required', reason: 'task_link_writer_unavailable' }).problem, /Set up task links first/)
  assert.match(activationOutcome({ status: 'setup_required', reason: 'owner_board_unavailable' }).problem, /isn't set up/)
  assert.match(activationOutcome({ status: 'access_denied', current: null }).problem, /can.t read Reminders/)
  assert.match(activationOutcome(null, { kind: 'unavailable_host' }).problem, /Couldn't reach Hermes/)
})

test('delegating reads this reminder’s row, not the ok envelope', () => {
  assert.equal(actionOutcome(answer('ok', [row('a', 'ready')]), 'ready', 'a').result.status, 'ok')
  // Linking failed but the task exists: it lands in Needs you, not back in To do.
  assert.equal(actionOutcome(answer('ok', [row('a', 'preparation_attention')]), 'ready', 'a').result.status, 'ok')
  // Queued behind running work: admission parks it, and the owner reports it as paused.
  assert.equal(actionOutcome(answer('ok', [row('a', 'paused', { guard: { status: 'active' } })]), 'ready', 'a').result.status, 'ok')
  const missing = actionOutcome(answer('ok', [row('b', 'ready')]), 'ready', 'a')
  assert.equal(missing.result.status, 'failed')
  assert.equal(missing.shown.replay, false)
  assert.match(actionOutcome({ status: 'inactive' }, 'ready', 'a').message, /Turn on agent pickup/)
  assert.match(actionOutcome({ status: 'attention', reason: 'source changed' }, 'ready', 'a').message, /changed in Reminders/)
  assert.ok(actionOutcome({ status: 'attention', reason: 'source changed' }, 'ready', 'a').shown.short.length <= 44)
})

test('accept succeeds only with a done row and a completed reminder', () => {
  const done = row('a', 'done', { completion: { status: 'completed' } })
  assert.equal(actionOutcome(answer('ok', [done]), 'accept', 'a').result.status, 'ok')
  assert.equal(actionOutcome(answer('ok', [row('a', 'needs_reconciliation')]), 'accept', 'a').result.status, 'pending')
  assert.equal(actionOutcome(answer('ok', [row('a', 'result')]), 'accept', 'a').result.status, 'failed')
  assert.equal(actionOutcome(null, 'accept', 'a', { kind: 'unavailable_host' }).result.status, 'failed')
})

test('resume succeeds once the guard is active again', () => {
  assert.equal(actionOutcome(answer('ok', [row('a', 'ready')]), 'resume', 'a').result.status, 'ok')
  assert.equal(actionOutcome(answer('ok', [row('a', 'paused', { guard: { status: 'active' } })]), 'resume', 'a').result.status, 'ok')
  assert.equal(actionOutcome(answer('ok', [row('a', 'paused', { guard: { status: 'paused' } })]), 'resume', 'a').result.status, 'failed')
})

test('gateway-dispatch refusals are explained, unknown reasons stay generic', () => {
  assert.match(problemText({ status: 'attention', reason: 'requires gateway dispatch and automatic review disabled' }), /start tasks by itself/)
  assert.match(problemText({ status: 'attention', reason: 'weird' }), /couldn't do that/)
})

test('stop: stopped and the idempotent no-ops are done; needs_reconciliation is not; not_found is an error', async () => {
  const { stopOutcome } = await import('../src/lib/delegation-outcomes.js')
  const stopped = stopOutcome({ status: 'ok', outcome: 'stopped', column: 'Done', label: 'Stopped', task: { task_id: 't_a', status: 'stopped' } })
  assert.equal(stopped.result.status, 'ok')
  assert.match(stopped.message, /stays open/)
  for (const noop of ['already_stopped', 'already_finished', 'already_deleted']) {
    assert.equal(stopOutcome({ status: 'ok', outcome: noop }).result.status, 'ok', noop)
  }
  const unsure = stopOutcome({ status: 'ok', outcome: 'needs_reconciliation' })
  assert.equal(unsure.result.status, 'pending')
  assert.notEqual(unsure.shown.tone, 'ok')
  assert.match(unsure.message, /Needs you/)
  assert.equal(stopOutcome({ status: 'ok', outcome: 'not_found' }).result.status, 'failed')
  assert.match(stopOutcome({ status: 'access_denied', current: null }).message, /can.t read Reminders/)
  assert.match(stopOutcome({ status: 'setup_required', reason: 'owner_board_unavailable' }).message, /isn't set up/)
  assert.equal(stopOutcome(null, { kind: 'unavailable_host' }).result.status, 'failed')
})

test('re-delegating a stopped run that already worked asks for the owner check', () => {
  assert.match(actionOutcome({ status: 'attention', reason: 'external effects need reconciliation' }, 'ready', 'a').message, /partway through/)
  assert.match(actionOutcome({ status: 'attention', reason: 'worker still alive' }, 'ready', 'a').message, /still stopping/)
})

test('running a stopped task again: confirm only what Hermes started, bound to its last finished run', async () => {
  const { confirmOutcome, rerunToConfirm } = await import('../src/lib/delegation-outcomes.js')
  const stopped = extra => ({ status: 'stopped', task_id: 't_a', ...extra })
  // Stopped while queued: nothing ran, straight back.
  assert.equal(rerunToConfirm(stopped({ work_before_stop: { runs: [] } })), null)
  assert.equal(rerunToConfirm(stopped({})), null)
  // Stopped mid-run: bind to the latest run once it has ended.
  assert.equal(rerunToConfirm(stopped({ work_before_stop: { runs: [{ id: 3, ended_at: 10 }, { id: 4, ended_at: 20 }] } })), 4)
  assert.equal(rerunToConfirm(stopped({ work_before_stop: { runs: [{ id: 4, ended_at: null }] } })), null)
  // Already confirmed for that run (a replay keeps it): no second prompt.
  assert.equal(rerunToConfirm(stopped({ work_before_stop: { runs: [{ id: 4, ended_at: 20 }] }, rerun_reconciliation: { run_id: '4' } })), null)
  assert.equal(rerunToConfirm({ status: 'active', work_before_stop: { runs: [{ id: 4, ended_at: 20 }] } }), null)
  assert.deepEqual(confirmOutcome({ status: 'ok', receipt: { receipt_id: 'r', run_id: '4' } }), { ok: true })
  assert.match(confirmOutcome({ status: 'attention', reason: 'stale_run' }).message, /did more since/)
  assert.match(confirmOutcome({ status: 'attention', reason: 'verified_stop_required' }).message, /still stopping/)
  assert.match(confirmOutcome({ status: 'not_found' }).message, /doesn't have this task/)
  assert.match(confirmOutcome(null, { kind: 'unavailable_host' }).message, /Couldn't reach Hermes/)
})

test('a tick keeps the task views only GET carries (what Hermes did before a stop)', async () => {
  const { mergeRows, rerunToConfirm } = await import('../src/lib/delegation-outcomes.js')
  const cached = [{ key: 'k1', task_id: 't_1', status: 'stopped', work_before_stop: { runs: [{ id: 7, ended_at: 9 }] } }]
  const ticked = [{ key: 'k1', task_id: 't_1', status: 'stopped' }, { key: 'k2', task_id: 't_2', status: 'ready' }]
  const merged = mergeRows(cached, ticked)
  assert.equal(rerunToConfirm(merged[0]), 7)
  assert.equal(merged[1].status, 'ready')
  assert.equal(mergeRows(cached, [{ key: 'k1', status: 'active' }])[0].status, 'active')
})

test('after Stop the board knows Hermes had started, before any read lands, so a drag to Ready asks first', async () => {
  const { mergeRows, rerunToConfirm, withStop } = await import('../src/lib/delegation-outcomes.js')
  const { agentVerdict } = await import('../src/lib/placement.js')
  const verdict = row => agentVerdict({ column: 'To do', source: { id: 'r1', rules: [] }, agent: { status: 'stopped', row } }, 'Ready for Agent', { pickup: true })
  // The cached read is from while it ran: no retained work yet.
  const running = { status: 'ok', tasks: [{ key: 'k1', task_id: 't_1', expected: { id: 'r1' }, status: 'active', work_before_stop: null }] }
  // The bug as seen live: the tick says stopped over that read, so it looked stopped while queued.
  const ticked = mergeRows(running.tasks, [{ key: 'k1', task_id: 't_1', status: 'stopped', stop_intent: true }])
  assert.equal(rerunToConfirm(ticked[0]), null)
  assert.equal(verdict(ticked[0]).action, 'ready')
  // The Stop answer carries the run Hermes had started; the cache takes it at once.
  const answer = { status: 'ok', outcome: 'stopped', task: { key: 'k1', task_id: 't_1', status: 'stopped', stopped_at: '2026-11-08T07:39:10Z' }, work_before_stop: { runs: [{ id: 1, ended_at: 1794122982 }] } }
  const stopped = withStop(running, answer)
  assert.equal(rerunToConfirm(stopped.tasks[0]), 1)
  assert.equal(verdict(stopped.tasks[0]).action, 'confirm')
  // A later tick keeps it.
  assert.equal(rerunToConfirm(mergeRows(stopped.tasks, [{ key: 'k1', task_id: 't_1', status: 'stopped' }])[0]), 1)
  // Stopped while queued: nothing ran, so it goes straight back.
  const queued = withStop(running, { ...answer, work_before_stop: { runs: [] } })
  assert.equal(verdict(queued.tasks[0]).action, 'ready')
  // A refused or failed Stop leaves the cache alone.
  assert.equal(withStop(running, { status: 'attention', reason: 'x' }), running)
})

test("a stopped task's Delegate asks first (RerunAsk): Stop's answer keeps its retained work through a later tick (ticket 17)", () => {
  const { withStop, mergeRows, rerunToConfirm } = outcomes
  const cached = {
    status: 'ok',
    tasks: [
      { key: 'k1', task_id: 't1', status: 'failed', work_before_stop: null },
      { key: 'k2', task_id: 't2', status: 'active' }
    ]
  }
  const answer = {
    status: 'ok',
    outcome: 'stopped',
    task: { key: 'k1', task_id: 't1', status: 'stopped', stop_intent: true },
    work_before_stop: { state: 'stopped', runs: [{ id: 5, outcome: 'crashed', ended_at: 100 }] }
  }
  const kept = withStop(cached, answer)
  assert.equal(kept.tasks[0].status, 'stopped')
  assert.equal(rerunToConfirm(kept.tasks[0]), 5)
  assert.equal(kept.tasks[1], cached.tasks[1])
  // A tick's bare rows that land afterwards keep it (the race seen live from a "Needs a check" task).
  const ticked = mergeRows(kept.tasks, [{ key: 'k1', task_id: 't1', status: 'stopped' }, { key: 'k2', task_id: 't2', status: 'active' }])
  assert.equal(rerunToConfirm(ticked[0]), 5)
  // Without Stop's answer the same tick leaves no run to confirm: Delegate would skip the ask.
  assert.equal(rerunToConfirm(mergeRows(cached.tasks, [{ key: 'k1', task_id: 't1', status: 'stopped' }])[0]), null)
})

test('a refused activation frees Turn on at once, before the slow reread finishes', async () => {
  const log = []
  let finishReread
  const run = outcomes.runActivation({
    post: async () => ({ status: 'setup_required', reason: 'task_link_writer_unavailable' }),
    reread: () => new Promise(resolve => (finishReread = () => (log.push('reread done'), resolve()))),
    refreshBoard: () => log.push('board'),
    classify: () => ({ kind: 'unavailable_host' }),
    onProblem: problem => log.push(`problem ${problem}`),
    onSettled: () => log.push('settled')
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(log, [`problem ${problemText({ status: 'setup_required', reason: 'task_link_writer_unavailable' })}`, 'settled'])
  finishReread()
  assert.match((await run).problem, /Set up task links first/)
  assert.deepEqual(log.slice(2), ['reread done', 'board'])
})

test('a successful activation stays busy until the reread shows pickup on', async () => {
  const log = []
  const outcome = await outcomes.runActivation({
    post: async () => ({ status: 'ok', pickup_enabled: true }),
    reread: async () => log.push('reread'),
    refreshBoard: () => log.push('board'),
    classify: () => ({ kind: 'unavailable_host' }),
    onProblem: problem => log.push(`problem ${problem}`),
    onSettled: () => log.push('settled')
  })
  assert.deepEqual(outcome, { ok: true })
  assert.deepEqual(log, ['reread', 'board', 'settled'])
})

test('activation keeps the refusal when the reread after it fails, and says so when the post fails', async () => {
  const log = []
  const steps = post => ({
    post,
    reread: async () => { throw new Error('504: timeout') },
    refreshBoard: () => log.push('board'),
    classify: error => ({ kind: /superseded/.test(error.message) ? 'superseded' : 'unavailable_host' }),
    onProblem: problem => log.push(problem),
    onSettled: () => log.push('settled')
  })
  await outcomes.runActivation(steps(async () => ({ status: 'select_lists' })))
  assert.deepEqual(log, ['Choose a list for the board first.', 'settled'])
  log.length = 0
  assert.deepEqual(await outcomes.runActivation(steps(async () => { throw new Error('502: down') })), { failed: true })
  assert.deepEqual(log, ["Couldn't reach Hermes. Try again.", 'settled'])
  log.length = 0
  assert.deepEqual(await outcomes.runActivation(steps(async () => { throw new Error('superseded') })), { superseded: true })
  assert.deepEqual(log, ['settled'])
})

test('the dialog says Up next, not Paused, while a stopped one-off’s Run again waits to be placed', () => {
  assert.equal(outcomes.dialogQueuedLabel({ status: 'ready', label: 'Up next', line: 'Waiting for a free slot' }), 'Waiting for a free slot')
  assert.equal(outcomes.dialogQueuedLabel({ status: 'ready', label: 'Up next' }), 'Up next')
  // The board row still reads stopped; the task link already shows the new run parked for a slot.
  assert.equal(outcomes.dialogQueuedLabel({ status: 'stopped', row: { status: 'stopped' } }), 'Up next')
  // Just delegated: the board hasn't placed the card yet, the task link shows it parked.
  assert.equal(outcomes.dialogQueuedLabel(null), 'Up next')
  // A real pause, running work and repeating reminders keep their own lines.
  assert.equal(outcomes.dialogQueuedLabel({ status: 'paused' }), undefined)
  assert.equal(outcomes.dialogQueuedLabel({ status: 'running' }), undefined)
  assert.equal(outcomes.dialogQueuedLabel({ status: 'stopped', row: { scope: 'occurrence' } }), undefined)
  assert.equal(outcomes.dialogQueuedLabel(null, true), undefined)
})

test('task-link setup refusals read in plain words, never as a generic failure', () => {
  const missing = activationOutcome({ status: 'setup_required', reason: 'task_link_origin_missing' }).problem
  const invalid = activationOutcome({ status: 'setup_required', reason: 'task_link_origin_invalid' }).problem
  assert.equal(missing, 'Set up task links first, or choose Only on this Mac.')
  assert.match(invalid, /phone address/)
  assert.doesNotMatch(missing + invalid, /couldn't do that/i)
})

test('an owner without agent support explains the pickup block in plain words', () => {
  const failure = { status: 'setup_required', reason: 'owner_board_unavailable' }
  assert.match(activationOutcome(failure).problem, /isn.t set up for agent work/)
  assert.match(problemText(failure), /isn.t set up for agent work/)
})

test('after Stop then Run again, an action reads the current run, not the stopped one kept beside it', () => {
  const stopped = row('a', 'stopped', { key: 'old', storage_key: 'old', guard: { status: 'stopped' } })
  const accepted = row('a', 'done', { key: 'new', task_id: 't_new', completion: { status: 'completed' }, guard: { status: 'active' } })
  assert.equal(actionOutcome(answer('ok', [stopped, accepted]), 'accept', 'a').result.status, 'ok')
})
