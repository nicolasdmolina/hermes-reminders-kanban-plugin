import assert from 'node:assert/strict'
import { test } from 'node:test'

import { moveVerdict } from '../src/lib/moves.js'
import {
  occurrenceStoppable,
  advanceQuestion,
  occurrenceAttention,
  resolveProblem,
  resolveRequest,
  sourcePaused,
  withViews,
  FRESH_MS,
  newKeys,
  queuedWhileHeld,
  stillHeld,
  acceptRequest,
  doneOccurrenceLabel,
  confirmableRun,
  rerunMode,
  occurrenceDateLabel,
  hasOutstanding,
  pauseText,
  occurrenceLabels,
  occurrenceOutcome,
  repeatLabel,
  withOccurrences,
  withOccurrenceTasks,
  occurrenceEntry
} from '../src/lib/occurrences.js'
import { agentState, placeCards } from '../src/lib/placement.js'
import { occurrenceHolds } from '../src/lib/task-link.js'
import { boardPill, occurrenceDialog } from '../src/recurring/dialog.js'

// Shapes from a real run (evidence/21/shape-probe-2): Apple keeps the reminder's ID for the next
// occurrence and gives the completed one a new ID.
const NOW = new Date(2026, 10, 6, 12)
const day = d => ({ year: 2026, month: 11, day: d, hour: null })
const reminder = (id, d, extra = {}) => ({ id, title: '[RK-21] Daily note', due: day(d), rules: [{ frequency: 0 }], completed: false, notes: 'n', ...extra })
const card = (source, extra = {}) => ({ id: `c-${source.id}`, owner: 'human', column: 'To do', recurring: source.rules.length > 0, source, ...extra })
const row = (key, d, status, extra = {}) => ({
  key,
  task_id: `t_${key}`,
  authorization_id: 'series-1',
  scope: 'this_occurrence',
  status,
  expected: reminder('R', d),
  source: reminder('R', d),
  ...extra
})
const accepted = (key, d, historyId) => row(key, d, 'done', { completion: { status: 'completed', history_id: historyId, successor: reminder('R', d + 1) } })
const ok = tasks => ({ status: 'ok', tasks, current: [], limits: { queue: [] } })
const place = (cards, occ, delegation = { status: 'ok', tasks: [] }) => withOccurrences(placeCards(cards, withOccurrenceTasks(delegation, occ)), occ, NOW)

test('a delegated occurrence is the agent’s and says which occurrence', () => {
  const [placed] = place([card(reminder('R', 6))], ok([row('k1', 6, 'active')]))
  assert.equal(placed.owner, 'agent')
  assert.equal(placed.column, 'In progress')
  assert.equal(placed.occurrence.role, 'delegated')
  assert.equal(placed.occurrence.entry.date, 'Nov 6')
  assert.equal(repeatLabel(placed), 'This occurrence')
  // The dialog pill carries the date too, like the card, even when it matches the due date.
  assert.deepEqual(occurrenceDialog(placed).pill, { label: 'Nov 6 · This occurrence', tone: 'agent' })
})

test('after acceptance the next occurrence stays yours and the result stays with its own copy', () => {
  const occ = ok([accepted('k1', 6, 'H1')])
  const next = card(reminder('R', 7))
  const copy = card(reminder('H1', 6, { completed: true, rules: [] }), { column: 'Done' })
  const [successor, history] = place([next, copy], occ)
  // No authority carries forward: no agent, no row, still in To do.
  assert.equal(successor.owner, 'human')
  assert.equal(successor.agent, undefined)
  assert.equal(successor.column, 'To do')
  assert.equal(successor.occurrence.role, 'successor')
  assert.equal(repeatLabel(successor), 'Repeats')
  const shown = occurrenceDialog(successor, NOW)
  assert.equal(shown.yours, true)
  assert.equal(shown.key, 'k1')
  assert.equal(shown.earlier, 'Nov 6')
  assert.equal(shown.upcoming, 'Nov 7 · Not started')
  assert.equal(shown.labels.k1.text, 'Nov 6 · Accepted')
  assert.deepEqual(successor.occurrence.history.map(entry => `${entry.date} ${entry.state}`), ['Nov 6 Accepted'])
  // The completed copy in Done is the accepted occurrence.
  assert.equal(history.owner, 'agent')
  assert.equal(history.column, 'Done')
  assert.equal(history.occurrence.role, 'history')
  assert.equal(history.occurrence.key, 'k1')
  assert.equal(doneOccurrenceLabel(history), 'Nov 6 · This occurrence')
  assert.equal(doneOccurrenceLabel(successor), null)
})

test('a second delegation is a new occurrence; earlier results stay separate, oldest first', () => {
  const occ = ok([accepted('k1', 6, 'H1'), accepted('k2', 7, 'H2'), row('k3', 8, 'result')])
  const [current, first, second] = place(
    [card(reminder('R', 8)), card(reminder('H1', 6, { completed: true, rules: [] }), { column: 'Done' }), card(reminder('H2', 7, { completed: true, rules: [] }), { column: 'Done' })],
    occ
  )
  assert.equal(current.agent.row.key, 'k3')
  assert.equal(current.column, 'Needs you')
  assert.deepEqual(current.occurrence.history.map(entry => entry.key), ['k1', 'k2'])
  assert.equal(first.agent.row.key, 'k1')
  assert.equal(second.agent.row.key, 'k2')
  assert.equal(occurrenceLabels(occ, NOW).k2.text, 'Nov 7 · Accepted')
  assert.equal(occurrenceLabels(occ, NOW).k3.text, 'Nov 8 · Review result')
})

test('a reminder this board never delegated is left alone, and one-off work is unchanged', () => {
  const plain = card(reminder('Q', 6))
  const oneOff = card(reminder('O', 6, { rules: [] }))
  const delegation = { status: 'ok', tasks: [{ key: 'o', task_id: 't_o', status: 'active', expected: { id: 'O' } }] }
  const [a, b] = place([plain, oneOff], ok([accepted('k1', 6, 'H1')]), delegation)
  assert.equal(a, plain)
  assert.equal(b.column, 'In progress')
  assert.equal(b.occurrence, undefined)
})

test('a paused match is shown as needing you, never as a continuation', () => {
  const [placed] = place([card(reminder('R', 7))], ok([row('k1', 6, 'needs_reconciliation', { reason: 'source_occurrence_changed' })]))
  assert.equal(placed.column, 'Needs you')
  // A Reminders change: the card says Paused (attention), not a vague alarm.
  assert.equal(placed.agent.label, 'Paused')
  assert.equal(placed.agent.tone, 'attention')
  // The reminder now says Nov 7; the dialog names the occurrence Hermes had.
  assert.equal(occurrenceDialog(placed).pill.label, 'Nov 6 · This occurrence')
  assert.equal(placed.occurrence.role, 'delegated')
})

test('dropping a repeating reminder on Ready for Agent asks which occurrence', () => {
  const todo = card(reminder('R', 7))
  assert.deepEqual(moveVerdict(todo, 'Ready for Agent', { pickup: true, choose: true }), { kind: 'choose', action: 'choose' })
  assert.equal(moveVerdict(todo, 'Ready for Agent', { pickup: false, choose: true }).refused, 'pickup_off')
  // Without the choice (ticket 13 alone) it is still refused.
  assert.equal(moveVerdict(todo, 'Ready for Agent', { pickup: true }).refused, 'recurring')
  // The next occurrence carries the earlier task link; that does not block a fresh delegation.
  const linked = card(reminder('R', 7, { notes: 'n\n\nOpen in Hermes: https://owner.example/reminders?owner=o&link=l&profile=default' }))
  assert.deepEqual(moveVerdict(linked, 'Ready for Agent', { pickup: true, choose: true }), { kind: 'choose', action: 'choose' })
})

test('ready reads the reminder’s open occurrence, not an accepted one with the same ID', () => {
  const answer = ok([accepted('k1', 6, 'H1'), row('k2', 7, 'preparing')])
  const outcome = occurrenceOutcome(answer, 'ready', { sourceId: 'R' })
  assert.equal(outcome.result.status, 'ok')
  assert.equal(outcome.shown.message, 'Delegated this occurrence (Nov 7).')
  assert.equal(occurrenceOutcome(ok([accepted('k1', 6, 'H1')]), 'ready', { sourceId: 'R' }).result.status, 'failed')
})

test('accept reads its own occurrence by key', () => {
  assert.equal(occurrenceOutcome(ok([accepted('k1', 6, 'H1')]), 'accept', { key: 'k1' }).result.status, 'ok')
  assert.equal(occurrenceOutcome(ok([row('k1', 6, 'needs_reconciliation')]), 'accept', { key: 'k1' }).result.status, 'pending')
  assert.equal(occurrenceOutcome(ok([row('k1', 6, 'result')]), 'accept', { key: 'k1' }).result.status, 'failed')
})

test('refusals read in plain words', () => {
  const said = reason => occurrenceOutcome({ status: 'attention', reason }, 'ready', { sourceId: 'R' }).message
  assert.match(said('unrecognized inherited link needs reconciliation'), /another task's link/)
  assert.match(said('successor needs reconciliation'), /match it to the last occurrence/)
  assert.match(said('changed or ambiguous source'), /changed in Reminders/)
  assert.equal(occurrenceOutcome({ status: 'inactive' }, 'ready', { sourceId: 'R' }).message, 'Turn on agent pickup first.')
})

test('Accept in the conversation goes to the route that owns the task', async () => {
  const api = (single, occ) => ({ get: async path => (path === '/delegation' ? single : occ) })
  const oneOff = { status: 'ok', tasks: [{ task_id: 't_o', expected: { id: 'O' } }] }
  assert.deepEqual(await acceptRequest(api(oneOff, ok([])), 't_o'), ['/delegation/actions', { action: 'accept', expected: { id: 'O' } }])
  assert.deepEqual(await acceptRequest(api(oneOff, ok([row('k1', 6, 'result')])), 't_k1'), ['/occurrences/actions', { action: 'accept', occurrence_id: 'k1' }])
  assert.equal(await acceptRequest(api(oneOff, ok([])), 't_x'), null)
})

test('Accept only reuses routing data for the exact task on screen', async () => {
  const reads = []
  const api = { get: async path => { reads.push(path); return ok([]) } }
  const known = { task: { task_id: 'old', expected: { id: 'O' } }, occurrence: { key: 'old-key', review: true }, occurrenceTaskId: 'old' }
  assert.equal(await acceptRequest(api, 'new', known), null)
  assert.deepEqual(reads.sort(), ['/delegation', '/occurrences'])
  reads.length = 0
  assert.equal(await acceptRequest(api, 'old', { task: { ...known.task, scope: 'this_occurrence' } }), null)
  assert.deepEqual(reads.sort(), ['/delegation', '/occurrences'], 'a recurring row cannot use the one-off route')
})

test('a pause says what changed in Reminders, and the dialog pill matches the card', () => {
  const moved = row('k1', 6, 'needs_reconciliation', { reason: 'source_occurrence_changed' })
  assert.equal(pauseText(moved, reminder('R', 7), NOW), 'Due date moved from Nov 6 to Nov 7')
  assert.equal(pauseText(moved, reminder('R', 6, { rules: [{ frequency: 1 }] }), NOW), 'Repeat changed in Reminders')
  assert.equal(pauseText(moved, reminder('R', 6, { title: 'Renamed' }), NOW), 'The reminder changed in Reminders')
  assert.equal(pauseText({ ...moved, reason: 'deleted' }, null), 'The reminder was deleted in Reminders')
  const [paused] = place([card(reminder('R', 7))], ok([moved]))
  assert.deepEqual(boardPill(paused), { label: 'Paused', tone: 'attention' })
  // The dialog names the occurrence Hermes had and carries the notice for its thread.
  const dialog = occurrenceDialog(paused, NOW)
  assert.equal(dialog.pill.label, 'Nov 6 · This occurrence')
  assert.equal(dialog.paused, 'Due date moved from Nov 6 to Nov 7')
  assert.equal(occurrenceDateLabel(paused), 'Nov 6 · This occurrence')
  // The date pill's overdue tone follows the occurrence's own date, not the moved reminder's.
  const [late] = place([card(reminder('R', 9))], ok([row('k9', 4, 'needs_reconciliation', { reason: 'source_occurrence_changed' })]))
  assert.equal(late.occurrence.entry.overdue, true)
  // Queued work: the held Hermes task reads Paused, the card says it is waiting.
  const [queued] = place([card(reminder('R', 6))], { ...ok([row('k2', 6, 'paused')]), limits: { queue: [{ task_id: 't_k2', reason: 'board_capacity' }] } })
  // The pill names the state; the thread's line carries the wait reason, so they don't repeat.
  assert.deepEqual(boardPill(queued), { label: 'Queued', tone: 'agent' })
  // A capacity wait is queued work in In progress: the pill still follows the card.
  const [cooling] = place([card(reminder('R', 6))], { ...ok([row('k4', 6, 'ready')]), limits: { queue: [{ task_id: 't_k4', reason: 'host_cooldown' }] } })
  assert.equal(cooling.column, 'In progress')
  assert.deepEqual(boardPill(cooling), { label: 'Queued', tone: 'agent' })
  // Running work keeps the conversation's own pill.
  const [running] = place([card(reminder('R', 6))], ok([row('k3', 6, 'active')]))
  assert.equal(boardPill(running), null)
})

test('a stopped occurrence goes back to To do as Stopped, and nothing is left for the tick', () => {
  const stopped = row('k1', 6, 'stopped', { stop_intent: true, stopped_at: '2026-11-07T05:52:10Z' })
  const [placed] = place([card(reminder('R', 6))], ok([stopped]))
  assert.equal(placed.column, 'To do')
  assert.equal(placed.agent.label, 'Stopped')
  assert.equal(placed.occurrence.role, 'delegated')
  assert.equal(hasOutstanding(ok([stopped])), false)
  assert.equal(hasOutstanding(ok([row('k2', 6, 'needs_reconciliation', { stop_intent: true })])), true)
})

test('Run again: the new run owns the card, the old one is its history, and it is offered only when it can work', () => {
  const moved = { reason: 'source_occurrence_changed' }
  const old = row('k1', 7, 'stopped', { stop_intent: true, stop_receipt: { runs: [], worker_stop_verified: true } })
  const again = row('k2', 8, 'active', { rerun_of: 'k1', authorization_id: 'series-2' })
  const [placed] = place([card(reminder('R', 8))], ok([old, again]))
  assert.equal(placed.agent.row.key, 'k2')
  assert.equal(placed.column, 'In progress')
  assert.deepEqual(placed.occurrence.history.map(entry => entry.key), ['k1'])
  assert.deepEqual(occurrenceDialog(placed, NOW).previous, { key: 'k1', date: 'Nov 7' })
  // Offered only when the backend will accept it: never ran, or its runs were inspected.
  assert.equal(rerunMode(old, null, reminder('R', 8)), 'run')
  assert.equal(rerunMode({ ...old, stop_receipt: { runs: [{ id: 1 }] } }, null, reminder('R', 8)), 'confirm')
  assert.equal(rerunMode({ ...old, stop_receipt: { runs: [{ id: 1 }] }, rerun_reconciliation: { runs: [{ id: 1 }] } }, null, reminder('R', 8)), 'run')
  const paused = row('k3', 7, 'needs_reconciliation', moved)
  assert.equal(rerunMode(paused, [], reminder('R', 8)), 'run')
  assert.equal(rerunMode(paused, [{ id: 1 }], reminder('R', 8)), 'confirm')
  assert.equal(rerunMode(paused, null, reminder('R', 8)), null)
  assert.equal(rerunMode({ ...paused, reason: 'identity_replaced' }, [], reminder('R', 8)), null)
  assert.equal(rerunMode(row('k4', 7, 'active'), [], reminder('R', 8)), null)
  // Stopped rows carry work_before_stop; consent binds to its latest finished run.
  assert.equal(rerunMode({ ...old, work_before_stop: { runs: [{ id: 3, ended_at: 1 }] } }, null, reminder('R', 8)), 'confirm')
  assert.equal(confirmableRun({ runs: [{ id: 2, ended_at: 1 }, { id: 3, ended_at: 2 }] }), 3)
  assert.equal(confirmableRun({ runs: [{ id: 3, ended_at: null }] }), null)
  assert.equal(occurrenceOutcome({ status: 'attention', reason: 'stale_run' }, 'rerun', { key: 'k1' }).message, 'Hermes ran again since this was shown. Check what it did, then try again')
  // A completion left to reconcile blocks every rerun: no Run again (it would stop, then refuse).
  assert.equal(rerunMode({ ...paused, completion: { status: 'needs_reconciliation' } }, [{ id: 1 }], reminder('R', 8)), null)
  // A reminder that lost its due date or repeat can't run again.
  assert.equal(rerunMode(paused, [], reminder('R', 8, { due: null })), null)
  assert.equal(rerunMode(paused, [], reminder('R', 8, { rules: [] })), null)
  // Outcomes in plain words; a refusal names why.
  const okAnswer = { status: 'ok', task: again, tasks: [old, again] }
  assert.equal(occurrenceOutcome(okAnswer, 'rerun', { key: 'k1' }).message, 'Running again for Nov 8.')
  assert.equal(occurrenceOutcome({ status: 'attention', reason: 'external effects need reconciliation' }, 'rerun', { key: 'k1' }).message, 'Hermes needs the last run checked before it runs again')
  assert.match(occurrenceOutcome({ status: 'needs_reconciliation', task: old }, 'rerun', { key: 'k1' }).message, /couldn't confirm the last run stopped/)
})

test('only a row this board just created reads Queued while Hermes holds it, and not for long', () => {
  const row = { key: 'K', task_id: 't1', scope: 'this_occurrence', status: 'paused', guard: { status: 'active' }, expected: { id: 'R', due: { year: 2026, month: 11, day: 8 } } }
  const occ = { status: 'ok', tasks: [row, { ...row, key: 'W' }, { ...row, key: 'V', guard: { status: 'paused' } }, { ...row, key: 'S', stop_intent: true }] }
  const fresh = new Map([['K', 0], ['V', 0], ['S', 0]])
  // W paused itself while working (not just created): it stays paused.
  assert.deepEqual(queuedWhileHeld(occ, fresh).tasks.map(r => [r.key, r.status]), [['K', 'ready'], ['W', 'paused'], ['V', 'paused'], ['S', 'paused']])
  // A key leaves once Hermes moves it on, or once the hold has outlasted a tick.
  const moved = { status: 'ok', tasks: [{ ...row, status: 'active' }, { ...row, key: 'V', guard: { status: 'paused' } }] }
  assert.deepEqual([...stillHeld(moved, new Map([['K', 0], ['V', 0], ['gone', 0]]), 1000).keys()], ['gone'])
  assert.deepEqual([...stillHeld(occ, new Map([['K', 0]]), 1000).keys()], ['K'])
  assert.deepEqual([...stillHeld(occ, new Map([['K', 0]]), FRESH_MS).keys()], [])
  // This occurrence answers with every row: the new key is the one the board didn't have.
  const mine = { expected: { id: 'R' } }
  const other = { expected: { id: 'O' } }
  assert.deepEqual(newKeys({ status: 'ok', tasks: [{ key: 'A', ...mine }] }, { status: 'ok', tasks: [{ key: 'A', ...mine }, { key: 'B', ...other }, { key: 'K', ...mine }] }, 'R'), ['K'])
})

test('the owner question: which row asks, what it sends, how a refusal reads', () => {
  const snapshot = reminder('R', 8)
  const asked = { key: 'K', scope: 'this_occurrence', status: 'needs_reconciliation', reason: 'source_occurrence_changed', owner_question: 'checked_off_or_moved', source_accept_intent: 'i1', advance_snapshot: snapshot, old_due: day(7), new_due: day(8), completion: { status: 'needs_reconciliation', reason: 'conflicting_or_missing_history' } }
  assert.equal(advanceQuestion(asked), true)
  assert.equal(advanceQuestion({ ...asked, source_accept_intent: null }), false)
  assert.equal(advanceQuestion({ ...asked, accepted: true }), false)
  assert.deepEqual(resolveRequest(asked, 'date_moved'), { action: 'resolve_advance', occurrence_id: 'K', answer: 'date_moved', intent_id: 'i1', expected: snapshot })
  // The pause line names both dates the backend saw; Run again waits for the answer.
  assert.equal(pauseText(asked, reminder('R', 9), NOW), 'Due date moved from Nov 7 to Nov 8')
  assert.equal(rerunMode(asked, [{ id: 1 }], reminder('R', 8)), null)
  assert.equal(resolveProblem({ status: 'conflict', reason: 'stale_advance' }), 'Reminders changed again. Check the date, then answer again.')
  // After "the date moved": a changed-date pause that Run again (asking first) answers.
  const moved = { key: 'K', scope: 'this_occurrence', status: 'paused', reason: 'source_occurrence_changed', guard: { status: 'paused' } }
  assert.equal(sourcePaused(moved), true)
  assert.equal(sourcePaused({ ...moved, stop_intent: true }), false)
  assert.equal(rerunMode(moved, [{ id: 1 }], reminder('R', 8)), 'confirm')
})

test('an answer drops the fields the backend dropped, and keeps the views only GET adds', () => {
  const cached = [{ key: 'K', status: 'needs_reconciliation', owner_question: 'checked_off_or_moved', work_before_stop: { runs: [1] }, review_available: false }]
  const [merged] = withViews(cached, [{ key: 'K', status: 'paused' }])
  assert.equal(merged.owner_question, undefined)
  assert.deepEqual(merged.work_before_stop, { runs: [1] })
  assert.equal(merged.status, 'paused')
})

test('an occurrence review reads its /occurrences row, not the one-off attention feed', () => {
  const occ = { status: 'ok', tasks: [{ key: 'K', task_id: 't1', review_available: true, required_action: 'review', state: 'result' }, { key: 'Q', task_id: 't2', review_available: false, required_action: 'reply', state: 'question' }] }
  assert.deepEqual(occurrenceAttention(occ, 't1'), { key: 'K', review: true, question: false })
  assert.deepEqual(occurrenceAttention(occ, 't2'), { key: 'Q', review: false, question: true })
  assert.equal(occurrenceAttention(occ, 'one-off'), null)
  // No occurrences on this Hermes: not one. A failed read (Reminders access, an error): can't tell.
  assert.equal(occurrenceAttention({ status: 'setup_required' }, 't1'), null)
  assert.equal(occurrenceAttention({ status: 'access_denied' }, 't1'), undefined)
})

// Ticket 35: an occurrence question gets the reply box, never Stop, even while the reads disagree.
test('a question row with a stale active live state offers no Stop, and the reply box shows', () => {
  const row = { key: 'Q', task_id: 't_q', status: 'question', scope: 'this_occurrence', required_action: 'reply', state: 'question' }
  // Ticket 13's live read still says the worker runs; live wins in agentState, so the column reads In progress.
  const stale = agentState(row, null, { state: 'active' })
  assert.equal(stale.column, 'In progress')
  assert.equal(occurrenceStoppable(stale, row), false)
  // The conversation's composer is not held back for this occurrence, so its reply box shows.
  const own = occurrenceAttention({ status: 'ok', tasks: [row] }, 't_q')
  assert.equal(own.question, true)
  assert.equal(occurrenceHolds('reply', own), false)
  // Once the reads agree, a question sits in Needs you with no Stop either.
  assert.equal(occurrenceStoppable(agentState(row), row), false)
})

test('queued or running occurrence work still offers Stop', () => {
  const running = { key: 'R', task_id: 't_r', status: 'active', scope: 'this_occurrence' }
  assert.equal(occurrenceStoppable(agentState(running), running), true)
  const queued = { key: 'Q2', task_id: 't_q2', status: 'ready', scope: 'this_occurrence' }
  assert.equal(occurrenceStoppable(agentState(queued), queued), true)
  // No Hermes task yet (preparing): nothing to stop.
  assert.equal(occurrenceStoppable(agentState({ ...running, task_id: null }), { ...running, task_id: null }), false)
})

test('the picker names a one-off reminder’s entries as runs, a repeating one’s as occurrences', async () => {
  const { pickerTexts } = await import('../src/lib/occurrences.js')
  const entries = [{ id: 'b', current: true }, { id: 'a', current: false }]
  // Run again on a one-off adds a second task under the same link: two runs, no dates.
  assert.deepEqual(pickerTexts({}, entries, false), ['Current run', 'Earlier run 1'])
  assert.deepEqual(pickerTexts({}, entries), ['Current occurrence', 'Earlier occurrence 1'])
  // Seen live: the current entry can come last; the one earlier entry is still "1", not "2".
  assert.deepEqual(pickerTexts({}, [...entries].reverse(), false), ['Earlier run 1', 'Current run'])
  assert.deepEqual(pickerTexts({}, [{ id: 'c', current: false }, { id: 'a', current: false }, { id: 'b', current: true }], false), ['Earlier run 2', 'Earlier run 1', 'Current run'])
  // A known date always wins.
  assert.deepEqual(pickerTexts({ a: { text: 'Nov 7 · Accepted' } }, entries, true), ['Current occurrence', 'Nov 7 · Accepted'])
})

test('the history line for an earlier entry says run on a one-off and occurrence on a repeating reminder', async () => {
  const { earlierLabel } = await import('../src/lib/occurrences.js')
  // Ticket 34: choosing "Earlier run 1" on a one-off showed "Earlier occurrence".
  assert.equal(earlierLabel(null, false), 'Earlier run')
  assert.equal(earlierLabel('Nov 8', false), 'Earlier run · Nov 8')
  assert.equal(earlierLabel('Nov 8'), 'Earlier occurrence · Nov 8')
  assert.equal(earlierLabel(null, true), 'Earlier occurrence')
})

test('an accepted occurrence whose check-off is unconfirmed is not called a Reminders pause', () => {
  const unsure = row('k1', 6, 'needs_reconciliation', { accepted: true })
  const [placed] = place([card(reminder('R', 6))], ok([unsure]))
  assert.equal(placed.column, 'Needs you')
  assert.equal(placed.agent.label, 'Check what happened')
  assert.equal(occurrenceEntry(unsure).state, 'Check what happened')
  assert.equal(occurrenceDialog(placed).paused, null)
})
