import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createFields,
  describeOutcome,
  draftFromSource,
  dueModeError,
  editFields,
  emptyDraft,
  replaySettlement,
  rebaseDraft,
  sourceChanges,
  validateDraft,
  withDueDate
} from '../src/lib/drafts.js'

const source = {
  id: 'r1',
  calendarId: 'list-a',
  title: 'Buy bread',
  notes: 'Whole grain',
  priority: 5,
  completed: false,
  due: { calendar: 'gregorian', year: 2030, month: 11, day: 2, hour: null, minute: null, timeZone: null }
}

test('drafts read source fields and snap native priorities to the four values', () => {
  assert.deepEqual(draftFromSource(source), {
    title: 'Buy bread',
    notes: 'Whole grain',
    calendarId: 'list-a',
    date: '2030-11-02',
    time: '',
    priority: 5,
    notesAdd: ''
  })
  assert.equal(draftFromSource({ ...source, priority: 3 }).priority, 1)
  assert.equal(draftFromSource({ ...source, priority: 7 }).priority, 9)
  assert.equal(draftFromSource({ ...source, notes: null, due: null }).date, '')
  const timed = draftFromSource({ ...source, due: { year: 2030, month: 1, day: 9, hour: 7, minute: 5, timeZone: 'America/New_York' } })
  assert.equal(timed.time, '07:05')
})

test('create sends required fields, optional ones only when set, and the zone for timed dates', () => {
  const draft = { ...emptyDraft('list-a'), title: '  Call mom  ' }
  assert.deepEqual(createFields(draft, 'America/New_York'), { title: 'Call mom', calendarId: 'list-a' })
  const full = { ...draft, notes: 'Sunday', priority: 1, date: '2030-11-02', time: '09:30' }
  assert.deepEqual(createFields(full, 'America/New_York'), {
    title: 'Call mom',
    calendarId: 'list-a',
    notes: 'Sunday',
    priority: 1,
    due: { calendar: 'gregorian', year: 2030, month: 11, day: 2, hour: 9, minute: 30, timeZone: 'America/New_York' }
  })
  assert.deepEqual(createFields({ ...draft, date: '2030-11-02' }, 'UTC').due, { calendar: 'gregorian', year: 2030, month: 11, day: 2 })
})

test('edit sends only the fields the user changed', () => {
  const base = draftFromSource(source)
  assert.deepEqual(editFields(base, base, 'UTC'), {})
  assert.deepEqual(editFields(base, { ...base, title: 'Buy rye ', priority: 1 }, 'UTC'), { title: 'Buy rye', priority: 1 })
  assert.deepEqual(editFields(base, { ...base, date: '2030-11-03' }, 'UTC'), {
    due: { calendar: 'gregorian', year: 2030, month: 11, day: 3 }
  })
})

test('validation names the field, including agent labels and gated due changes', () => {
  const labels = { agent: '[Agent]', ready: '[Agent · Ready]' }
  assert.equal(validateDraft(emptyDraft('a')).title, 'Add a title')
  assert.match(validateDraft({ ...emptyDraft('a'), title: '[Agent] Draft' }, { labels }).title, /agent tasks/)
  assert.equal(validateDraft({ ...emptyDraft(''), title: 'x' }).calendarId, 'Choose a list')
  assert.equal(validateDraft({ ...emptyDraft('a'), title: 'x', time: '09:00' }).due, 'Pick a date for this time')
  const base = draftFromSource(source)
  // Without advertised due modes the old gate holds: same date type, never cleared.
  assert.match(validateDraft({ ...base, date: '' }, { mode: 'edit', base }).due, /Clear this date in Apple Reminders/)
  assert.match(validateDraft({ ...base, time: '09:00' }, { mode: 'edit', base }).due, /Add a time in Apple Reminders/)
  const open = { all_day: true, timed: true, clear: true, time_zone: null }
  assert.deepEqual(validateDraft({ ...base, date: '' }, { mode: 'edit', base, dueModes: open }), {})
  assert.deepEqual(validateDraft({ ...base, time: '09:00' }, { mode: 'edit', base, dueModes: open }), {})
  assert.deepEqual(validateDraft(base, { mode: 'edit', base, labels }), {})
  // A list move is its own edit.
  assert.deepEqual(validateDraft({ ...base, calendarId: 'list-b' }, { mode: 'edit', base }), {})
  assert.match(validateDraft({ ...base, calendarId: 'list-b', priority: 1 }, { mode: 'edit', base }).calendarId, /other changes first/)
})

test('a source update keeps touched fields and reports real conflicts', () => {
  const base = draftFromSource(source)
  const draft = { ...base, title: 'Buy rye' }
  const current = { ...source, title: 'Buy sourdough', notes: 'From the corner shop' }
  const rebased = rebaseDraft(base, draft, current)
  assert.equal(rebased.draft.title, 'Buy rye')
  assert.equal(rebased.draft.notes, 'From the corner shop')
  assert.deepEqual(rebased.conflicts, ['title'])
  assert.deepEqual(rebased.base, draftFromSource(current))
  // The same edit on both sides is not a conflict.
  assert.deepEqual(rebaseDraft(base, draft, { ...source, title: 'Buy rye' }).conflicts, [])
  assert.deepEqual(sourceChanges(source, current), ['title', 'notes'])
  assert.deepEqual(sourceChanges(source, { ...source, completed: true }), ['completed'])
  assert.deepEqual(sourceChanges(source, null), ['gone'])
})

test('a replay settles the bar, the card and the originating draft together', () => {
  const unsure = { body: { operation_id: 'op-1' }, cardId: 'c1', draftKey: 'k|create', title: 'x' }
  const ok = replaySettlement(unsure, 'ok', describeOutcome({ status: 'ok' }))
  assert.deepEqual(ok, { unsure: null, clearDraft: true, draft: null, notice: null })
  const still = replaySettlement(unsure, 'uncertain', describeOutcome({ status: 'uncertain' }))
  assert.equal(still.unsure.body.operation_id, 'op-1')
  assert.equal(still.clearDraft, false)
  const failed = replaySettlement(unsure, 'conflict', describeOutcome({ status: 'conflict' }))
  assert.equal(failed.unsure, null)
  assert.deepEqual(failed.draft.operation, null)
  assert.equal(failed.notice.short, 'Changed in Apple Reminders')
  // A card move has no draft to settle.
  assert.equal(replaySettlement({ body: {}, cardId: 'c1' }, 'ok', describeOutcome({ status: 'ok' })).clearDraft, false)
})

test('every contract outcome has copy, and only unknown ones replay', () => {
  for (const status of ['ok', 'conflict', 'move_refused', 'reopen_recurring_unsupported', 'reopen_origin_unverified', 'agent_workflow_required', 'gated_field', 'uncertain', 'access_denied', 'not_found', 'bad_request', 'persistence_failed', 'unavailable_host']) {
    const shown = describeOutcome({ status })
    assert.ok(shown.short && shown.message, status)
  }
  assert.equal(describeOutcome({ status: 'uncertain' }).replay, true)
  assert.equal(describeOutcome({ status: 'conflict' }).replay, false)
  assert.equal(describeOutcome({ status: 'access_denied' }).action, 'privacy')
  assert.equal(describeOutcome({ status: 'gated_field', reason: 'opaque_preservation_unproved' }).action, 'reminders')
  assert.match(describeOutcome({ status: 'gated_field', reason: 'notes_append_only' }).message, /added to/)
  assert.equal(describeOutcome({ status: 'bad_request', reason: 'human_title_required' }).field, 'title')
  assert.equal(describeOutcome({ status: 'move_refused', reason: 'move_in_reminders' }).message, "Couldn't move this reminder; move it in Reminders.")
  assert.equal(describeOutcome({ status: 'move_refused' }).replay, false)
  assert.equal(describeOutcome({ status: 'reopen_origin_unverified' }).short, 'Reopen it in Apple Reminders')
  assert.equal(describeOutcome({ status: 'reopen_recurring_unsupported' }).short, 'Reopen it in Apple Reminders')
  assert.equal(describeOutcome({ status: 'agent_workflow_required' }).replay, false)
  assert.equal(describeOutcome({ status: 'agent_workflow_required' }).action, 'details')
  assert.equal(describeOutcome({ status: 'bad_request', reason: 'move_separately' }).field, 'calendarId')
  assert.equal(describeOutcome(null, { kind: 'unavailable_host' }).replay, true)
})

test('title labels must be nonempty and neither may start with the other', async () => {
  const { labelErrors } = await import('../src/lib/drafts.js')
  assert.deepEqual(labelErrors({ agent: '[Agent]', ready: '[Agent · Ready]' }), {})
  assert.equal(labelErrors({ agent: ' ', ready: 'R' }).agent, 'Add a label')
  assert.match(labelErrors({ agent: '[A]', ready: '[A] ready' }).ready, /start with the other/)
  assert.match(labelErrors({ agent: '[A] x', ready: '[A]' }).ready, /start with the other/)
})

test('append-only notes keep the original as the exact prefix', async () => {
  const { appendNotes, effectiveDraft } = await import('../src/lib/drafts.js')
  assert.equal(appendNotes('Whole grain', 'Two loaves'), 'Whole grain\nTwo loaves')
  assert.equal(appendNotes('Line\n', 'Next'), 'Line\nNext')
  assert.equal(appendNotes('', 'First'), 'First')
  assert.equal(appendNotes(null, '  '), '')
  const base = draftFromSource(source)
  const draft = effectiveDraft({ ...base, notesAdd: 'Two loaves' }, 'append')
  assert.deepEqual(editFields(base, draft, 'UTC'), { notes: 'Whole grain\nTwo loaves' })
  assert.ok(draft.notes.startsWith(source.notes))
  assert.equal(effectiveDraft({ ...base, notesAdd: 'x' }, 'replace').notes, 'Whole grain')
})

test('due edits follow the modes that keep the start time zone (human-contract.md)', () => {
  const allDay = draftFromSource(source)
  const timed = { ...allDay, time: '14:30' }
  const none = { ...allDay, date: '' }
  const open = { all_day: true, timed: true, clear: true, time_zone: null }
  const floating = { all_day: true, timed: false, clear: true, time_zone: null }
  const zoned = { all_day: false, timed: true, clear: false, time_zone: 'America/New_York' }
  // No start: add, change, clear and convert.
  for (const [from, to] of [[none, allDay], [none, timed], [allDay, none], [timed, none], [allDay, timed], [timed, allDay]]) {
    assert.equal(dueModeError(from, to, open), null)
  }
  // Floating start: all-day changes and clearing only.
  assert.equal(dueModeError(allDay, { ...allDay, date: '2030-11-09' }, floating), null)
  assert.equal(dueModeError(allDay, none, floating), null)
  assert.equal(dueModeError(allDay, timed, floating), 'Add a time in Apple Reminders')
  assert.equal(dueModeError(timed, { ...timed, time: '15:00' }, floating), 'Change the time in Apple Reminders')
  // Zoned start: timed changes only.
  assert.equal(dueModeError(timed, { ...timed, date: '2030-11-09', time: '09:15' }, zoned), null)
  assert.equal(dueModeError(timed, none, zoned), 'Clear this date in Apple Reminders')
  assert.equal(dueModeError(timed, allDay, zoned), 'Remove the time in Apple Reminders')
  // Unchanged due never blocks, even when no mode is open.
  assert.equal(dueModeError(timed, timed, { all_day: false, timed: false, clear: false }), null)
  assert.equal(validateDraft(none, { mode: 'edit', base: timed, dueModes: zoned }).due, 'Clear this date in Apple Reminders')
  // A clear is sent as null, a conversion as fresh components.
  assert.deepEqual(editFields(allDay, none, 'UTC'), { due: null })
  assert.deepEqual(editFields(allDay, timed, 'UTC').due, { calendar: 'gregorian', year: 2030, month: 11, day: 2, hour: 14, minute: 30, timeZone: 'UTC' })
})

test('a due edit the source time zone refuses shows its reason under Due and keeps the draft', () => {
  const shown = describeOutcome({ status: 'gated_field', reason: 'due_start_timezone' })
  assert.equal(shown.field, 'due')
  assert.equal(shown.action, 'reminders')
  assert.equal(shown.replay, false)
  assert.match(shown.message, /another time zone/)
})


test('emptying the date drops the stale time and sends an explicit clear', () => {
  const base = { ...draftFromSource(source), time: '09:00' }
  const cleared = withDueDate(base, '')
  assert.equal(cleared.time, '')
  assert.deepEqual(validateDraft(cleared, { mode: 'edit', base, dueModes: { clear: true } }), {})
  assert.deepEqual(editFields(base, cleared, 'America/New_York'), { due: null })
  assert.equal(withDueDate(base, '2030-03-10').time, '09:00')
  assert.equal(dueModeError(base, cleared, { clear: false, clear_reason: 'Repeating reminders need a date' }), 'Repeating reminders need a date')
})

test('a save refused behind an earlier unconfirmed one says so and is not itself checked again; the stuck bar keeps connection words', async () => {
  const { describeOutcome, stuckMessage } = await import('../src/lib/drafts.js')
  const behind = describeOutcome({ status: 'uncertain', operation_id: 'b', pending_operation_id: 'a' })
  assert.equal(behind.replay, false)
  assert.match(behind.message, /earlier save/)
  assert.equal(describeOutcome({ status: 'uncertain', operation_id: 'a' }).replay, true)
  assert.equal(stuckMessage({ tries: 0, title: 'X', outcome: { status: 'uncertain' } }), null)
  assert.match(stuckMessage({ tries: 1, title: 'X', body: { action: 'edit' }, outcome: { status: 'uncertain' } }), /still checking whether "X" saved/)
  assert.match(stuckMessage({ tries: 1, title: 'X', body: { action: 'reopen' }, outcome: { status: 'uncertain' } }), /still checking whether "X" saved/)
  const unsaved = describeOutcome({ status: 'not_saved' })
  assert.equal(unsaved.replay, false)
  assert.match(unsaved.message, /didn't go through/)
  assert.equal(stuckMessage({ tries: 2, title: 'X', outcome: { status: 'network' } }), null)
})

test('a space before an agent label does not slip it past the title check', () => {
  const labels = { agent: '[Agent]', ready: '[Agent · Ready]' }
  const draft = { title: '  [Agent] Book flights', notes: '', calendarId: 'l', date: '', time: '', priority: 0, notesAdd: '' }
  assert.match(validateDraft(draft, { labels }).title, /agent tasks/)
  assert.equal(validateDraft({ ...draft, title: 'Book [Agent] flights' }, { labels }).title, undefined)
  // A title typed in Reminders with a space before the label: other fields still save.
  const spaced = { ...draft, title: '  [Agent] Book flights' }
  assert.equal(validateDraft({ ...spaced, notes: 'more' }, { mode: 'edit', base: spaced, labels }).title, undefined)
  assert.match(validateDraft({ ...spaced, title: ' [Agent] Book flights' }, { mode: 'edit', base: spaced, labels }).title, /agent tasks/)
})
