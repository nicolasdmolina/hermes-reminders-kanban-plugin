import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  applyReveal,
  arrangeBoard,
  DEFAULT_VIEW,
  filteredEmpty,
  isCustomized,
  normalizeLists,
  resetView,
  toggleList,
  viewRequest
} from '../src/lib/views.js'

const COLUMNS = ['To do', 'Ready for Agent', 'In progress', 'Needs you', 'Done']

// The documented example from reminders_kanban/workflow/views.md, queried with owner="human".
const cards = [
  { id: 'essay', owner: 'human', column: 'To do', recurring: false },
  { id: 'lab', owner: 'agent', column: 'To do', recurring: true },
  { id: 'call', owner: 'human', column: 'Needs you', recurring: false },
  { id: 'draft', owner: 'agent', column: 'Needs you', recurring: false }
]
const humanOnly = {
  order: ['essay', 'call'],
  matched_count: 2,
  done: { total: 0, hidden: 0, window: { mode: 'recent', days: 7, since: '2026-10-30T00:00:00+00:00' } },
  attention: {
    needs_you_count: 2,
    hidden: [{ id: 'draft', owner: 'agent', recurring: false, list_id: 'school', action: 'review', requested_at: null, hidden_by: ['owner'] }],
    reveal: { owner: 'all', repeats: 'all', list_ids: null, sort: 'default' }
  },
  queue: ['draft', 'lab']
}
const names = arranged => Object.fromEntries(arranged.groups.map(group => [group.name, group.cards.map(card => card.id)]))

test('the default view asks for all integrated work with each column in its own order', () => {
  assert.deepEqual(viewRequest(cards, DEFAULT_VIEW), {
    cards,
    owner: 'all',
    repeats: 'all',
    list_ids: null,
    sort: 'default',
    done: 'recent'
  })
  assert.equal(isCustomized(DEFAULT_VIEW), false)
})

test('a filtered answer hides cards it removed and keeps the unfiltered Needs you count', () => {
  const arranged = arrangeBoard(COLUMNS, cards, { response: humanOnly, sent: cards.map(c => c.id) })
  assert.deepEqual(names(arranged), { 'To do': ['essay'], 'Ready for Agent': [], 'In progress': [], 'Needs you': ['call'], Done: [] })
  assert.equal(arranged.shown, 2)
  assert.deepEqual(arranged.needsYou, { total: 2, hidden: 1, reveal: humanOnly.attention.reveal })
})

test('cards follow the answer order inside each column, not the input order', () => {
  const response = { ...humanOnly, order: ['lab', 'essay', 'draft', 'call'], attention: { needs_you_count: 2, hidden: [], reveal: null } }
  const arranged = arrangeBoard(COLUMNS, cards, { response, sent: cards.map(c => c.id) })
  assert.deepEqual(names(arranged)['To do'], ['lab', 'essay'])
  assert.deepEqual(names(arranged)['Needs you'], ['draft', 'call'])
  assert.equal(arranged.needsYou.hidden, 0)
})

test('an optimistic move keeps its new column; a card the answer never saw shows last', () => {
  const moved = [{ ...cards[0], column: 'In progress' }, ...cards.slice(1), { id: 'new', owner: 'human', column: 'To do' }]
  const arranged = arrangeBoard(COLUMNS, moved, { response: humanOnly, sent: cards.map(c => c.id) })
  assert.deepEqual(names(arranged)['In progress'], ['essay'])
  assert.deepEqual(names(arranged)['To do'], ['new'])
})

test('Done counts its hidden completions in the total and reports Show all', () => {
  const done = [
    { id: 'fresh', column: 'Done' },
    { id: 'old', column: 'Done' }
  ]
  const recent = { order: ['fresh'], matched_count: 1, done: { total: 2, hidden: 1, window: { mode: 'recent' } }, attention: { hidden: [], reveal: null } }
  const arranged = arrangeBoard(COLUMNS, done, { response: recent, sent: ['fresh', 'old'] })
  assert.deepEqual(names(arranged).Done, ['fresh'])
  assert.deepEqual(arranged.done, { total: 2, hidden: 1, all: false })
  const all = { order: ['fresh', 'old'], matched_count: 2, done: { total: 2, hidden: 0, window: { mode: 'all' } }, attention: { hidden: [], reveal: null } }
  assert.deepEqual(arrangeBoard(COLUMNS, done, { response: all, sent: ['fresh', 'old'] }).done, { total: 2, hidden: 0, all: true })
})

test('reveal widens only what the answer says, and keeps the Done window', () => {
  const view = { owner: 'agent', repeats: 'recurring', listIds: ['school'], sort: 'title', done: 'all' }
  const next = applyReveal(view, { owner: 'all', repeats: 'recurring', list_ids: ['personal', 'school'], sort: 'title' })
  assert.deepEqual(next, { owner: 'all', repeats: 'recurring', listIds: ['personal', 'school'], sort: 'title', done: 'all' })
  assert.equal(applyReveal(view, null), view)
})

test('list filters stay inside the integrated lists; all of them means no filter', () => {
  const integrated = ['a', 'b', 'c']
  assert.equal(normalizeLists(null, integrated), null)
  assert.equal(normalizeLists(['a', 'b', 'c'], integrated), null)
  assert.deepEqual(normalizeLists(['a', 'gone'], integrated), ['a'])
  assert.deepEqual(toggleList(null, 'b', integrated), ['a', 'c'])
  assert.equal(toggleList(['a', 'c'], 'b', integrated), null)
  assert.deepEqual(toggleList(['a'], 'a', integrated), [])
})

test('filtered-empty means filters hid everything, not that Done only has old work', () => {
  const nothing = { order: [], matched_count: 0, done: { total: 0, hidden: 0, window: { mode: 'recent' } }, attention: { hidden: [], reveal: null } }
  const empty = arrangeBoard(COLUMNS, cards, { response: nothing, sent: cards.map(c => c.id) })
  const agentOnly = { ...DEFAULT_VIEW, owner: 'agent' }
  assert.equal(filteredEmpty(agentOnly, empty, cards), true)
  // The untouched view never says "nothing matches", even when only old completions exist.
  assert.equal(filteredEmpty(DEFAULT_VIEW, empty, cards), false)
  const oldOnly = { ...nothing, done: { total: 3, hidden: 3, window: { mode: 'recent' } } }
  assert.equal(filteredEmpty(agentOnly, arrangeBoard(COLUMNS, cards, { response: oldOnly, sent: cards.map(c => c.id) }), cards), false)
  assert.deepEqual(resetView({ ...agentOnly, done: 'all' }), { ...DEFAULT_VIEW, done: 'all' })
})

test('the view request leaves out what the board attached for its own display', () => {
  const sent = viewRequest([{ id: 'c', column: 'Done', owner: 'agent', source: { id: 's' }, agent: { row: {} }, occurrence: { history: [{}, {}] }, linkCopy: {} }], DEFAULT_VIEW).cards
  assert.deepEqual(sent, [{ id: 'c', column: 'Done', owner: 'agent', source: { id: 's' } }])
})

test('a past occurrence Hermes ran counts as repeating for the Repeats filter', () => {
  const [sent] = viewRequest([{ id: 'c', column: 'Done', recurring: false, source: { id: 's' }, occurrence: { role: 'history' } }], DEFAULT_VIEW).cards
  assert.equal(sent.recurring, true)
  const [plain] = viewRequest([{ id: 'p', column: 'Done', recurring: false, source: { id: 't' } }], DEFAULT_VIEW).cards
  assert.equal(plain.recurring, false)
})
