import assert from 'node:assert/strict'
import { test } from 'node:test'

import { cardShows, showsTask, waitingTasks } from '../src/lib/attention.js'
import { agentState, placeCards } from '../src/lib/placement.js'
import { actionOutcome } from '../src/lib/delegation-outcomes.js'
import { submissionOutcome } from '../src/lib/task-link.js'
import { occurrenceEntry, pauseText } from '../src/lib/occurrences.js'
import { browserQueuedLabel, listsWithWork, conversationHold, readyCount, startableReady, heldReason, holdActivity, holdQueued, isStale, linkCopyOf, QUEUED_CHECKING, QUEUED_PICKUP_OFF, QUEUED_STALE, reconnectFindings, SOURCE_TEXT } from '../src/lib/reconciliation.js'

const LINK = 'https://mac.example/reminders?owner=o1&link=l1&profile=default'
const linked = (id, notes = '') => ({ id, title: id, notes: `${notes}\nOpen in Hermes: ${LINK}`.trim() })
const task = (id, extra = {}) => ({ key: `k-${id}`, task_id: `t_${id}`, expected: { id, title: `Task ${id}` }, destination: { owner_id: 'o1', link_id: 'l1', url: LINK }, ...extra })

test('a stale board or a reconnect read never shows queued work as up next', () => {
  assert.equal(isStale({ kind: 'unavailable_host' }), true)
  assert.equal(isStale({ kind: 'access_denied' }), true)
  assert.equal(isStale({ kind: 'checking' }), false)
  assert.equal(isStale(null), false)
  const queued = { id: 'a', agent: { status: 'ready', label: 'Up next' } }
  const wait = { id: 'b', agent: { status: 'ready', label: 'Waiting for capacity', waiting: true } }
  const working = { id: 'c', agent: { status: 'active', label: 'Working' } }
  const mine = { id: 'd' }
  const [a, b, c, d] = holdQueued([queued, wait, working, mine], QUEUED_STALE)
  assert.equal(a.agent.label, QUEUED_STALE)
  assert.equal(a.agent.line, QUEUED_STALE)
  assert.equal(b, wait)
  assert.equal(c, working)
  assert.equal(d, mine)
  assert.equal(holdQueued([queued], QUEUED_CHECKING)[0].agent.label, QUEUED_CHECKING)
  assert.deepEqual(holdQueued([queued], null), [queued])
})

test('held reasons come only from a paused guard', () => {
  assert.equal(heldReason({ guard: { status: 'paused', reason: 'conflicting_links' } }), 'conflicting_links')
  assert.equal(heldReason({ guard: { status: 'paused', reason: 'instructions_changed' } }), null)
  assert.equal(heldReason({ guard: { status: 'stopped', reason: 'missing_identity' } }), null)
  assert.equal(heldReason(null), null)
})

test('one-off and occurrence pauses read the same words', () => {
  for (const reason of ['identity_replaced', 'missing_identity', 'multiple_candidates', 'conflicting_links', 'deleted', 'source_unavailable']) {
    assert.equal(pauseText({ reason }), SOURCE_TEXT[reason])
  }
})

test('a copied link names the task it copies; the original reminder is never a copy', () => {
  const rows = [task('a')]
  assert.deepEqual(linkCopyOf({ source: linked('b', 'mine') }, rows), { taskId: 't_a', title: 'Task a' })
  assert.equal(linkCopyOf({ source: linked('a') }, rows), null)
  assert.equal(linkCopyOf({ source: { id: 'b', notes: 'no link' } }, rows), null)
  // A link some other owner minted is not this task's.
  assert.equal(linkCopyOf({ source: linked('b') }, [task('a', { destination: { owner_id: 'o2', link_id: 'l1' } })]), null)
  // An occurrence row names its reminder card through `match`.
  assert.equal(linkCopyOf({ source: linked('r') }, [task('x', { match: 'r', scope: 'this_occurrence' })]), null)
})

test('the next occurrence after accepting This occurrence keeps its inherited link and is not a copy', () => {
  // Seen live (ticket 28C): the accepted row places on Apple's completed copy (`match`), while the
  // pending next occurrence keeps the reminder's id and the task link in its notes.
  const accepted = task('r', { scope: 'this_occurrence', status: 'done', match: 'history', completion: { status: 'completed', history_id: 'history', successor: { id: 'r' } } })
  assert.equal(linkCopyOf({ source: linked('r') }, [accepted]), null)
  // Matched by the successor id alone too (a row whose expected id is not the card's).
  assert.equal(linkCopyOf({ source: linked('next') }, [task('x', { scope: 'this_occurrence', match: 'history', completion: { successor: { id: 'next' } } })]), null)
  // A different reminder carrying that link is still a copy.
  assert.deepEqual(linkCopyOf({ source: linked('copy', 'mine') }, [accepted]).taskId, 't_r')
})

test('a copied link or replacement reminder never shows or opens the task (story 60)', () => {
  const feedTask = { task_id: 't_a', guard: { source_id: 'a' }, destination: { owner_id: 'o1', link_id: 'l1', url: LINK } }
  const dest = { owner: 'o1', link: 'l1' }
  assert.equal(cardShows(feedTask, { id: 'a' }, null), true)
  assert.equal(cardShows(feedTask, { id: 'b' }, dest), false)
  // Before the guard names its reminder, the link is all there is.
  assert.equal(cardShows({ ...feedTask, guard: {} }, { id: 'b' }, dest), true)
  assert.equal(showsTask({ card: { source: linked('b') }, dest }, feedTask), false)
})

test('the need-you list names a held task for what changed', () => {
  const feed = { status: 'ok', cursor: 1, tasks: [{ task_id: 't_a', state: 'paused', required_action: 'resume', guard: { status: 'paused', reason: 'multiple_candidates' }, history: { task: { title: 'A' } } }] }
  const [item] = waitingTasks(feed)
  assert.equal(item.kind, 'held')
  assert.equal(item.short, 'Several reminders match')
})

test('reconnect findings report only what changed while Reminders was unreadable', () => {
  const before = [
    task('a', { status: 'ready', guard: { status: 'active' } }),
    task('b', { status: 'active', guard: { status: 'active' } }),
    task('c', { status: 'paused', guard: { status: 'paused', reason: 'source_unavailable' } }),
    task('d', { status: 'ready', guard: { status: 'active' } }),
    task('e', { status: 'ready', guard: { status: 'active' } }),
    task('f', { status: 'done', guard: { status: 'stopped', reason: 'completed' } }),
    { key: 'occ-1', task_id: 't_o', scope: 'every_occurrence', status: 'result', series_state: 'active', source: { title: 'Weekly' } }
  ]
  const after = [
    task('a', { status: 'deleted', guard: { status: 'deleted', reason: 'deleted', hidden: true } }),
    task('b', { status: 'stopped', guard: { status: 'stopped', reason: 'completed' } }),
    task('c', { status: 'paused', guard: { status: 'paused', reason: 'instructions_changed' } }),
    task('d', { status: 'paused', guard: { status: 'paused', reason: 'conflicting_links' } }),
    task('e', { status: 'ready', guard: { status: 'active' } }),
    task('f', { status: 'done', guard: { status: 'stopped', reason: 'completed' } }),
    { key: 'occ-1', task_id: 't_o', scope: 'every_occurrence', status: 'result', series_state: 'needs_reconciliation', held_reason: 'changed_instructions', source: { title: 'Weekly' } },
    task('new', { status: 'deleted', guard: { status: 'deleted', reason: 'deleted' } })
  ]
  const found = reconnectFindings(before, after)
  assert.deepEqual(
    found.map(item => [item.key, item.kind, item.text]),
    [
      ['k-a', 'deleted', 'Deleted in Reminders'],
      ['k-b', 'completed', 'Checked off in Reminders'],
      ['k-c', 'instructions_changed', 'Instructions changed'],
      ['k-d', 'conflicting_links', 'Task link copied'],
      ['occ-1', 'series', 'Needs a decision']
    ]
  )
  assert.equal(found[0].destination.url, LINK)
  assert.equal(found[0].title, 'Task a')
  assert.equal(found[4].occurrence, 'occ-1')
  assert.deepEqual(reconnectFindings(null, after), [])
})

test('a guard pause wins over the live task state, so the card says why it stopped', () => {
  const paused = reason => ({ key: 'k', task_id: 't', status: 'paused', guard: { status: 'paused', reason } })
  assert.equal(agentState(paused('source_unavailable'), null, { task_id: 't', state: 'failed' }).label, 'Waiting for Reminders')
  assert.equal(agentState(paused('missing_identity'), null, { task_id: 't', state: 'result' }).label, "Can't find the reminder")
  // Without a veto the live state still wins (a question that just arrived).
  assert.equal(agentState({ key: 'k', task_id: 't', status: 'active', guard: { status: 'active' } }, null, { task_id: 't', state: 'question' }).status, 'question')
})

test('the dialog pill names a held or waiting task as its card does', async () => {
  const { boardPill } = await import('../src/recurring/dialog.js')
  const held = agentState({ key: 'k', task_id: 't', status: 'paused', guard: { status: 'paused', reason: 'multiple_candidates' } })
  assert.deepEqual(boardPill({ agent: held }), { label: 'Several reminders match', tone: 'attention' })
  const wait = agentState({ key: 'k', task_id: 't', status: 'paused', guard: { status: 'paused', reason: 'source_unavailable' } })
  assert.deepEqual(boardPill({ agent: wait }), { label: 'Waiting for Reminders', tone: 'muted' })
})

test('a Reminders outage is a wait in In progress that resumes on its own (#74)', () => {
  const row = { key: 'k', task_id: 't', status: 'waiting_source', guard: { status: 'waiting_source', reason: 'source_unavailable' } }
  const state = agentState(row)
  assert.equal(state.column, 'In progress')
  assert.equal(state.label, 'Waiting for Reminders')
  assert.equal(state.action, 'source_wait')
  assert.equal(state.waiting, true)
  // The live view keeps its state and adds wait_reason; an occurrence row keeps its status.
  const active = { key: 'k', task_id: 't', status: 'active', guard: { status: 'active' } }
  assert.equal(agentState(active, null, { task_id: 't', state: 'question', wait_reason: 'source_unavailable' }).label, 'Waiting for Reminders')
  assert.equal(agentState({ ...active, guard: { status: 'waiting_source', reason: 'source_unavailable' } }).column, 'In progress')
  // Recovered: the original state again.
  assert.equal(agentState(active, null, { task_id: 't', state: 'question', wait_reason: null }).label, 'Answer Hermes')
  // A finished task never reads as waiting.
  assert.equal(agentState({ ...row, status: 'done' }).status, 'done')
})

test('a Reminders wait is never relabeled by the queue or by a cached recovery (Sol Q1, Q2)', () => {
  // A queued occurrence whose guard waits: no "Up next" / "Waiting for capacity".
  const queued = { key: 'k', task_id: 't', status: 'ready', guard: { status: 'waiting_source', reason: 'source_unavailable' } }
  for (const reason of [null, 'host_cooldown', 'board_capacity']) {
    const state = agentState(queued, { queue: [{ task_id: 't', reason }] })
    assert.equal(state.label, 'Waiting for Reminders')
    assert.equal(state.column, 'In progress')
  }
  // A cached failed row with a retry recovery, while the live view says it waits for Reminders.
  const failed = { key: 'k', task_id: 't', status: 'failed', guard: { status: 'active' }, recovery: { action: 'retry', run_id: 1 } }
  const state = agentState(failed, null, { task_id: 't', state: 'failed', waiting: true, required_action: null, wait_reason: 'source_unavailable', recovery: { action: 'retry', run_id: 1 } })
  assert.equal(state.label, 'Waiting for Reminders')
  assert.equal(state.column, 'In progress')
  assert.equal(state.action, 'source_wait')
})

test('an occurrence waiting for Reminders reads as that wait in its history, and is not listed as needing you', () => {
  const row = { key: 'occ', task_id: 't', status: 'active', state: 'waiting_source', waiting: true, required_action: null, wait_reason: 'source_unavailable', source: { due: null } }
  assert.equal(occurrenceEntry(row).state, 'Waiting for Reminders')
  const feed = { status: 'ok', cursor: 1, needs_you_count: 0, tasks: [{ ...row, history: { task: { title: 'Weekly' } } }] }
  assert.deepEqual(waitingTasks(feed), [])
})

test('the conversation line never shows a held or waiting task as running or as a plain pause', () => {
  // One-off, waiting for Reminders while its worker still runs (live state kept, wait_reason added).
  const oneOff = { key: 'k', task_id: 't', status: 'active', guard: { status: 'active' } }
  const waiting = holdActivity(agentState(oneOff, null, { task_id: 't', state: 'active', wait_reason: 'source_unavailable' }))
  assert.deepEqual(waiting, { kind: 'waiting', label: 'Waiting for Reminders', since: null, blocks: true, pill: 'Waiting for Reminders', line: "Hermes can't read Reminders right now. It picks this up again on its own." })
  // An occurrence: its row keeps its status, its guard waits.
  const occurrence = { key: 'occ', task_id: 'o', scope: 'this_occurrence', status: 'active', guard: { status: 'waiting_source', reason: 'source_unavailable' } }
  assert.equal(holdActivity(agentState(occurrence)).kind, 'waiting')
  // Held identities name the hold, not "Paused".
  const held = { key: 'k', task_id: 't', status: 'paused', guard: { status: 'paused', reason: 'multiple_candidates' } }
  assert.deepEqual(holdActivity(agentState(held)), { kind: 'held', label: 'Held: several reminders match', since: null, blocks: true, pill: 'Several reminders match', line: "More than one reminder matches this one. Hermes won't pick one." })
  assert.equal(holdActivity(agentState({ ...held, guard: { status: 'paused', reason: 'missing_identity' } })).label, "Held: can't find the reminder")
  // Anything else keeps the conversation's own line.
  assert.equal(holdActivity(agentState(oneOff)), null)
  assert.equal(holdActivity(agentState({ ...held, guard: { status: 'paused', reason: 'instructions_changed' } })), null)
  assert.equal(holdActivity(null), null)
})

test('the hold line shows on the current occurrence only, in Desktop and the browser alike (Sol U1, U2)', () => {
  const wait = { kind: 'waiting', label: 'Waiting for Reminders', since: null, blocks: true, pill: 'Waiting for Reminders', line: "Hermes can't read Reminders right now. It picks this up again on its own." }
  const view = { taskId: 't', historical: false, currentOccurrence: 'occ-2', selectedOccurrence: null }
  // Desktop: the card's hold, never under an earlier occurrence's history.
  assert.deepEqual(conversationHold(view, { hold: wait }, agentState), wait)
  assert.equal(conversationHold({ ...view, historical: true, selectedOccurrence: 'occ-1' }, { hold: wait }, agentState), null)
  // Browser, repeating reminder: the row of the occurrence on screen.
  const rows = [
    { key: 'occ-1', task_id: 't', scope: 'every_occurrence', status: 'done', guard: { status: 'active' } },
    { key: 'occ-2', task_id: 't', scope: 'every_occurrence', status: 'active', guard: { status: 'waiting_source', reason: 'source_unavailable' } }
  ]
  assert.deepEqual(conversationHold(view, { occurrenceRows: rows }, agentState), wait)
  assert.equal(conversationHold({ ...view, currentOccurrence: 'occ-1' }, { occurrenceRows: rows }, agentState), null)
  // Browser, one-off: its delegation row.
  const held = { key: 'k', task_id: 't', status: 'paused', guard: { status: 'paused', reason: 'conflicting_links' } }
  assert.equal(conversationHold(view, { recoveryRow: held }, agentState).label, 'Held: task link copied')
  assert.equal(conversationHold(null, { hold: wait }, agentState), null)
})

test('a delivered result stays reviewable through a Reminders outage; Accept waits for Reminders (#80)', () => {
  // Live view keeps result/review with wait_reason; the row's guard (and even status) waits.
  const row = { key: 'k', task_id: 't', expected: { id: 'a' }, status: 'waiting_source', guard: { status: 'waiting_source', reason: 'source_unavailable' } }
  const live = { task_id: 't', state: 'result', waiting: false, required_action: 'review', wait_reason: 'source_unavailable' }
  const state = agentState(row, null, live)
  assert.equal(state.column, 'Needs you')
  assert.equal(state.label, 'Review result')
  assert.equal(state.action, 'review')
  assert.equal(holdActivity(state), null)
  // GET /delegation view fields on the row tell the same without /attention.
  assert.equal(agentState({ ...row, state: 'result' }).label, 'Review result')
  // A running task still waits.
  assert.equal(agentState(row, null, { task_id: 't', state: 'active', wait_reason: 'source_unavailable' }).label, 'Waiting for Reminders')
  // Accept refused while waiting: board card and task page say why.
  const refused = { status: 'waiting_source', reason: 'waiting for Reminders' }
  assert.match(actionOutcome(refused, 'accept', 'a').message, /can't read Reminders right now/)
  assert.match(submissionOutcome(refused, 'accept', 't').message, /Accept again once it's back/)
})

test('a delivered occurrence stored as paused stays a result through an outage (Sol W1)', () => {
  const row = { key: 'occ', task_id: 't', scope: 'every_occurrence', status: 'paused', state: 'result', guard: { status: 'waiting_source', reason: 'source_unavailable' } }
  const state = agentState(row)
  assert.equal(state.label, 'Review result')
  assert.equal(state.action, 'review')
  const view = { taskId: 't', historical: false, currentOccurrence: 'occ', selectedOccurrence: null }
  assert.equal(conversationHold(view, { occurrenceRows: [row] }, agentState), null)
  assert.equal(conversationHold(view, { hold: holdActivity(state) }, agentState), null)
})

test('a stored display read (#80) never reports zero Ready tasks; the board count stands in', () => {
  const stored = { data: { status: 'ok', stale: true, as_of: '2026-11-09T05:00:00Z', eligible: [] }, eligible: [] }
  assert.equal(readyCount(stored, 3), 3)
  const fresh = { data: { status: 'ok', eligible: [{ id: 'a' }, { id: 'b' }] }, eligible: [{ id: 'a' }, { id: 'b' }] }
  assert.equal(readyCount(fresh, 7), 2)
  assert.equal(readyCount({ data: { status: 'failed' }, eligible: [] }, 4), 4)
  assert.equal(readyCount(null), 0)
})

test('stored rows place the cards of a freshly opened board during an outage (#80)', () => {
  // GET /delegation during an outage: status ok, stale, with the stored task views.
  const stored = {
    status: 'ok',
    stale: true,
    as_of: '2026-11-09T05:00:00Z',
    tasks: [{ key: 'k', task_id: 't', expected: { id: 'a' }, status: 'waiting_source', state: 'active', guard: { status: 'waiting_source', reason: 'source_unavailable' } }]
  }
  const card = { id: 'c-a', owner: 'human', column: 'To do', source: { id: 'a', title: 'A', completed: false, rules: [] } }
  const [placed] = placeCards([card], stored)
  assert.equal(placed.owner, 'agent')
  assert.equal(placed.column, 'In progress')
  assert.equal(placed.agent.label, 'Waiting for Reminders')
})

test('the pickup count only counts Ready reminders activation would start (Sol Y1)', () => {
  const card = (id, extra = {}) => ({ id, imported_ready: true, column: 'Ready for Agent', source: { id, completed: false, rules: [] }, ...extra })
  const cards = [
    card('one-off'),
    card('repeating', { source: { id: 'r', completed: false, rules: [{ frequency: 'daily' }] } }),
    card('done', { column: 'Done', source: { id: 'd', completed: true, rules: [] } }),
    { id: 'plain', imported_ready: false, column: 'To do', source: { id: 'p', rules: [] } }
  ]
  assert.equal(startableReady(cards), 1)
  const stored = { data: { status: 'ok', stale: true, eligible: [] }, eligible: [] }
  assert.equal(readyCount(stored, startableReady(cards)), 1)
  assert.equal(startableReady(null), 0)
})

test('with pickup off, queued and waiting work says so and drops its next check; attention stays', () => {
  const cards = [
    { id: 'q', agent: { status: 'ready', column: 'Ready for Agent', label: 'Up next' } },
    { id: 'w', agent: { status: 'ready', waiting: true, column: 'In progress', label: 'Hermes hit a usage limit', nextCheckAt: '2026-11-11T09:00:00Z' } },
    { id: 'n', agent: { status: 'question', column: 'Needs you', label: 'Answer Hermes' } },
    { id: 'h' }
  ]
  const held = holdQueued(cards, QUEUED_PICKUP_OFF)
  assert.deepEqual(held.map(card => card.agent?.label), ['Waiting for pickup', 'Waiting for pickup', 'Answer Hermes', undefined])
  assert.equal(held[1].agent.nextCheckAt, null)
  // A repeating reminder's next occurrence is held too; a wait on Reminders keeps its own words.
  const more = holdQueued([{ id: 's', agent: { status: 'series_next', column: 'To do', label: 'Up next' } }, { id: 'r', agent: { status: 'ready', waiting: true, action: 'source_wait', column: 'In progress', label: 'Waiting for Reminders' } }], QUEUED_PICKUP_OFF)
  assert.deepEqual(more.map(card => card.agent.label), ['Waiting for pickup', 'Waiting for Reminders'])
  assert.deepEqual(holdActivity(held[1].agent), { kind: 'waiting', label: 'Waiting for pickup', since: null })
  assert.equal(holdActivity(more[0].agent), null)
  // A requeued task that needs you keeps its own label and stays out of the pickup hold.
  const needs = holdQueued([{ id: 'f', agent: { status: 'ready', column: 'Needs you', label: 'Balance empty', action: 'fund' } }], QUEUED_PICKUP_OFF)[0]
  assert.equal(needs.agent.label, 'Balance empty')
  assert.equal(needs.agent.pickupOff, undefined)
  // The Reminders holds still leave a usage wait alone.
  assert.equal(holdQueued(cards, QUEUED_STALE)[1].agent.label, 'Hermes hit a usage limit')
})

test('a Needs-you card keeps its own words while the queue is held for Reminders, and a paused occurrence reads Paused in the picker', () => {
  const needs = { id: 'a', agent: { status: 'ready', column: 'Needs you', label: 'Balance empty' } }
  const queued = { id: 'b', agent: { status: 'ready', column: 'Ready for Agent', label: 'Queued' } }
  for (const label of [QUEUED_STALE, QUEUED_CHECKING, QUEUED_PICKUP_OFF]) {
    const [kept, held] = holdQueued([needs, queued], label)
    assert.equal(kept.agent.label, 'Balance empty')
    assert.equal(held.agent.label, label)
  }
  assert.equal(occurrenceEntry({ key: 'k', status: 'needs_reconciliation' }).state, 'Paused')
  assert.notEqual(occurrenceEntry({ key: 'k', status: 'needs_reconciliation', stop_intent: true }).state, 'Paused')
})

test('a queued occurrence parked in Hermes reads Queued in the picker, not Paused', () => {
  assert.equal(occurrenceEntry({ key: 'k', status: 'paused', state: 'ready', guard: { status: 'active' } }).state, 'Queued')
  assert.equal(occurrenceEntry({ key: 'k', status: 'paused', state: 'paused', guard: { status: 'active' } }).state, 'Paused')
})

test('the browser page calls queued work queued, never paused', () => {
  const view = { taskId: 't', state: 'paused', historical: false, currentOccurrence: 'o1' }
  const queued = { task_id: 't', status: 'paused', state: 'ready', guard: { status: 'active' } }
  assert.equal(browserQueuedLabel(view, { recoveryRow: queued }), 'Queued')
  // A bare row from a wait tick has no live state: paused with an active guard is still the queue.
  assert.equal(browserQueuedLabel(view, { recoveryRow: { task_id: 't', status: 'paused', guard: { status: 'active' } } }), 'Queued')
  // A real pause (the reminder changed) keeps its own words.
  assert.equal(browserQueuedLabel(view, { recoveryRow: { ...queued, guard: { status: 'paused', reason: 'identity_replaced' } } }), null)
  assert.equal(browserQueuedLabel(view, { recoveryRow: { task_id: 't', status: 'needs_reconciliation' } }), null)
  // An occurrence waiting for its due time.
  const occurrence = { key: 'o1', task_id: 't', scope: 'every_occurrence', status: 'paused', state: 'waiting_due' }
  assert.equal(browserQueuedLabel(view, { occurrenceRows: [occurrence] }), 'Not due yet')
  assert.equal(browserQueuedLabel({ ...view, historical: true }, { occurrenceRows: [occurrence] }), null)
  assert.equal(browserQueuedLabel({ ...view, state: 'question' }, { recoveryRow: queued }), null)
  assert.equal(browserQueuedLabel(view, {}), null)
  // An occurrence parked with an unresolved failure is not a queue.
  const failed = { key: 'o1', task_id: 't', scope: 'this_occurrence', status: 'paused', state: 'ready', guard: { status: 'active' }, recovery: { run_id: 1, action: 'reconcile', column: 'Needs you' } }
  assert.equal(browserQueuedLabel(view, { occurrenceRows: [failed] }), null)
})

test('turning pickup on does not count labelled work Hermes already has or that was stopped', () => {
  const ready = extra => ({ imported_ready: true, column: 'To do', source: { completed: false, rules: [] }, ...extra })
  assert.equal(startableReady([ready(), ready({ agent: { status: 'ready' } }), ready({ agent: { status: 'result' } }), ready({ agent: { status: 'stopped' } }), ready({ agent: { status: 'question' } })]), 2)
  // Queued by a drag (no label in the title) still starts when pickup is turned on.
  assert.equal(startableReady([{ column: 'Ready for Agent', source: { completed: false, rules: [] }, agent: { status: 'ready' } }, { column: 'To do', source: { completed: false, rules: [] } }]), 1)
})

test('the list picker knows which lists Hermes still has work from', () => {
  const on = (list, extra) => ({ owner: 'agent', source: { calendarId: list, completed: false }, ...extra })
  assert.deepEqual(listsWithWork([on('a', { agent: { status: 'active' } }), on('a', { agent: { status: 'question' } }), on('b', { agent: { status: 'done' } }), { owner: 'human', source: { calendarId: 'b' }, agent: { status: 'stopped' } }, { owner: 'human', source: { calendarId: 'c' } }]), { a: 2 })
  assert.deepEqual(listsWithWork(null), {})
})
