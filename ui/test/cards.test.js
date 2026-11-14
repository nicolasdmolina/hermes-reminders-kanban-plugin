import assert from 'node:assert/strict'
import { test } from 'node:test'

import { setTitleLabels, dueInfo, groupCards, importedReady, priorityLabel, repeatSummary, selectedListNames, splitTitle } from '../src/lib/cards.js'

const COLUMNS = ['To do', 'Ready for Agent', 'In progress', 'Needs you', 'Done']

test('only the two contract labels are split from the title', () => {
  assert.deepEqual(splitTitle('[Agent · Ready] Draft the memo'), { label: '[Agent · Ready]', text: 'Draft the memo' })
  assert.deepEqual(splitTitle('[Agent] Book flights'), { label: '[Agent]', text: 'Book flights' })
  assert.deepEqual(splitTitle('[agent] lower case stays text'), { label: null, text: '[agent] lower case stays text' })
  assert.deepEqual(splitTitle('Buy milk [Agent]'), { label: null, text: 'Buy milk [Agent]' })
  assert.equal(splitTitle('').text, 'Untitled reminder')
  assert.equal(splitTitle('[Agent]').text, '[Agent]')
})

test('every contract column renders even when empty, in contract order', () => {
  const groups = groupCards(COLUMNS, [
    { id: '1', column: 'Done' },
    { id: '2', column: 'To do' },
    { id: '3', column: 'Done' }
  ])
  assert.deepEqual(groups.map(g => g.name), COLUMNS)
  assert.deepEqual(groups.map(g => g.cards.map(c => c.id)), [['2'], [], [], [], ['1', '3']])
})

test('all-day due dates keep their calendar day and become overdue only after it ends', () => {
  const due = { year: 2026, month: 11, day: 5, hour: null }
  assert.equal(dueInfo(due, new Date(2026, 10, 5, 23, 59)).overdue, false)
  assert.equal(dueInfo(due, new Date(2026, 10, 6, 0, 1)).overdue, true)
  assert.equal(dueInfo(due, new Date(2026, 10, 1)).allDay, true)
  assert.equal(dueInfo(null), null)
})

test('a due date within a day of now is named, with its time when it has one', () => {
  const now = new Date(2026, 10, 5, 12, 0)
  const day = (d, hour = null) => ({ year: 2026, month: 11, day: d, hour, minute: hour == null ? null : 30 })
  assert.deepEqual([4, 5, 6, 7].map(d => dueInfo(day(d), now, 'en-US').near), ['Yesterday', 'Today', 'Tomorrow', 'Nov 7'])
  assert.equal(dueInfo(day(5, 16), now, 'en-US').near, 'Today, 4:30 PM')
  assert.equal(dueInfo(day(5), now, 'en-US').label, 'Nov 5')
})

test('timed due dates are read in their own time zone', () => {
  const due = { year: 2030, month: 3, day: 9, hour: 9, minute: 0, timeZone: 'America/New_York' }
  const info = dueInfo(due, new Date(Date.UTC(2026, 0, 1)), 'en-US')
  assert.equal(info.date.toISOString(), '2030-03-09T14:00:00.000Z')
  assert.match(info.label, /Mar 9, 2030/)
})

test('priority follows Apple Reminders values', () => {
  assert.deepEqual([0, 1, 5, 9].map(priorityLabel), [null, 'High', 'Medium', 'Low'])
})

test('repeat rules read as short phrases', () => {
  assert.equal(repeatSummary([]), null)
  assert.equal(repeatSummary([{ frequency: 0, interval: 1 }]), 'Daily')
  assert.equal(repeatSummary([{ frequency: 1, interval: 2, weekdays: [{ day: 2 }, { day: 5 }] }]), 'Every 2 weeks on Mon, Thu')
  assert.equal(repeatSummary([{ frequency: 2, interval: 1, endCount: 3 }]), 'Monthly, 3 times')
  assert.equal(repeatSummary([{ frequency: 3, interval: 1 }]), 'Yearly')
})

test('review counts unfinished imported Ready cards only', () => {
  const cards = [
    { imported_ready: true, column: 'Ready for Agent' },
    { imported_ready: true, column: 'Done' },
    { imported_ready: false, column: 'To do' }
  ]
  assert.equal(importedReady(cards).length, 1)
})

test('list names follow the saved selection, falling back to card data', () => {
  const envelope = {
    setup: { selected_list_ids: ['b', 'a'] },
    lists: [{ id: 'a', title: 'RK Test' }],
    cards: [{ source: { calendarId: 'b', calendarTitle: 'RK Test 2' } }]
  }
  assert.deepEqual(selectedListNames(envelope), ['RK Test 2', 'RK Test'])
})

test('completion days read Today, Yesterday, a weekday, then a date', async () => {
  const { completedLabel } = await import('../src/lib/cards.js')
  const now = new Date(2026, 10, 6, 15, 0)
  assert.equal(completedLabel(new Date(2026, 10, 6, 8, 0).toISOString(), now, 'en-US'), 'Today')
  assert.equal(completedLabel(new Date(2026, 10, 5, 23, 0).toISOString(), now, 'en-US'), 'Yesterday')
  assert.equal(completedLabel(new Date(2026, 10, 3, 9, 0).toISOString(), now, 'en-US'), 'Tue')
  assert.equal(completedLabel(new Date(2026, 9, 20, 9, 0).toISOString(), now, 'en-US'), 'Oct 20')
  assert.equal(completedLabel(new Date(2025, 9, 20, 9, 0).toISOString(), now, 'en-US'), 'Oct 20, 2025')
  assert.equal(completedLabel(null, now), null)
})

test('titles drop the labels this board is set to, and the defaults still', () => {
  setTitleLabels({ agent: 'AI:', ready: 'AI: go' })
  assert.deepEqual(splitTitle('AI: go Draft the notes'), { label: 'AI: go', text: 'Draft the notes' })
  assert.deepEqual(splitTitle('AI: Draft the notes'), { label: 'AI:', text: 'Draft the notes' })
  assert.equal(splitTitle('[Agent] Draft the notes').text, 'Draft the notes')
  setTitleLabels(null)
  assert.equal(splitTitle('AI: Draft the notes').text, 'AI: Draft the notes')
})

test('a timed reminder keeps its own hour on the days the clocks change', () => {
  const at = (month, day, hour) => dueInfo({ year: 2026, month, day, hour, minute: 0, timeZone: 'America/Los_Angeles' }, new Date(2026, 0, 1), 'en-US').date.toISOString()
  // Spring forward (Mar 8, 2026): 9:00 PDT is 16:00 UTC, not 17:00.
  assert.equal(at(3, 8, 9), '2026-03-08T16:00:00.000Z')
  // Fall back (Nov 1, 2026): 5:00 PST is 13:00 UTC, not 12:00.
  assert.equal(at(11, 1, 5), '2026-11-01T13:00:00.000Z')
  // Ordinary days either side.
  assert.equal(at(3, 9, 9), '2026-03-09T16:00:00.000Z')
  assert.equal(at(3, 7, 9), '2026-03-07T17:00:00.000Z')
  // Before the change on the same day.
  assert.equal(at(3, 8, 1), '2026-03-08T09:00:00.000Z')
  assert.equal(at(11, 1, 0), '2026-11-01T07:00:00.000Z')
})
