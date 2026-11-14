import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cardShows,
  consumeFeed,
  isOccurrenceTask,
  needsYouCount,
  notificationFor,
  openKind,
  openRequestOf,
  showsTask,
  openTarget,
  SEEN_LIMIT,
  waitingTasks
} from '../src/lib/attention.js'
import { taskLinkOf } from '../src/lib/task-link.js'

const destination = (link, owner = 'own1') => ({ owner_id: owner, link_id: link, url: `https://mac.example/reminders?owner=${owner}&link=${link}` })
const task = (id, required, token, extra = {}) => ({
  task_id: id,
  required_action: required,
  attention: token ? { token, kind: required === 'reply' ? 'question' : 'result', task_id: id, payload: extra.payload ?? {} } : null,
  destination: destination(`l_${id}`),
  history: { task: { title: extra.title ?? `Task ${id}` }, summary: extra.summary ?? null }
})
const event = (id, taskId, kind, token, payload = {}) => ({ id, task_id: taskId, kind, token, payload })
const feed = (events, tasks, cursor = Math.max(0, ...events.map(e => e.id)), count) => ({
  status: 'ok',
  cursor,
  events,
  tasks,
  needs_you_count: count ?? tasks.filter(t => t.required_action).length
})

test('a first read starts at the cursor and notifies nothing, even for waiting questions', () => {
  const read = feed([event(1, 't1', 'question', 'o1:10')], [task('t1', 'reply', 'o1:10')])
  const { state, notify } = consumeFeed(null, read)
  assert.deepEqual(notify, [])
  assert.deepEqual(state, { cursor: 1, seen: ['o1:10'] })
})

test('a new question or result notifies once; the same read again (reconnect, replay) does not', () => {
  const start = { cursor: 1, seen: ['o1:10'] }
  const read = feed(
    [event(2, 't2', 'question', 'o2:20', { reason: 'Blue or green?' }), event(3, 't3', 'result', 'o3:30')],
    [task('t2', 'reply', 'o2:20'), task('t3', 'review', 'o3:30')]
  )
  const first = consumeFeed(start, read)
  assert.deepEqual(first.notify.map(e => e.token), ['o2:20', 'o3:30'])
  assert.equal(first.state.cursor, 3)
  // The client asks with after=cursor; a host that replays anyway (same ids, same tokens) is quiet.
  assert.deepEqual(consumeFeed(first.state, read).notify, [])
  // A second window holding the older state but sharing the saved tokens is quiet too.
  assert.deepEqual(consumeFeed({ cursor: 1, seen: first.state.seen }, read).notify, [])
})

test('an event that is no longer the task’s current attention never notifies', () => {
  const read = feed(
    [event(5, 't1', 'question', 'o1:50'), event(6, 't1', 'result', 'o1:60')],
    // Answered question then a result: only the result is still waiting.
    [task('t1', 'review', 'o1:60')]
  )
  assert.deepEqual(consumeFeed({ cursor: 4, seen: [] }, read).notify.map(e => e.token), ['o1:60'])
  // Already answered and running: nothing is waiting, nothing notifies.
  assert.deepEqual(consumeFeed({ cursor: 4, seen: [] }, feed([event(5, 't1', 'question', 'o1:50')], [task('t1', null, null)])).notify, [])
})

test('only questions and results notify; a reset journal starts over quietly', () => {
  const odd = feed([event(2, 't1', 'progress', 'o1:20')], [{ ...task('t1', 'reply', 'o1:20') }])
  assert.deepEqual(consumeFeed({ cursor: 1, seen: [] }, odd).notify, [])
  const reset = feed([event(1, 't9', 'question', 'o9:1')], [task('t9', 'reply', 'o9:1')], 1)
  const after = consumeFeed({ cursor: 40, seen: ['x'] }, reset)
  assert.deepEqual(after.notify, [])
  assert.deepEqual(after.state, { cursor: 1, seen: ['o9:1'] })
})

test('a failed or setup-required read changes nothing', () => {
  const stored = { cursor: 3, seen: ['a'] }
  assert.equal(consumeFeed(stored, { status: 'setup_required' }).state, stored)
  assert.deepEqual(consumeFeed(stored, null).notify, [])
})

test('remembered tokens are capped, newest kept', () => {
  const events = Array.from({ length: SEEN_LIMIT + 5 }, (_, i) => event(i + 1, 't1', 'question', `o:${i + 1}`))
  const { state } = consumeFeed({ cursor: 0, seen: [] }, feed(events, []))
  assert.equal(state.seen.length, SEEN_LIMIT)
  assert.equal(state.seen.at(-1), `o:${SEEN_LIMIT + 5}`)
})

test('waiting tasks: every required action, requests oldest first, matched to a card by reminder or link', () => {
  const read = feed([], [task('t1', 'review', 'o1:90'), task('t2', 'retry', null), task('t3', 'reply', 'o3:40', { title: 'Pick a color' })], 0, 3)
  const waiting = waitingTasks(read)
  assert.deepEqual(waiting.map(w => [w.taskId, w.kind, w.short]), [['t3', 'question', 'Answer Hermes'], ['t1', 'result', 'Review result'], ['t2', 'failed', 'Failed']])
  assert.equal(waiting[0].title, 'Pick a color')
  assert.equal(needsYouCount(read), 3)
  assert.equal(cardShows(read.tasks[0], { id: 'r_x' }, { owner: 'own1', link: 'l_t1' }), true)
  assert.equal(cardShows(waiting[1], { id: 'r_x' }, { owner: 'own1', link: 'l_t1' }), true)
  // Nothing waiting: no entries.
  assert.deepEqual(waitingTasks(feed([], [task('t9', null, null)])), [])
  assert.equal(cardShows(read.tasks[0], { id: 'r_x' }, { owner: 'other', link: 'l_t1' }), false)
  assert.equal(cardShows(read.tasks[0], null, null), false)
  // Before the board rereads the notes the link was written to, the reminder id still matches.
  const guarded = feed([], [{ ...task('t5', 'reply', 'o5:5'), guard: { status: 'active', source_id: 'r_5' } }])
  assert.equal(cardShows(guarded.tasks[0], { id: 'r_5' }, null), true)
  assert.equal(cardShows(guarded.tasks[0], { id: 'r_6' }, null), false)
  assert.equal(needsYouCount({ status: 'setup_required' }), 0)
})

test('one event is named; several become one notification that opens the oldest', () => {
  const read = feed([], [task('t1', 'reply', 'o1:1', { title: 'Choose a color' }), task('t2', 'review', 'o2:2', { title: 'Write the flyer' })])
  const one = notificationFor([event(1, 't1', 'question', 'o1:1', { reason: 'Blue or green?' })], read)
  assert.deepEqual(one, { title: 'Hermes has a question · Choose a color', body: 'Blue or green?', taskId: 't1', occurrenceId: null, count: 1 })
  const result = notificationFor([event(2, 't2', 'result', 'o2:2', { summary: 'Made it blue.' })], read)
  assert.equal(result.title, 'Result ready · Write the flyer')
  assert.equal(result.body, 'Made it blue.')
  const both = notificationFor([event(1, 't1', 'question', 'o1:1'), event(2, 't2', 'result', 'o2:2')], read)
  assert.deepEqual(both, { title: '2 tasks need you', body: 'Choose a color, Write the flyer', taskId: 't1', occurrenceId: null, count: 2 })
  assert.equal(notificationFor([], read), null)
})

test('the open-task request in a notification\'s activate path', () => {
  assert.deepEqual(openRequestOf('#/reminders-kanban?task=t_12ab&n=k1'), { taskId: 't_12ab', occurrenceId: null, nonce: 'hash:k1' })
  assert.equal(openRequestOf('#/reminders-kanban'), null)
  assert.equal(openRequestOf('#/reminders-kanban?task=../x'), null)
})

// Ticket 35: repeating reminders' occurrences share the feed, and open at their exact occurrence.
const occTask = (id, key, required, token, link = 'l_series') => ({
  ...task(id, required, token),
  occurrence_id: key,
  guard: { status: 'active' },
  destination: destination(link)
})

test('an occurrence question carries its occurrence to the notification, the menu and the activate path', () => {
  const read = feed([{ ...event(7, 't7', 'question', 'K7:70', { reason: 'Blue or green?' }), occurrence_id: 'K7' }], [occTask('t7', 'K7', 'reply', 'K7:70')])
  const note = notificationFor(read.events, read)
  assert.equal(note.taskId, 't7')
  assert.equal(note.occurrenceId, 'K7')
  assert.equal(note.body, 'Blue or green?')
  assert.equal(waitingTasks(read)[0].occurrenceId, 'K7')
  assert.deepEqual(openRequestOf('#/reminders-kanban?task=t7&occurrence=K7-uuid&n=z'), { taskId: 't7', occurrenceId: 'K7-uuid', nonce: 'hash:z' })
  assert.equal(openRequestOf('#/reminders-kanban?task=t7&occurrence=../x').occurrenceId, null)
  assert.equal(openRequestOf('#/reminders-kanban?task=t7').occurrenceId, null)
})

test('an occurrence opens the card showing that exact occurrence, never another card on the same link', () => {
  const dest = card => (card.link ? { owner: 'own1', link: card.link } : null)
  const done = { id: 'copy', link: 'l_series', source: { id: 'copy' }, occurrence: { role: 'history', key: 'K1' } }
  const current = { id: 'rem', link: 'l_series', source: { id: 'rem' }, occurrence: { role: 'delegated', key: 'K2' } }
  const cards = [done, current]
  const occ = { status: 'ok', tasks: [{ key: 'K1', task_id: 't1' }, { key: 'K2', task_id: 't2' }, { key: 'K9', task_id: 't9' }] }
  assert.deepEqual(openTarget(occTask('t2', 'K2', 'reply', 'K2:5'), 'K2', cards, dest, occ), { card: current, occurrence: 'K2' })
  // The board doesn't show that occurrence (yet): the task's own dialog at that occurrence.
  assert.deepEqual(openTarget(occTask('t9', 'K9', 'reply', 'K9:1'), 'K9', cards, dest, occ), { card: null, occurrence: 'K9' })
  // A one-off task still matches its own card by reminder id or link, never a repeating card.
  const oneOff = { ...task('t3', 'reply', 'x:1'), guard: { source_id: 'plain' }, occurrence_id: 'R3' }
  const plain = { id: 'plain', source: { id: 'plain' } }
  assert.deepEqual(openTarget(oneOff, 'R3', [...cards, plain], dest, occ), { card: plain, occurrence: 'R3' })
})

test('a notification for the current occurrence never opens an earlier one when the occurrences read failed or is stale', () => {
  const dest = card => (card.link ? { owner: 'own1', link: card.link } : null)
  const question = occTask('t_cur', 'K_current', 'reply', 'K_current:7')
  // Read failed: no card carries its occurrence, and every card of the reminder shares the link.
  const failedCards = [
    { id: 'copy', link: 'l_series', source: { id: 'copy' } },
    { id: 'rem', link: 'l_series', source: { id: 'rem' } }
  ]
  assert.deepEqual(openTarget(question, 'K_current', failedCards, dest, undefined), { card: null, occurrence: 'K_current' })
  // Stale read: it knows only the earlier occurrence, whose Done copy is on the board.
  const stale = { status: 'ok', tasks: [{ key: 'K_old', task_id: 't_old' }] }
  const staleCards = [
    { id: 'copy', link: 'l_series', source: { id: 'copy' }, occurrence: { role: 'history', key: 'K_old' } },
    { id: 'rem', link: 'l_series', source: { id: 'rem' }, occurrence: { role: 'successor', key: 'K_old' } }
  ]
  assert.deepEqual(openTarget(question, 'K_current', staleCards, dest, stale), { card: null, occurrence: 'K_current' })
  // The activate path after a reload carries no occurrence: the event's own key is used.
  assert.deepEqual(openTarget(question, null, staleCards, dest, stale), { card: null, occurrence: 'K_current' })
})

test('a repeating card shows only its own occurrence’s task; one-off cards match as before', () => {
  const tasks = [occTask('t_old', 'K1', null, null), occTask('t_new', 'K2', 'reply', 'K2:5')]
  const dest = { owner: 'own1', link: 'l_series' }
  const shown = card => tasks.filter(task => showsTask({ card, dest }, task)).map(task => task.task_id)
  assert.deepEqual(shown({ source: { id: 'rem' }, occurrence: { key: 'K2' } }), ['t_new'])
  assert.deepEqual(shown({ source: { id: 'rem' }, occurrence: { key: 'K3' } }), [])
  // A one-off card shows every task of its reminder (after Run again: the stopped one and the new one).
  assert.deepEqual(shown({ source: { id: 'rem' } }), ['t_old', 't_new'])
})

test('a task is an occurrence only when GET /occurrences has its key and task', () => {
  const occ = { status: 'ok', tasks: [{ key: 'K2', task_id: 't2' }] }
  assert.equal(isOccurrenceTask(occ, 't2', 'K2'), true)
  assert.equal(isOccurrenceTask(occ, 't2', 'one-off-row'), false)
  assert.equal(isOccurrenceTask(occ, 't3', 'K2'), false)
  assert.equal(isOccurrenceTask(undefined, 't2', 'K2'), false)
  assert.equal(isOccurrenceTask(occ, 't2', null), false)
})

test('recovering tasks are listed by the names their card and pill use, funding and sign-in included', () => {
  const recovering = (id, required, recovery) => ({ ...task(id, required, null), state: 'failed', guard: { status: 'active' }, recovery })
  const read = feed([], [
    recovering('t1', 'fund_account', { cause: 'balance', action: 'fund_account', column: 'Needs you' }),
    recovering('t2', 'repair_access', { cause: 'access', action: 'repair_access', column: 'Needs you' }),
    recovering('t3', 'retry', { cause: 'ordinary', action: 'retry', column: 'Needs you' }),
    recovering('t4', 'reconcile', { cause: 'ordinary', action: 'reconcile', column: 'Needs you' })
  ], 0, 4)
  const waiting = waitingTasks(read)
  assert.deepEqual(waiting.map(w => [w.taskId, w.short]), [['t1', 'Balance empty'], ['t2', 'Sign-in needs repair'], ['t3', 'Needs a retry'], ['t4', 'Needs a check']])
  assert.equal(waiting.every(w => w.label === w.short), true)
})

test('a usage wait needs nothing from you: never in the need-you menu, as /attention leaves it out of the count', () => {
  const wait = { ...task('t5', null, null), state: 'ready', waiting: true, guard: { status: 'active' }, recovery: { cause: 'capacity', action: 'wait', column: 'In progress', next_check_at: '2026-11-06T16:05:00+00:00' } }
  assert.deepEqual(waitingTasks(feed([], [wait], 0, 0)), [])
  // Even a row that still carries the wait without the waiting flag stays out.
  assert.deepEqual(waitingTasks(feed([], [{ ...wait, waiting: false }], 0, 0)), [])
  // Alongside counted tasks the menu lists exactly the counted ones.
  const retry = { ...task('t6', 'retry', null), state: 'failed', guard: { status: 'active' }, recovery: { cause: 'ordinary', action: 'retry', column: 'Needs you' } }
  const read = feed([], [wait, retry], 0, 1)
  assert.equal(waitingTasks(read).length, needsYouCount(read))
})

test('a menu click opens that exact task for every recovery kind: its card, else the task, never nothing', () => {
  const url = link => `https://mac.example/reminders?owner=own1&link=${link}&profile=default`
  const recovering = (id, required, recovery, extra = {}) => ({
    ...task(id, required, null),
    destination: { owner_id: 'own1', link_id: `l_${id}`, url: url(`l_${id}`) },
    state: 'failed',
    guard: { status: 'active', source_id: `r_${id}` },
    recovery,
    ...extra
  })
  const kinds = [
    recovering('t1', 'retry', { cause: 'ordinary', action: 'retry', column: 'Needs you' }),
    recovering('t2', 'fund_account', { cause: 'balance', action: 'fund_account', column: 'Needs you' }, { state: 'ready' }),
    recovering('t3', 'repair_access', { cause: 'access', action: 'repair_access', column: 'Needs you' }),
    recovering('t4', 'reconcile', { cause: 'ordinary', action: 'reconcile', column: 'Needs you' })
  ]
  const cards = kinds.map(k => ({ id: `card-${k.task_id}`, source: { id: k.guard.source_id, notes: `Do it\n\nOpen in Hermes: ${k.destination.url}` } }))
  const read = feed([], kinds, 0, 4)
  const listed = waitingTasks(read)
  assert.equal(listed.length, 4)
  const dest = entry => taskLinkOf(entry.source)
  const open = (item, onBoard) => {
    const { card } = openTarget(item, null, onBoard, dest, undefined)
    return { kind: openKind(item, card, Boolean(card && dest(card))), card: card?.id ?? null }
  }
  for (const entry of listed) {
    assert.deepEqual(open(read.tasks.find(t => t.task_id === entry.taskId), cards), { kind: 'card', card: `card-${entry.taskId}` }, entry.short)
  }
  // No card on the board (filtered or hidden): the task itself through its stable link.
  assert.deepEqual(open(kinds[1], []), { kind: 'task', card: null })
  // A card that hasn't reread its link yet: the task now (and the opener rereads the board).
  assert.deepEqual(open(kinds[2], [{ id: 'card-t3', source: { id: 'r_t3', notes: '' } }]), { kind: 'task', card: 'card-t3' })
  // No destination but the card is on the board (matched by reminder): its card, not nothing.
  assert.deepEqual(open({ ...kinds[3], destination: null }, cards), { kind: 'card', card: 'card-t4' })
  // Neither yet: pending, so the opener rereads and tries again.
  assert.deepEqual(open({ ...kinds[0], destination: null }, []), { kind: 'pending', card: null })
  assert.deepEqual(open(undefined, cards), { kind: 'pending', card: null })
})

test('the Needs you key changes exactly when delegated work enters or leaves Needs you', async () => {
  const { needsYouKey } = await import('../src/lib/attention.js')
  const card = (id, column, agent = true) => ({ id, column, agent: agent ? { status: 'x' } : null })
  assert.equal(needsYouKey(undefined), '')
  assert.equal(needsYouKey([card('a', 'In progress'), card('b', 'Needs you', false)]), '')
  // Order on the board doesn't matter; membership does.
  assert.equal(needsYouKey([card('b', 'Needs you'), card('a', 'Needs you')]), needsYouKey([card('a', 'Needs you'), card('b', 'Needs you')]))
  assert.notEqual(needsYouKey([card('a', 'Needs you')]), needsYouKey([card('a', 'In progress')]))
})

test('a result for the task on screen never pops a toast, even right after Run again', async () => {
  const { showsTask } = await import('../src/lib/attention.js')
  const card = { id: 'c', source: { id: 'rem-1', notes: '' } }
  const dest = { owner: 'o', link: 'L1' }
  const visible = { card, dest }
  // Run again keeps the stopped task in the feed beside the new one, under the same reminder and link.
  const stopped = { task_id: 't_old', guard: { source_id: 'rem-1' }, destination: { link_id: 'L1', owner_id: 'o' } }
  const rerun = { task_id: 't_new', guard: { source_id: 'rem-1' }, destination: { link_id: 'L1', owner_id: 'o' } }
  assert.equal(showsTask(visible, rerun), true)
  assert.equal(showsTask(visible, stopped), true)
  // Matched by link alone when the guard hasn't named the reminder yet.
  assert.equal(showsTask(visible, { task_id: 't_new', destination: { link_id: 'L1', owner_id: 'o' } }), true)
  // Another reminder's task still notifies.
  assert.equal(showsTask(visible, { task_id: 't_x', guard: { source_id: 'rem-2' }, destination: { link_id: 'L2', owner_id: 'o' } }), false)
  // A repeating reminder's card shows one occurrence only.
  const occurrenceCard = { card: { id: 'r', source: { id: 'rem-3' }, occurrence: { key: 'occ-2' } }, dest: { owner: 'o', link: 'L3' } }
  assert.equal(showsTask(occurrenceCard, { task_id: 't2', occurrence_id: 'occ-2' }), true)
  assert.equal(showsTask(occurrenceCard, { task_id: 't1', occurrence_id: 'occ-1', destination: { link_id: 'L3', owner_id: 'o' } }), false)
  // A task's own dialog (not on the board) matches by task id; nothing open matches nothing.
  assert.equal(showsTask({ taskId: 't9' }, { task_id: 't9' }), true)
  assert.equal(showsTask(null, rerun), false)
})

test('a toast held while a dialog was open shows afterwards only if its task still needs you', async () => {
  const { stillNeedsYou } = await import('../src/lib/attention.js')
  const feed = { tasks: [{ task_id: 'a', required_action: 'review' }, { task_id: 'b', required_action: null }] }
  assert.equal(stillNeedsYou({ taskId: 'a', count: 1 }, feed), true)
  // Answered or accepted in the meantime (from another device, say): nothing to show.
  assert.equal(stillNeedsYou({ taskId: 'b', count: 1 }, feed), false)
  assert.equal(stillNeedsYou({ taskId: 'gone', count: 1 }, feed), false)
  assert.equal(stillNeedsYou({ taskId: 'a', count: 2 }, feed), true)
  assert.equal(stillNeedsYou(null, feed), false)
})

test('a toast is dropped for the task on screen, held over any other dialog, shown otherwise', async () => {
  const { toastFate } = await import('../src/lib/attention.js')
  const visible = { card: { id: 'c', source: { id: 'rem-1' } }, dest: { owner: 'o', link: 'L1' } }
  const mine = { task_id: 't_new', guard: { source_id: 'rem-1' } }
  const other = { task_id: 't_b', guard: { source_id: 'rem-2' } }
  // Shot 09 of after-80-81: the result toast was up when that task's dialog opened over it.
  assert.equal(toastFate({ taskId: 't_new', count: 1 }, visible, mine, true), 'drop')
  assert.equal(toastFate({ taskId: 't_b', count: 1 }, visible, other, true), 'hold')
  // An editor or any other dialog (no task on screen) holds it too; no dialog shows it.
  assert.equal(toastFate({ taskId: 't_b', count: 1 }, null, other, true), 'hold')
  assert.equal(toastFate({ taskId: 't_b', count: 1 }, null, other, false), 'show')
  // "2 tasks need you" names more than the open one: held, not dropped.
  assert.equal(toastFate({ taskId: 't_new', count: 2 }, visible, mine, true), 'hold')
})

test('several dialogs can report what they show; any match counts', async () => {
  const { showsTask } = await import('../src/lib/attention.js')
  const targets = [{ taskId: 't_changed' }, { card: { id: 'c', source: { id: 'rem-1' } }, dest: null }]
  assert.equal(showsTask(targets, { task_id: 't_changed' }), true)
  assert.equal(showsTask(targets, { task_id: 't_x', guard: { source_id: 'rem-1' } }), true)
  assert.equal(showsTask(targets, { task_id: 't_y', guard: { source_id: 'rem-9' } }), false)
  assert.equal(showsTask([], { task_id: 't_y' }), false)
})

test('a task with no written link ("Only on this Mac") opens from its stored binding', async () => {
  const { cardDest } = await import('../src/lib/task-link.js')
  const local = { task_id: 't9', guard: { source_id: 'r9' }, destination: { owner_id: 'own1', link_id: 'l_t9', url: null } }
  const dest = entry => cardDest(entry, 'default')
  const open = (item, onBoard) => {
    const { card } = openTarget(item, null, onBoard, dest, undefined)
    return { kind: openKind(item, card, Boolean(card && dest(card))), card: card?.id ?? null }
  }
  // Its card carries the row's binding, not a link in the notes: the card's dialog.
  const card = { id: 'card-t9', source: { id: 'r9', notes: 'Do it' }, agent: { row: { task_id: 't9', destination: local.destination } } }
  assert.deepEqual(open(local, [card]), { kind: 'card', card: 'card-t9' })
  // Not on the board: the task's own dialog through the binding, though it has no URL.
  assert.deepEqual(open(local, []), { kind: 'task', card: null })
  // A binding that doesn't name a task is no binding.
  assert.deepEqual(open({ ...local, destination: { url: null } }, []), { kind: 'pending', card: null })
})
