// Every occurrence (ticket 23): what the board shows for each state recurring-contract.md returns.
// The backend decides every state; these check only that each one reads right and offers the
// permitted next step.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { doneOccurrenceLabel, hasOutstanding, inSeries, notDue, occurrenceOutcome, repeatLabel, resolveSeriesProblem, resolveSeriesRequest, retryRequest, seriesHeldText, withOccurrences, withOccurrenceTasks } from '../src/lib/occurrences.js'
import { placeCards } from '../src/lib/placement.js'
import { boardPill, occurrenceDialog } from '../src/recurring/dialog.js'

const NOW = new Date(2026, 10, 8, 12)
const day = d => ({ year: 2026, month: 11, day: d, hour: null })
const reminder = (id, d, extra = {}) => ({ id, title: '[RK-23] Daily note', due: day(d), rules: [{ frequency: 0 }], completed: false, notes: 'n', ...extra })
const card = (source, extra = {}) => ({ id: `c-${source.id}`, owner: 'human', column: 'To do', recurring: source.rules.length > 0, source, ...extra })
const row = (key, d, status, extra = {}) => ({
  key,
  task_id: `t_${key}`,
  authorization_id: 'series-every',
  scope: 'every_occurrence',
  instruction_version: 1,
  status,
  expected: reminder('R', d),
  source: reminder('R', d),
  guard: { status: 'active' },
  ...extra
})
const accepted = (key, d, historyId, extra = {}) =>
  row(key, d, 'done', { completion: { status: 'completed', history_id: historyId, successor: reminder('R', d + 1) }, ...extra })
const ok = tasks => ({ status: 'ok', tasks, current: [], limits: { queue: [] } })
const place = (cards, occ, live = null) => withOccurrences(placeCards(cards, withOccurrenceTasks({ status: 'ok', tasks: [] }, occ), live), occ, NOW)

test('an occurrence held before its due time waits in To do as the agent’s, never Needs you', () => {
  const held = row('k1', 16, 'paused', { held_reason: 'not_due', due_at: 1, guard: { status: 'waiting_due' } })
  assert.ok(notDue(held))
  const [placed] = place([card(reminder('R', 16))], ok([held]))
  assert.equal(placed.owner, 'agent')
  assert.equal(placed.column, 'To do')
  assert.equal(placed.agent.label, 'Not due yet')
  assert.equal(repeatLabel(placed), 'Every occurrence')
  assert.deepEqual(boardPill(placed), { label: 'Not due yet', tone: 'agent' })
  assert.deepEqual(occurrenceDialog(placed, NOW).pill, { label: 'Nov 16 · Every occurrence', tone: 'agent' })
  // GET /attention reads the held task live as waiting_due; that must not land it in Needs you.
  const [live] = place([card(reminder('R', 16))], ok([held]), [{ task_id: 't_k1', state: 'waiting_due' }])
  assert.equal(live.column, 'To do')
  assert.equal(live.agent.label, 'Not due yet')
})

test('a due occurrence runs like any delegated one, review in Needs you', () => {
  const [working] = place([card(reminder('R', 6))], ok([row('k1', 6, 'active')]))
  assert.equal(working.column, 'In progress')
  const [review] = place([card(reminder('R', 6))], ok([row('k1', 6, 'result', { held_reason: 'result' })]))
  assert.equal(review.column, 'Needs you')
  assert.equal(review.agent.label, 'Review result')
  assert.equal(review.occurrence.role, 'delegated')
})

test('after acceptance the series continues: the reminder is Up next, not yours to delegate again', () => {
  const occ = ok([accepted('k1', 6, 'H1')])
  // The tick that prepares the next occurrence hasn't run yet: keep ticking.
  assert.equal(hasOutstanding(occ), true)
  const [next, history] = place([card(reminder('R', 7)), card(reminder('H1', 6, { completed: true }), { column: 'Done' })], occ)
  assert.equal(next.occurrence.role, 'series')
  assert.ok(inSeries(next))
  assert.equal(next.owner, 'agent')
  assert.equal(next.column, 'To do')
  assert.equal(next.agent.label, 'Up next')
  assert.equal(repeatLabel(next), 'Every occurrence')
  const dialog = occurrenceDialog(next, NOW)
  assert.equal(dialog.yours, false)
  assert.equal(dialog.upcoming, 'Nov 7 · Up next')
  assert.equal(dialog.earlier, 'Nov 6')
  assert.deepEqual(dialog.pill, { label: 'Every occurrence', tone: 'agent' })
  // The accepted one keeps its own history card in Done.
  assert.equal(history.occurrence.role, 'history')
  assert.equal(doneOccurrenceLabel(history), 'Nov 6 · Every occurrence')
})

test('the next occurrence carried forward is its own row; the earlier one is history', () => {
  const occ = ok([accepted('k1', 6, 'H1'), row('k2', 7, 'ready', { predecessor: 'k1' })])
  const [current] = place([card(reminder('R', 7))], occ)
  assert.equal(current.occurrence.role, 'delegated')
  assert.equal(current.occurrence.key, 'k2')
  assert.deepEqual(
    current.occurrence.history.map(entry => [entry.key, entry.state]),
    [['k1', 'Accepted']]
  )
  // Nothing left to carry forward from k1; k2 itself is outstanding.
  assert.equal(hasOutstanding(ok([accepted('k1', 6, 'H1'), row('k2', 7, 'done', { predecessor: 'k1', series_state: 'ended', completion: { status: 'completed', history_id: 'H2', successor: null } })])), false)
})

test('a held series needs you, says why, and offers no delegation', () => {
  const occ = ok([accepted('k1', 6, 'H1', { series_state: 'needs_reconciliation', held_reason: 'Successor needs reconciliation', hold_id: 'h1' })])
  assert.equal(hasOutstanding(occ), false)
  const [held] = place([card(reminder('R', 7))], occ)
  assert.equal(held.column, 'Needs you')
  assert.equal(held.agent.label, 'Needs a decision')
  assert.equal(held.agent.row.status, 'series_held')
  assert.equal(held.agent.row.hold_id, 'h1')
  assert.deepEqual(boardPill(held), { label: 'Needs a decision', tone: 'danger' })
  assert.equal(occurrenceDialog(held, NOW).upcoming, 'Nov 7 · The next occurrence changed in Reminders')
  assert.equal(seriesHeldText({ held_reason: 'No authorized successor' }), "Hermes can't confirm the last occurrence was checked off")
  assert.equal(seriesHeldText({ held_reason: 'changed_instructions' }), "The reminder's notes changed in Reminders")
  assert.equal(seriesHeldText({ held_reason: 'identity_replaced' }), 'The reminder was replaced in Reminders')
  assert.equal(seriesHeldText({ held_reason: 'something new' }), "Hermes can't match the next occurrence")
})

test('the last occurrence of a finite series ends it', () => {
  const last = row('k3', 8, 'done', { predecessor: 'k2', series_state: 'ended', completion: { status: 'completed', history_id: 'R', successor: null } })
  const occ = ok([accepted('k1', 6, 'H1'), accepted('k2', 7, 'H2', { predecessor: 'k1' }), last])
  const [done] = place([card(reminder('R', 8, { completed: true }), { column: 'Done' })], occ)
  assert.equal(done.column, 'Done')
  assert.equal(doneOccurrenceLabel(done), 'Nov 8 · Last occurrence')
  assert.equal(occurrenceDialog(done, NOW).upcoming, 'No more repeats')
  assert.deepEqual(
    done.occurrence.history.map(entry => entry.key),
    ['k1', 'k2']
  )
})

test('Every occurrence answers: delegated, or refused when This occurrence already has it', () => {
  const target = { sourceId: 'R' }
  assert.equal(occurrenceOutcome(ok([row('k1', 6, 'ready')]), 'every', target).result.status, 'ok')
  assert.equal(occurrenceOutcome(ok([row('k1', 6, 'ready')]), 'every', target).message, 'Delegated every occurrence.')
  const other = occurrenceOutcome(ok([row('k1', 6, 'ready', { scope: 'this_occurrence' })]), 'every', target)
  assert.equal(other.result.status, 'failed')
  const refused = occurrenceOutcome({ status: 'attention', reason: 'current occurrence already delegated with different scope' }, 'every', target)
  assert.equal(refused.message, 'This occurrence is already delegated another way.')
})

test('Retry names the occurrence and its failed run, never the Apple ID', () => {
  assert.deepEqual(retryRequest(row('k1', 6, 'failed', { recovery: { run_id: 42, action: 'retry' } })), { action: 'retry', occurrence_id: 'k1', run_id: 42 })
  assert.equal(retryRequest(row('k1', 6, 'failed')), null)
})

test('a rerun or a confirmed check-off ends Every occurrence: the pill follows the row', () => {
  const [rerun] = place([card(reminder('R', 6))], ok([row('k1', 6, 'stopped'), row('k2', 6, 'ready', { scope: 'this_occurrence', rerun_of: 'k1', authorization_id: 'series-2' })]))
  assert.equal(repeatLabel(rerun), 'This occurrence')
})

test('a capacity wait names the occurrence as waiting, not paused', async () => {
  const { occurrenceLabels } = await import('../src/lib/occurrences.js')
  const waiting = row('k2', 9, 'paused', { recovery: { run_id: 3, action: 'wait', column: 'In progress' } })
  assert.equal(occurrenceLabels(ok([waiting]), NOW).k2.state, 'Waiting for capacity')
  assert.equal(occurrenceLabels(ok([{ ...waiting, status: 'active' }]), NOW).k2.state, 'Working')
})

test('read live as waiting_due before the row says so, it still waits in To do', () => {
  const [live] = place([card(reminder('R', 16))], ok([row('k1', 16, 'paused')]), [{ task_id: 't_k1', state: 'waiting_due' }])
  assert.equal(live.column, 'To do')
  assert.equal(live.agent.label, 'Not due yet')
  assert.equal(live.agent.notDue, true)
})

test('a held series needs you even after its repeat was removed', () => {
  const occ = ok([accepted('k1', 6, 'H1', { series_state: 'needs_reconciliation', held_reason: 'Successor needs reconciliation' })])
  const [held] = place([card(reminder('R', 7, { rules: [] }))], occ)
  assert.equal(held.column, 'Needs you')
  assert.equal(held.agent.label, 'Needs a decision')
  // Without a held series, a reminder that no longer repeats is left alone.
  const [plain] = place([card(reminder('R', 7, { rules: [] }))], ok([accepted('k1', 6, 'H1', { series_state: 'ended' })]))
  assert.equal(plain.agent, undefined)
})

test('a held series is resolved with its hold, the current snapshot and, to keep going, its cause', () => {
  const held = { key: 'k1', hold_id: 'h1', held_reason: 'Successor needs reconciliation' }
  const now = reminder('R', 12)
  assert.deepEqual(resolveSeriesRequest(held, 'end', now), { action: 'resolve_series', occurrence_id: 'k1', hold_id: 'h1', decision: 'end', expected: now })
  assert.deepEqual(resolveSeriesRequest(held, 'reauthorize', now), {
    action: 'resolve_series',
    occurrence_id: 'k1',
    hold_id: 'h1',
    decision: 'reauthorize',
    expected: now,
    confirmed_cause: 'Successor needs reconciliation'
  })
  assert.equal(resolveSeriesProblem({ status: 'conflict', reason: 'stale_source' }), 'The reminder changed in Reminders. Check it, then try again.')
  assert.equal(resolveSeriesProblem({ status: 'conflict', reason: 'series_already_resolved' }), 'This was already decided')
  assert.equal(resolveSeriesProblem({ status: 'attention', reason: 'history needs reconciliation' }), "Reminders' history doesn't match. Check it in Reminders.")
})

test('Stop repeating with Hermes: the reminder is yours again, with its history', () => {
  const ended = accepted('k1', 6, 'H1', { series_state: 'authorization_ended', series_resolution: { request: { decision: 'end' } } })
  const occ = ok([ended])
  assert.equal(hasOutstanding(occ), false)
  const [mine] = place([card(reminder('R', 12))], occ)
  assert.equal(mine.agent, undefined)
  assert.equal(mine.occurrence.role, 'successor')
  assert.equal(occurrenceDialog(mine, NOW).yours, true)
  assert.deepEqual(mine.occurrence.history.map(entry => entry.key), ['k1'])
})

test('Keep going: a new occurrence follows the held one and keeps its history', () => {
  const ended = accepted('k1', 6, 'H1', { series_state: 'authorization_ended' })
  const next = row('k2', 12, 'preparing', { authorization_id: 'series-2', predecessor: 'k1' })
  const [current] = place([card(reminder('R', 12))], ok([ended, next]))
  assert.equal(current.occurrence.role, 'delegated')
  assert.equal(current.occurrence.key, 'k2')
  assert.equal(repeatLabel(current), 'Every occurrence')
  assert.deepEqual(current.occurrence.history.map(entry => entry.key), ['k1'])
})

test('a retryable wait to read Reminders is in progress, not a decision', () => {
  const occ = ok([accepted('k1', 6, 'H1', { series_state: 'waiting_source', held_reason: 'timeout' })])
  // The next owner tick retries it.
  assert.equal(hasOutstanding(occ), true)
  const [waiting] = place([card(reminder('R', 7))], occ)
  assert.equal(waiting.column, 'In progress')
  assert.equal(waiting.agent.label, 'Waiting for Reminders')
  assert.equal(waiting.agent.row.status, 'series_waiting')
  assert.deepEqual(boardPill(waiting), { label: 'Waiting for Reminders', tone: 'active' })
  assert.equal(occurrenceDialog(waiting, NOW).upcoming, 'Nov 7 · Waiting for Reminders')
  // Once the retry carried it forward (series_state active, a successor row), nothing waits.
  assert.equal(hasOutstanding(ok([accepted('k1', 6, 'H1', { series_state: 'active' }), row('k2', 7, 'done', { predecessor: 'k1', series_state: 'ended', completion: { status: 'completed', history_id: 'H2', successor: null } })])), false)
})

test('the occurrence picker names the live state, not the last tick', async () => {
  const { occurrenceLabels } = await import('../src/lib/occurrences.js')
  assert.equal(occurrenceLabels(ok([row('k3', 11, 'active', { state: 'result' })]), NOW).k3.state, 'Review result')
  assert.equal(occurrenceLabels(ok([row('k3', 11, 'stopped', { state: 'result' })]), NOW).k3.state, 'Stopped')
})

test('ending a held series returns the reminder to you, even with an agent marker or no repeat', () => {
  const ended = accepted('k1', 6, 'H1', { series_state: 'authorization_ended' })
  const [marked] = place([card(reminder('R', 12), { owner: 'agent', column: 'Ready for Agent' })], ok([ended]))
  assert.equal(marked.owner, 'human')
  assert.equal(marked.column, 'To do')
  const [done] = place([card(reminder('R', 12, { completed: true }), { owner: 'agent', column: 'Done' })], ok([ended]))
  assert.equal(done.owner, 'human')
  assert.equal(done.column, 'Done')
  const [plain] = place([card(reminder('R', 12, { rules: [] }))], ok([ended]))
  assert.equal(plain.occurrence.role, 'successor')
  assert.deepEqual(plain.occurrence.history.map(entry => entry.key), ['k1'])
})

test('after Keep going to an earlier date, the newer occurrence decides the card', () => {
  const ended = accepted('k1', 12, 'H1', { series_state: 'authorization_ended' })
  const later = accepted('k2', 10, 'H2', { authorization_id: 'series-2', predecessor: 'k1', series_state: 'needs_reconciliation', hold_id: 'h2', held_reason: 'Successor needs reconciliation' })
  const [held] = place([card(reminder('R', 13))], ok([ended, later]))
  assert.equal(held.agent.row.status, 'series_held')
  assert.equal(held.agent.row.key, 'k2')
})

test('the picker names the occurrence shown by the same live state as the pill', async () => {
  const { pickerLabels } = await import('../src/lib/occurrences.js')
  const labels = { k3: { date: 'Nov 11', state: 'Working', text: 'Nov 11 · Working' }, k2: { date: 'Nov 9', state: 'Accepted', text: 'Nov 9 · Accepted' } }
  const view = { selectedOccurrence: 'k3', historical: false, state: 'result', info: { label: 'Result ready' } }
  assert.equal(pickerLabels(labels, view).k3.text, 'Nov 11 · Result ready')
  assert.equal(pickerLabels(labels, view).k2.text, 'Nov 9 · Accepted')
  // An earlier occurrence, or a state the board names itself, keeps its stored label.
  assert.equal(pickerLabels(labels, { ...view, historical: true }).k3.text, 'Nov 11 · Working')
  assert.equal(pickerLabels(labels, { ...view, state: 'paused', info: { label: 'Paused' } }).k3.text, 'Nov 11 · Working')
})

test('not due yet is said once: the pill; the picker says Not started, the line says when', async () => {
  const { occurrenceLabels } = await import('../src/lib/occurrences.js')
  const held = row('k1', 16, 'paused', { held_reason: 'not_due', guard: { status: 'waiting_due' } })
  const [placed] = place([card(reminder('R', 16))], ok([held]))
  assert.equal(placed.agent.label, 'Not due yet')
  assert.equal(placed.agent.status, 'ready')
  assert.equal(placed.agent.line, 'Starts Nov 16')
  assert.equal(occurrenceLabels(ok([held]), NOW).k1.state, 'Not started')
})

test('a requeued occurrence whose last run needs you shows the card’s words in the dialog pill, not Queued', () => {
  const src = { id: 'R', title: 'Weekly report', due: { year: 2026, month: 11, day: 11 }, rules: [{ frequency: 'weekly' }], completed: false }
  const card = { id: 'R', column: 'To do', owner: 'human', source: src, recurring: true }
  for (const [action, label] of [['reconcile', 'Needs a check'], ['fund_account', 'Balance empty'], ['repair_access', 'Sign-in needs repair']]) {
    const row = { key: 'k1', task_id: 't1', scope: 'every_occurrence', status: 'ready', state: 'ready', authorization_id: 'a1', expected: src, source: src, guard: { status: 'active' }, recovery: { run_id: 3, action, column: 'Needs you', reconciliation: action === 'reconcile' ? 'required' : 'resolved' } }
    const data = { status: 'ok', tasks: [row], current: [src] }
    const [placed] = withOccurrences(placeCards([card], withOccurrenceTasks({ status: 'ok', tasks: [], limits: { queue: [] } }, data), null), data)
    assert.equal(placed.agent.label, label)
    assert.equal(boardPill(placed).label, label)
  }
})

test('a stopped occurrence whose reminder moved on shows the reminder’s own date, not the stopped one', async () => {
  const { occurrenceDateLabel, repeatLabel } = await import('../src/lib/occurrences.js')
  const stopped = { source: { due: { year: 2026, month: 11, day: 12 } }, agent: { row: { status: 'stopped' } }, occurrence: { role: 'delegated', scope: 'this_occurrence', entry: { date: 'Nov 12' } } }
  assert.equal(occurrenceDateLabel(stopped), 'Nov 12 · This occurrence')
  const movedOn = { ...stopped, source: { due: { year: 2026, month: 11, day: 16 } } }
  assert.equal(occurrenceDateLabel(movedOn), null)
  assert.equal(repeatLabel(movedOn), 'Repeats')
})
