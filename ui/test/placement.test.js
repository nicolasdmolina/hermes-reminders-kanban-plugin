import assert from 'node:assert/strict'
import { test } from 'node:test'

import { groupCards } from '../src/lib/cards.js'
import { moveVerdict } from '../src/lib/moves.js'
import { AGENT_REFUSALS, agentState, agentVerdict, keepAgentOrder, placeCards, rowFor, STATUS } from '../src/lib/placement.js'
import { holdQueued, listsWithWork, QUEUED_PICKUP_OFF, startableReady } from '../src/lib/reconciliation.js'

const card = (id, extra = {}) => ({
  id: `c-${id}`,
  owner: 'human',
  column: 'To do',
  recurring: false,
  source: { id, title: `Reminder ${id}`, completed: false, rules: [] },
  ...extra
})
const row = (id, status, extra = {}) => ({ expected: { id }, task_id: `t_${id}`, key: `k-${id}`, status, accepted: false, ...extra })

test('every delegation status lands in its column, with deleted work off the board', () => {
  const expect = {
    preparing: 'Ready for Agent',
    ready: 'Ready for Agent',
    active: 'In progress',
    question: 'Needs you',
    result: 'Needs you',
    failed: 'Needs you',
    paused: 'Needs you',
    needs_reconciliation: 'Needs you',
    preparation_attention: 'Needs you',
    stopped: 'To do',
    done: 'Done'
  }
  for (const [status, column] of Object.entries(expect)) assert.equal(agentState(row('a', status)).column, column, status)
  assert.equal(agentState(row('a', 'deleted')).column, null)
  // An unknown future status asks for a look instead of disappearing.
  assert.equal(agentState(row('a', 'something_new')).column, 'Needs you')
  const placed = placeCards([card('a'), card('b')], { tasks: [row('a', 'deleted')] })
  assert.deepEqual(placed.map(c => c.id), ['c-b'])
})

test('a delegated reminder is the agent’s whatever its title says, matched by source id', () => {
  const [placed] = placeCards([card('a')], { tasks: [row('a', 'active')] })
  assert.equal(placed.owner, 'agent')
  assert.equal(placed.column, 'In progress')
  assert.equal(placed.agent.label, 'Working')
  assert.equal(placed.agent.row.task_id, 't_a')
  assert.equal(rowFor(card('z'), { tasks: [row('a', 'active')] }), null)
  // The row's source after the managed link also matches.
  assert.equal(rowFor(card('n'), { tasks: [{ ...row('o', 'ready'), source: { id: 'n' } }] }).task_id, 't_o')
  // No delegation data: the same array comes back.
  const cards = [card('a')]
  assert.equal(placeCards(cards, { tasks: [] }), cards)
  assert.equal(placeCards(cards, undefined), cards)
})

test('a stopped run is never an accepted result', () => {
  const stopped = agentState(row('a', 'stopped'))
  const done = agentState(row('a', 'done'))
  assert.equal(stopped.label, 'Stopped')
  assert.notEqual(stopped.tone, 'done')
  assert.equal(done.label, 'Accepted')
  assert.equal(done.tone, 'done')
})

test('a completed reminder stays in Done even while its row catches up', () => {
  const [placed] = placeCards([card('a', { column: 'Done', source: { id: 'a', completed: true } })], { tasks: [row('a', 'active')] })
  assert.equal(placed.column, 'Done')
})

test('Ready for Agent follows the admission queue and names the wait', () => {
  const limits = {
    queue: [
      { task_id: 't_c', reason: null },
      { task_id: 't_a', reason: 'board_capacity' },
      { task_id: 't_b', reason: 'resource_busy' }
    ]
  }
  const placed = placeCards([card('a'), card('b'), card('c'), card('d')], {
    limits,
    tasks: [row('a', 'ready'), row('b', 'ready'), row('c', 'ready'), row('d', 'preparing')]
  })
  const ready = groupCards(null, placed).find(g => g.name === 'Ready for Agent').cards
  assert.deepEqual(ready.map(c => c.id), ['c-c', 'c-a', 'c-b', 'c-d'])
  assert.deepEqual(ready.map(c => c.agent.label), ['Up next', 'Waiting for a free slot', 'Waiting on shared work', 'Linking to Hermes'])
})

test('usage waits sit in In progress, labeled, after active work', () => {
  const placed = placeCards([card('w'), card('a'), card('r')], {
    limits: { queue: [{ task_id: 't_w', reason: 'host_cooldown' }] },
    tasks: [
      row('w', 'ready'),
      row('a', 'active'),
      row('r', 'failed', { recovery: { cause: 'capacity', column: 'In progress', action: 'wait', next_check_at: '2026-11-06T16:05:00+00:00' } })
    ]
  })
  const progress = groupCards(null, placed).find(g => g.name === 'In progress').cards
  assert.deepEqual(progress.map(c => c.id), ['c-a', 'c-w', 'c-r'])
  assert.equal(progress[1].agent.label, 'Waiting for capacity')
  assert.equal(progress[1].agent.waiting, true)
  assert.equal(Date.parse(progress[2].agent.nextCheckAt), Date.parse('2026-11-06T16:05:00+00:00'))
  assert.equal(progress[2].agent.tone, 'waiting')
})

test('recovery column and action win when ticket 17 supplies them', () => {
  // A balance row still carries exit 75's cooldown time; it is never shown as a promise.
  const fund = agentState(row('a', 'failed', { recovery: { cause: 'balance', column: 'Needs you', action: 'fund_account', next_check_at: '2026-11-06T16:05:00+00:00' } }))
  assert.equal(fund.column, 'Needs you')
  assert.equal(fund.action, 'fund_account')
  assert.equal(fund.label, 'Balance empty')
  assert.equal(fund.nextCheckAt, null)
  // A stale recovery never covers a task the live read shows working, nor one the owner let run again.
  const retry = { cause: 'ordinary', column: 'Needs you', action: 'retry' }
  assert.equal(agentState(row('a', 'failed', { recovery: retry }), null, { state: 'active' }).column, 'In progress')
  assert.equal(agentState(row('a', 'failed', { recovery: { ...retry, authorized: true } })).label, 'Failed')
  // The live read's recovery (GET /attention) wins over the last tick's row.
  const live = agentState(row('a', 'ready', { recovery: retry }), null, { state: 'ready', waiting: true, recovery: { cause: 'capacity', column: 'In progress', action: 'wait', next_check_at: '2026-11-06T16:05:00+00:00' } })
  assert.equal(live.column, 'In progress')
  assert.equal(live.label, 'Waiting for capacity')
  // A stale active row never hides a fresh live recovery (Sol S1)...
  const fresh = agentState(row('a', 'active'), null, { state: 'ready', waiting: true, recovery: { cause: 'capacity', column: 'In progress', action: 'wait', next_check_at: '2026-11-06T16:05:00+00:00' } })
  assert.equal(fresh.column, 'In progress')
  assert.equal(fresh.label, 'Waiting for capacity')
  // ...and an explicit live null ends a recovery the tick's row still carries.
  const ended = agentState(row('a', 'failed', { recovery: retry }), null, { state: 'failed', recovery: null })
  assert.equal(ended.label, 'Failed')
  assert.equal(ended.recoveryRow.recovery, null)
  // The dialog reads the same effective row as the card (Sol S2).
  assert.equal(fresh.recoveryRow.recovery.action, 'wait')
  const unknown = agentState(row('a', 'failed', { recovery: { cause: 'ordinary', column: 'Needs you', action: 'reconcile' } }))
  assert.equal(unknown.action, 'reconcile')
})

test('paused work names what changed; Resume waits for reconciliation and a verified stop', () => {
  const guard = extra => ({ status: 'paused', reason: 'instructions_changed', instruction_version: 2, reconciliation: 'resolved', worker_stop_verified: true, ...extra })
  const ready = agentState(row('a', 'paused', { guard: guard() }))
  assert.equal(ready.label, 'Instructions changed')
  assert.equal(ready.action, 'resume')
  assert.equal(agentState(row('a', 'paused', { guard: guard({ reconciliation: 'required' }) })).action, 'reconcile')
  const unverified = agentState(row('a', 'paused', { guard: guard({ worker_stop_verified: false }) }))
  assert.equal(unverified.action, 'reconcile')
  assert.equal(unverified.stopUnverified, true)
  // An outage pause is a wait for the next full read: no Resume, never the owner-check dead end.
  for (const reconciliation of ['resolved', 'required']) {
    const outage = agentState(row('a', 'paused', { guard: guard({ reason: 'source_unavailable', reconciliation }) }))
    assert.equal(outage.label, 'Waiting for Reminders')
    assert.equal(outage.tone, 'waiting')
    assert.equal(outage.action, 'source_wait')
  }
  assert.equal(agentState(row('a', 'paused', { guard: guard({ reason: 'occurrence_changed' }) })).action, 'held')
})

test('a held identity names what changed and never offers Resume (ticket 25)', () => {
  const held = reason => agentState(row('a', 'paused', { guard: { status: 'paused', reason, reconciliation: 'resolved', worker_stop_verified: true } }))
  for (const [reason, label] of [
    ['identity_replaced', 'Reminder was replaced'],
    ['identity_changed', 'Reminder was replaced'],
    ['missing_identity', "Can't find the reminder"],
    ['multiple_candidates', 'Several reminders match'],
    ['conflicting_links', 'Task link copied']
  ]) {
    const state = held(reason)
    assert.equal(state.column, 'Needs you')
    assert.equal(state.label, label)
    assert.equal(state.action, 'held')
    assert.equal(agentVerdict({ ...card('a'), column: 'Needs you', owner: 'agent', agent: state }, 'Ready for Agent', { pickup: true }).refused, 'attention')
  }
})

test('a reminder carrying another reminder\'s task link is marked as a copy, never placed as that task', () => {
  const link = 'https://mac.example/reminders?owner=o1&link=l1&profile=default'
  const original = card('a', { source: { id: 'a', title: 'Original', notes: `Open in Hermes: ${link}` } })
  const copy = card('b', { source: { id: 'b', title: 'Copy', notes: `Notes\nOpen in Hermes: ${link}` } })
  const task = row('a', 'question', { destination: { owner_id: 'o1', link_id: 'l1', url: link } })
  const [placedOriginal, placedCopy] = placeCards([original, copy], { tasks: [task] })
  assert.equal(placedOriginal.agent.status, 'question')
  assert.equal(placedCopy.agent, undefined)
  assert.equal(placedCopy.owner, copy.owner)
  assert.equal(placedCopy.linkCopy.label, 'Copied task link')
  assert.equal(placedCopy.linkCopy.taskId, task.task_id)
  // No rows yet, or a link no task has: an ordinary card.
  assert.equal(placeCards([copy], { tasks: [] })[0].linkCopy, undefined)
})

test('a delegated reminder that gains another task\'s link keeps its own task and never shows the other', () => {
  const linkA = 'https://mac.example/reminders?owner=o1&link=lA&profile=default'
  const linkB = 'https://mac.example/reminders?owner=o1&link=lB&profile=default'
  const a = row('a', 'question', { destination: { owner_id: 'o1', link_id: 'lA', url: linkA } })
  const b = row('b', 'paused', { guard: { status: 'paused', reason: 'conflicting_links' }, destination: { owner_id: 'o1', link_id: 'lB', url: linkB } })
  // A's link pasted at the end of B's notes in Reminders: the dialog would follow it (taskLinkOf).
  const cardB = card('b', { source: { id: 'b', title: 'B', notes: `Open in Hermes: ${linkB}\nOpen in Hermes: ${linkA}` } })
  const cardA = card('a', { source: { id: 'a', title: 'A', notes: `Open in Hermes: ${linkA}` } })
  const [placedA, placedB] = placeCards([cardA, cardB], { tasks: [a, b] })
  assert.equal(placedA.linkCopy, undefined)
  assert.equal(placedB.agent.row, b)
  assert.equal(placedB.agent.action, 'held')
  assert.equal(placedB.linkCopy?.taskId, a.task_id)
})

test('dragging into Ready for Agent delegates only an eligible one-off with pickup on', () => {
  const todo = card('a')
  assert.deepEqual(agentVerdict(todo, 'Ready for Agent', { pickup: true }), { kind: 'delegation', action: 'ready' })
  assert.equal(agentVerdict(todo, 'Ready for Agent', { pickup: false }).reason, AGENT_REFUSALS.pickup_off)
  assert.equal(agentVerdict(todo, 'Ready for Agent', {}).refused, 'pickup_unknown')
  assert.equal(agentVerdict({ ...todo, recurring: true }, 'Ready for Agent', { pickup: true }).refused, 'recurring')
  assert.equal(agentVerdict(todo, 'Ready for Agent', { pickup: true, linked: true }).refused, 'linked')
  assert.equal(agentVerdict(card('d', { column: 'Done' }), 'Ready for Agent', { pickup: true }).refused, 'finished')
  // An [Agent]-labeled reminder without a task can be delegated too.
  assert.equal(agentVerdict({ ...todo, owner: 'agent' }, 'Ready for Agent', { pickup: true }).action, 'ready')
  // Other human moves are ticket 10's rules.
  assert.equal(agentVerdict(todo, 'In progress', { pickup: true }), undefined)
})

test('a result dragged to Done is an accept; every other agent move snaps back with a reason', () => {
  const placed = status => placeCards([card('a')], { tasks: [row('a', status)] })[0]
  assert.deepEqual(agentVerdict(placed('result'), 'Done'), { kind: 'delegation', action: 'accept' })
  assert.equal(agentVerdict(placed('result'), 'To do').refused, 'review')
  assert.equal(agentVerdict(placed('question'), 'Done').refused, 'question')
  assert.equal(agentVerdict(placed('active'), 'Done').refused, 'working')
  assert.equal(agentVerdict(placed('ready'), 'To do').refused, 'queued')
  const accepted = placeCards([card('a', { column: 'Done', source: { id: 'a', title: 'Reminder a', completed: true, rules: [] } })], { tasks: [row('a', 'done')] })[0]
  assert.equal(agentVerdict(accepted, 'To do').refused, 'finished')
  assert.equal(agentVerdict(placed('failed'), 'Done').refused, 'attention')
  assert.equal(agentVerdict(placed('result'), 'Needs you'), undefined)
  for (const key of Object.keys(AGENT_REFUSALS)) assert.ok(AGENT_REFUSALS[key].length < 48, key)
  assert.ok(Object.keys(STATUS).includes('preparation_attention'))
})

test('work admission parked in the queue is queued, not paused; a source pause still is', () => {
  const limits = { queue: [{ task_id: 't_q', reason: 'board_capacity' }] }
  const parked = agentState(row('q', 'paused', { guard: { status: 'active', worker_stop_verified: true } }), limits)
  assert.equal(parked.column, 'Ready for Agent')
  assert.equal(parked.label, 'Waiting for a free slot')
  assert.equal(parked.status, 'ready')
  const vetoed = agentState(row('q', 'paused', { guard: { status: 'paused', reason: 'instructions_changed', reconciliation: 'resolved', worker_stop_verified: true } }), limits)
  assert.equal(vetoed.column, 'Needs you')
  assert.equal(vetoed.label, 'Instructions changed')
  // Paused and not queued: Needs you.
  assert.equal(agentState(row('p', 'paused', { guard: { status: 'active' } }), limits).column, 'Needs you')
})

test('a question that just arrived is in Needs you at once: the header count equals the column', () => {
  // The owner tick last saw the task working; Hermes has since asked a question.
  const delegation = { limits: { queue: [] }, tasks: [row('q', 'active'), row('w', 'active'), row('d', 'done')] }
  const attention = {
    needs_you_count: 1,
    tasks: [
      { task_id: 't_q', state: 'question', required_action: 'reply' },
      { task_id: 't_w', state: 'active', required_action: null },
      { task_id: 't_d', state: 'active', required_action: null }
    ]
  }
  const placed = placeCards([card('q'), card('w'), card('d', { column: 'Done', source: { id: 'd', completed: true } })], delegation, attention.tasks)
  const needsYou = groupCards(null, placed).find(g => g.name === 'Needs you').cards
  assert.equal(needsYou.length, attention.needs_you_count)
  assert.equal(needsYou[0].agent.label, 'Answer Hermes')
  assert.equal(placed.find(c => c.id === 'c-w').column, 'In progress')
  // A finished row is never revived by a live read.
  assert.equal(placed.find(c => c.id === 'c-d').agent.label, 'Accepted')
  // A result too, and its drag to Done accepts.
  const [result] = placeCards([card('r')], { tasks: [row('r', 'active')] }, [{ task_id: 't_r', state: 'result', required_action: 'review' }])
  assert.equal(result.column, 'Needs you')
  assert.deepEqual(agentVerdict(result, 'Done'), { kind: 'delegation', action: 'accept' })
})

test('a live question after a capacity retry is not hidden by the earlier attempt’s recovery', () => {
  const wait = { cause: 'capacity', column: 'In progress', action: 'wait', next_check_at: '2026-11-06T16:05:00+00:00' }
  const [asked] = placeCards([card('a')], { tasks: [row('a', 'failed', { recovery: wait })] }, [{ task_id: 't_a', state: 'question', required_action: 'reply' }])
  assert.equal(asked.column, 'Needs you')
  assert.equal(asked.agent.label, 'Answer Hermes')
  // While the retry still waits, the wait shows.
  const [waiting] = placeCards([card('a')], { tasks: [row('a', 'failed', { recovery: wait })] }, [{ task_id: 't_a', state: 'failed', required_action: 'retry' }])
  assert.equal(waiting.column, 'In progress')
  assert.equal(waiting.agent.label, 'Waiting for capacity')
})


test('a stopped task goes back to you in To do, labeled Stopped, never into Done', () => {
  const [stopped] = placeCards([card('s')], { tasks: [row('s', 'stopped', { stopped_at: '2026-11-07T11:00:00+00:00' })] })
  assert.equal(stopped.column, 'To do')
  assert.equal(stopped.owner, 'human')
  assert.equal(stopped.agent.label, 'Stopped')
  assert.equal(stopped.agent.tone, 'muted')
  // A reminder checked off after a stop is Done like any completed reminder.
  const [checked] = placeCards([card('c', { source: { id: 'c', completed: true } })], { tasks: [row('c', 'stopped')] })
  assert.equal(checked.column, 'Done')
  // Human moves apply again, and Ready delegates it afresh (its task link doesn't block that).
  assert.equal(agentVerdict(stopped, 'In progress', { pickup: true }), undefined)
  assert.equal(agentVerdict(stopped, 'Done', { pickup: true }), undefined)
  assert.deepEqual(agentVerdict(stopped, 'Ready for Agent', { pickup: true, linked: true }), { kind: 'delegation', action: 'ready' })
  assert.equal(agentVerdict(stopped, 'Ready for Agent', { pickup: false }).refused, 'pickup_off')
})

test('the View’s default order keeps the admission queue and active work first', () => {
  const placed = placeCards([card('a'), card('b'), card('w'), card('x')], {
    limits: { queue: [{ task_id: 't_b', reason: null }, { task_id: 't_a', reason: 'board_capacity' }] },
    tasks: [row('a', 'ready'), row('b', 'ready'), row('w', 'failed', { recovery: { column: 'In progress', action: 'wait' } }), row('x', 'active')]
  })
  const byId = id => placed.find(c => c.id === `c-${id}`)
  // The server ordered by reminder fields: a before b, the wait before the active one.
  const arranged = { groups: [{ name: 'Ready for Agent', cards: [byId('a'), byId('b')] }, { name: 'In progress', cards: [byId('w'), byId('x')] }], shown: 4 }
  const kept = keepAgentOrder(arranged)
  assert.deepEqual(kept.groups[0].cards.map(c => c.id), ['c-b', 'c-a'])
  assert.deepEqual(kept.groups[1].cards.map(c => c.id), ['c-x', 'c-w'])
  assert.equal(keepAgentOrder(null), null)
})

test('delegated again after a Stop, the card follows the new task, not the stopped row', () => {
  const stoppedRow = row('a', 'stopped', { key: 'k-old', task_id: 't_old', storage_key: 'k-old' })
  const fresh = row('a', 'active', { key: 'k-new', task_id: 't_new' })
  for (const tasks of [[stoppedRow, fresh], [fresh, stoppedRow]]) {
    const [placed] = placeCards([card('a')], { tasks })
    assert.equal(placed.column, 'In progress')
    assert.equal(placed.agent.row.task_id, 't_new')
  }
})

test('a stopped task Hermes had started asks before a drag sends it back; one stopped while queued goes straight back', () => {
  const ran = row('r', 'stopped', { work_before_stop: { runs: [{ id: 9, ended_at: 20 }] } })
  const queued = row('q', 'stopped', { work_before_stop: { runs: [] } })
  const [started, waited] = placeCards([card('r'), card('q')], { tasks: [ran, queued] })
  assert.deepEqual(agentVerdict(started, 'Ready for Agent', { pickup: true }), { kind: 'delegation', action: 'confirm' })
  assert.deepEqual(agentVerdict(waited, 'Ready for Agent', { pickup: true }), { kind: 'delegation', action: 'ready' })
  // Once that run is confirmed, the drag sends it.
  const confirmed = { ...started, agent: { ...started.agent, row: { ...ran, rerun_reconciliation: { run_id: '9' } } } }
  assert.deepEqual(agentVerdict(confirmed, 'Ready for Agent', { pickup: true }), { kind: 'delegation', action: 'ready' })
})

test("a stopped occurrence Hermes had started still opens ticket 21's choice on a drag, not the one-off ask", () => {
  const row = { status: 'stopped', scope: 'occurrence', work_before_stop: { runs: [{ id: 3, ended_at: 30 }] } }
  const card = { column: 'To do', recurring: true, source: { id: 'r9', rules: [{ frequency: 'daily' }] }, agent: { status: 'stopped', row } }
  assert.deepEqual(agentVerdict(card, 'Ready for Agent', { pickup: true, choose: true }), { kind: 'choose', action: 'choose' })
  assert.equal(agentVerdict({ ...card, recurring: false, source: { id: 'r9', rules: [] } }, 'Ready for Agent', { pickup: true, choose: true }).action, 'confirm')
})

test('a stopped reminder you started stays in In progress, and its dialog still offers Run again', () => {
  const [todo] = placeCards([card('s')], { tasks: [row('s', 'stopped')], limits: { queue: [] } })
  assert.equal(todo.column, 'To do')
  const stoppedAt = '2026-11-12T10:00:00+00:00'
  const after = Date.parse(stoppedAt) / 1000 + 60
  // Started before Hermes had it: after Stop it goes back to To do, labelled Stopped.
  const [earlier] = placeCards([card('s', { column: 'In progress', progress_at: after - 3600 })], { tasks: [row('s', 'stopped', { stopped_at: stoppedAt })], limits: { queue: [] } })
  assert.equal(earlier.column, 'To do')
  const [unknown] = placeCards([card('s', { column: 'In progress' })], { tasks: [row('s', 'stopped', { stopped_at: stoppedAt })], limits: { queue: [] } })
  assert.equal(unknown.column, 'To do')
  const [started] = placeCards([card('s', { column: 'In progress', progress_at: after })], { tasks: [row('s', 'stopped', { stopped_at: stoppedAt })], limits: { queue: [] } })
  assert.equal(started.column, 'In progress')
  // A stop the board only observed carries stopped_seen_at instead.
  const [seen] = placeCards([card('s', { column: 'In progress', progress_at: after })], { tasks: [row('s', 'stopped', { stopped_seen_at: stoppedAt })], limits: { queue: [] } })
  assert.equal(seen.column, 'In progress')
  // A row stopped before stop times were recorded: the board's own In progress stands.
  const [legacy] = placeCards([card('s', { column: 'In progress' })], { tasks: [row('s', 'stopped')], limits: { queue: [] } })
  assert.equal(legacy.column, 'In progress')
  assert.equal(started.owner, 'human')
  // The agent state keeps To do, so nothing treats the stopped task as running.
  assert.equal(started.agent.column, 'To do')
})

test('an accepted task whose reminder was unchecked in Reminders is yours again', () => {
  const at = '2026-11-12T10:00:00Z'
  const later = '2026-11-12T11:00:00Z'
  const open = modified => card('d', { column: 'To do', source: { id: 'd', title: 'Reminder d', completed: false, rules: [], modified } })
  const done = row('d', 'done', { source: { id: 'd', modified: at } })
  // Right after Accept the board can still hold the pre-accept reminder: that is not a reopen.
  const [lagging] = placeCards([open(at)], { tasks: [done], limits: { queue: [] } })
  assert.equal(lagging.column, 'Done')
  assert.equal(lagging.owner, 'agent')
  const [card0] = placeCards([open(later)], { tasks: [done], limits: { queue: [] } })
  assert.equal(card0.column, 'To do')
  assert.equal(card0.owner, 'human')
  assert.equal(card0.agent, undefined)
  // Not handed to Hermes again from here: the backend would only return the old result.
  assert.equal(agentVerdict(card0, 'Ready for Agent', { pickup: true }).refused, 'finished_before')
  assert.equal(agentVerdict(card0, 'In progress', { pickup: true }), undefined)
  // Edited after delegating (Hermes reread it then): the moment after Accept is still not a reopen.
  const [edited] = placeCards([open(later)], { tasks: [{ ...done, guard: { status: 'active', source: { modified: later } } }], limits: { queue: [] } })
  assert.equal(edited.column, 'Done')
  // Its title still carries an agent label: yours all the same, and a move says to remove the label.
  const [labelled] = placeCards([{ ...open(later), owner: 'agent', column: 'Ready for Agent', capabilities: { progress: false, complete: false } }], { tasks: [done], limits: { queue: [] } })
  assert.equal(labelled.owner, 'human')
  assert.equal(labelled.column, 'To do')
  assert.equal(moveVerdict(labelled, 'In progress', { pickup: true }).refused, 'labelled')
  // Still checked off: it stays in Done as accepted work.
  const [kept] = placeCards([card('d', { column: 'Done', source: { id: 'd', title: 'Reminder d', completed: true, rules: [] } })], { tasks: [row('d', 'done')], limits: { queue: [] } })
  assert.equal(kept.column, 'Done')
  assert.equal(kept.owner, 'agent')
})

test('a reminder another Mac’s Hermes has is its card: In progress, read-only, named', () => {
  const theirs = card('a', { owner: 'agent', column: 'In progress', imported_ready: false, elsewhere: { mac: 'Studio', url: null }, source: { id: 'a', title: '[Agent · Ready] Book flights', completed: false, rules: [], calendarId: 'list' } })
  const mine = card('b')
  // No delegation read yet, or no tasks at all: it is still placed.
  for (const delegation of [null, { tasks: [] }, { tasks: [row('b', 'active')] }]) {
    const placed = placeCards([theirs, mine], delegation)
    const shown = placed.find(c => c.id === 'c-a')
    assert.deepEqual([shown.owner, shown.column, shown.agent.status, shown.agent.label, shown.agent.action], ['agent', 'In progress', 'elsewhere', 'On Studio', null])
    assert.equal(shown.agent.row, null)
  }
  // Work this Mac ran before it was taken over does not bring its Stopped card back.
  const taken = placeCards([theirs], { tasks: [row('a', 'stopped', { released: { reason: 'taken_over', mac: 'Studio' } })] })[0]
  assert.deepEqual([taken.column, taken.agent.label, taken.agent.prior.status], ['In progress', 'On Studio', 'stopped'])
  // After this Mac's own running work in the lane.
  const lane = placeCards([theirs, mine], { tasks: [row('b', 'active')] })
  assert.deepEqual(groupCards(['In progress'], lane)[0].cards.map(c => c.id), ['c-b', 'c-a'])
  // Once checked off it is simply done.
  const done = placeCards([{ ...theirs, column: 'Done', source: { ...theirs.source, completed: true } }], { tasks: [] })[0]
  assert.equal(done.agent, undefined)
})

test('the other Mac’s work is not counted as Needs you, Ready, or work to stop here', () => {
  const theirs = card('a', { owner: 'agent', column: 'In progress', imported_ready: false, elsewhere: { mac: 'Studio', url: null }, source: { id: 'a', title: '[Agent · Ready] Book flights', completed: false, rules: [], calendarId: 'list' } })
  const ready = card('b', { owner: 'agent', column: 'Ready for Agent', imported_ready: true })
  const placed = placeCards([theirs, ready], { tasks: [] })
  const lanes = groupCards(['To do', 'Ready for Agent', 'In progress', 'Needs you', 'Done'], placed)
  assert.deepEqual(lanes.map(lane => lane.cards.length), [0, 1, 1, 0, 0])
  assert.equal(startableReady(placed), 1)
  assert.deepEqual(listsWithWork(placed), {})
  // Pickup off relabels this Mac's waits, never the other Mac's card.
  assert.equal(holdQueued(placed, QUEUED_PICKUP_OFF).find(c => c.id === 'c-a').agent.label, 'On Studio')
})
