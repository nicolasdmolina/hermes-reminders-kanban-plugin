import assert from 'node:assert/strict'
import { test } from 'node:test'

import { describeOutcome } from '../src/lib/drafts.js'
import { actionOutcome } from '../src/lib/delegation-outcomes.js'
import { rebaseDraft, draftFromSource, sourceChanges } from '../src/lib/drafts.js'
import { problemText } from '../src/lib/delegation-outcomes.js'
import { CONFIRM_GUARD_MS, RELEASE_LAG_MS, confirmArmed, elsewhereAgent, elsewhereDialog, elsewhereFor, elsewhereOf, takeOverRequest, theirTaskLink } from '../src/lib/elsewhere.js'
import { moveVerdict } from '../src/lib/moves.js'
import { placeCards } from '../src/lib/placement.js'
import { claims, hasHermesTask, notesWithoutLink, onlyClaimChanged, taskLinkOf } from '../src/lib/task-link.js'

const OWNER = '00000000-0000-4000-8000-00000000000a'
const OTHER = 'ffffffff-ffff-4fff-8fff-fffffffffffb'
const LINK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const URL_A = `https://studio.tail.ts.net/reminders?owner=${OTHER}&link=${LINK}&profile=default&mac=Nicky%27s+Mac+Studio`
const LOCAL = `In Hermes on MacBook Pro (155) (ref ${OWNER}.${LINK})`

const card = (extra = {}) => ({
  id: 'c1',
  owner: 'agent',
  column: 'In progress',
  elsewhere: { mac: 'Studio', url: null },
  source: { id: 'r1', title: 'Book flights', notes: `Window seat\n\n${LOCAL}`, completed: false, rules: [] },
  ...extra
})

test('claims reads both claim forms from a reminder’s notes', () => {
  assert.deepEqual(claims(`Window seat\n\nOpen in Hermes: ${URL_A}\n\n${LOCAL}`), [
    { owner: OTHER, link: LINK, mac: "Nicky's Mac Studio", url: URL_A, start: 0, from: null },
    { owner: OWNER, link: LINK, mac: 'MacBook Pro (155)', url: null, start: 0, from: null }
  ])
  // The compact line: eight hex digits of each id and the start time; a take over adds whom from.
  const compact = 'In Hermes on MacBook Pro (ref 8115b29f.c245465c.to3n9c)'
  assert.deepEqual(claims(`Window seat\n\n${compact}`), [{ owner: '8115b29f', link: 'c245465c', mac: 'MacBook Pro', url: null, start: 1794000000, from: null }])
  assert.deepEqual(claims('In Hermes on Air (ref 8115b29f.c245465c.to3n9c~0a1b2c3d~2)')[0].from, '0a1b2c3d')
  assert.equal(claims(`Open in Hermes: ${URL_A}&t=to3n9c`)[0].start, 1794000000)
  assert.equal(notesWithoutLink(`Window seat\n\n${compact}`), 'Window seat')
  assert.equal(notesWithoutLink('Window seat\n\nIn Hermes on Air (ref 8115b29f.c245465c.to3n9c~0a1b2c3d)'), 'Window seat')
  assert.deepEqual(claims('In Hermes on Air (ref 8115b29.c245465c.x)'), [])
  // A take over names the install it took the reminder from; both forms still read and hide.
  const took = `In Hermes on Air (ref ${OWNER}.${LINK}, from ${OTHER}, take 2)`
  assert.deepEqual(claims(`${took}\nOpen in Hermes: ${URL_A}&from=${OWNER}`).map(claim => claim.from), [OTHER, OWNER])
  assert.equal(notesWithoutLink(`Window seat\n\n${took}`), 'Window seat')
  // A link written before Macs were named is called by its address.
  const old = URL_A.replace(/&mac=.*/, '')
  assert.equal(claims(`Open in Hermes: ${old}`)[0].mac, 'studio')
  assert.deepEqual(claims('Open in Hermes: https://nope.example/x'), [])
  assert.deepEqual(claims('In Hermes on Studio (ref not-a-ref)'), [])
  assert.deepEqual(claims(`See: ${LOCAL}`), [])
  assert.deepEqual(claims(null), [])
})

test('notes are shown without either claim line', () => {
  assert.equal(notesWithoutLink(`Window seat\n\n${LOCAL}`), 'Window seat')
  assert.equal(notesWithoutLink(`Window seat\n\nOpen in Hermes: ${URL_A}\n\n${LOCAL}`), 'Window seat')
  assert.equal(notesWithoutLink(`See: ${LOCAL}`), `See: ${LOCAL}`)
})

test('only an open reminder with a named Mac is elsewhere', () => {
  assert.deepEqual(elsewhereOf(card()), { mac: 'Studio', url: null })
  assert.equal(elsewhereOf(card({ source: { ...card().source, completed: true } })), null)
  assert.equal(elsewhereOf(card({ elsewhere: undefined })), null)
  assert.equal(elsewhereOf(null), null)
  const agent = elsewhereAgent(card())
  assert.deepEqual([agent.status, agent.column, agent.label, agent.action, agent.waiting, agent.row], ['elsewhere', 'In progress', 'On Studio', null, false, null])
})

test('the footer is just the buttons, with Open task only when there is a link', () => {
  const model = elsewhereDialog(card(), { pickup: true })
  // No sentence saying the other Mac "is working on this": the pill already says whose it is.
  assert.equal(model.line, undefined)
  assert.equal(model.mac, 'Studio')
  assert.equal(model.open, null)
  assert.deepEqual(model.takeOver, { label: 'Take over here', busy: 'Taking over…', refused: null })
  assert.deepEqual(model.ask, { text: 'Take over from Studio? Its work on this reminder stops.', confirm: 'Take over', cancel: 'Cancel' })
  assert.equal(model.choices, null)
  assert.equal(model.rerun, null)
  const linked = elsewhereDialog(card({ elsewhere: { mac: 'Studio', url: URL_A } }), { pickup: true })
  assert.deepEqual(linked.open, { label: 'Open task', url: URL_A })
  assert.equal(elsewhereDialog(card({ elsewhere: { mac: 'Studio', url: 'javascript:alert(1)' } }), { pickup: true }).open, null)
  assert.equal(elsewhereDialog(card({ elsewhere: undefined }), { pickup: true }), null)
})

test('Take over waits for pickup and a settled save', () => {
  assert.equal(elsewhereDialog(card(), { pickup: false }).takeOver.refused, 'Turn on agent pickup first')
  assert.equal(elsewhereDialog(card(), { pickup: false, unavailable: true }).takeOver.refused, "Agent pickup isn't available")
  assert.equal(elsewhereDialog(card(), { pickup: null }).takeOver.refused, 'Agent pickup is still loading')
  assert.equal(elsewhereDialog(card(), { pickup: true, unsure: true }).takeOver.refused, 'Check the last save first')
})

test('a repeating reminder asks which occurrence; a one-off goes straight over', () => {
  const repeating = card({ recurring: true, source: { ...card().source, rules: [{ frequency: 0 }] } })
  assert.deepEqual(elsewhereDialog(repeating, { pickup: true }).choices, ['ready', 'every'])
  assert.deepEqual(takeOverRequest(card()), ['/delegation/actions', { action: 'take_over', expected: card().source }])
  assert.deepEqual(takeOverRequest(repeating, 'ready'), ['/occurrences/actions', { action: 'ready', expected: repeating.source, take_over: true }])
  assert.deepEqual(takeOverRequest(repeating, 'every'), ['/recurring/actions', { action: 'every', expected: repeating.source, take_over: true }])
})

test('taking back work this Mac had started binds the consent to its last run', () => {
  const prior = { status: 'stopped', task_id: 't1', work_before_stop: { runs: [{ id: 7, ended_at: '2026-11-13T10:00:00Z' }] } }
  const taken = card()
  taken.agent = elsewhereAgent(taken, prior)
  assert.equal(elsewhereDialog(taken, { pickup: true }).rerun, 7)
  // An occurrence's row is not the one-off consent's to bind.
  assert.equal(elsewhereAgent(taken, { ...prior, scope: 'this_occurrence' }).prior, null)
})

test('a save the backend refused for the other Mac says whose it is', () => {
  const shown = describeOutcome({ status: 'conflict', reason: 'other_mac', mac: 'Studio' })
  assert.deepEqual([shown.tone, shown.short, shown.message], ['error', 'Hermes on Studio has this', 'Hermes on Studio has this.'])
})

const mine = { key: 'k', status: 'ready', task_id: 't9', expected: { id: 'r1' }, destination: { owner_id: 'me', link_id: 'l2', url: null } }

test('after a Take over, this Mac’s new task outranks a board read from before it', () => {
  // The delegation read has the new row; the board still says the other Mac has it.
  const placed = placeCards([card({ claim: 'foreign' })], { tasks: [mine] })[0]
  assert.deepEqual([placed.agent.status, placed.column, placed.elsewhere], ['ready', 'Ready for Agent', undefined])
  assert.equal(elsewhereDialog(placed, { pickup: true }), null)
  // A row still linking counts too; a finished one does not.
  assert.equal(elsewhereFor(card(), { ...mine, status: 'preparing', destination: undefined }), null)
  assert.deepEqual(elsewhereFor(card(), { ...mine, status: 'stopped' }), { mac: 'Studio', url: null })
  assert.deepEqual(elsewhereFor(card(), { ...mine, status: 'done' }), { mac: 'Studio', url: null })
})

test('a claim this Mac just lost reads as the other Mac’s at once, never as Stopped', () => {
  // The owner let go (yielded); the board has not reread, so the card carries no `elsewhere` yet.
  const before = { ...card({ elsewhere: undefined, claim: 'several' }), owner: 'human', column: 'To do', capabilities: { progress: true, complete: true, edit: true } }
  const lost = { ...mine, status: 'stopped', released: { reason: 'yielded', mac: 'Studio', url: null, at: new Date().toISOString() } }
  const placed = placeCards([before], { tasks: [lost] })[0]
  assert.deepEqual([placed.column, placed.owner, placed.agent.label], ['In progress', 'agent', 'On Studio'])
  assert.deepEqual(moveVerdict(placed, 'Done', { pickup: true }), { refused: 'other_mac', reason: 'Hermes on Studio has this' })
  assert.equal(placed.capabilities.complete, false)
  // Nor with a board read from just before the other Mac's line arrived.
  assert.equal(placeCards([{ ...before, claim: 'mine' }], { tasks: [lost] })[0].agent.label, 'On Studio')
  // Once the other Mac's claim is gone it is this Mac's stopped card again.
  const freed = placeCards([{ ...before, claim: undefined }], { tasks: [lost] })[0]
  assert.deepEqual([freed.column, freed.agent.status], ['To do', 'stopped'])
  // Nor does a line left in the notes keep the other Mac's name once the board has reread.
  const at = Date.parse(lost.released.at)
  assert.deepEqual(elsewhereFor({ ...before, claim: 'mine' }, lost, at + RELEASE_LAG_MS - 1), { mac: 'Studio', url: null })
  assert.equal(elsewhereFor({ ...before, claim: 'mine' }, lost, at + RELEASE_LAG_MS), null)
  assert.equal(elsewhereFor({ ...before, claim: 'mine' }, { ...lost, released: { ...lost.released, at: undefined } }), null)
  // Checked off: simply done.
  assert.equal(elsewhereFor({ ...before, source: { ...before.source, completed: true } }, lost), null)
})

test('a reminder the other Mac finished opens as plain details, not as a foreign task', () => {
  const source = { id: 'r1', title: 'Book flights', notes: `x\n\nOpen in Hermes: ${URL_A}`, completed: true, rules: [] }
  assert.ok(taskLinkOf(source))
  assert.equal(hasHermesTask({ id: 'c', claim: 'foreign', source }), false)
  // The same link with this Mac's own task behind it, or on a board that doesn't say, still opens the task.
  assert.equal(hasHermesTask({ id: 'c', claim: 'mine', source }), true)
  assert.equal(hasHermesTask({ id: 'c', source }), true)
  assert.equal(hasHermesTask({ id: 'c', claim: 'foreign', source, agent: { row: mine } }), true)
})

test('Take over of a reminder this Mac finished earlier reports the new task', () => {
  const src = card().source
  const answer = { status: 'ok', tasks: [{ status: 'done', storage_key: 'old', expected: src }, { status: 'ready', expected: src }] }
  assert.equal(actionOutcome(answer, 'ready', 'r1').result.status, 'ok')
  // An answer with only the finished row (an older backend) is not a success to show as taken over.
  assert.equal(elsewhereDialog({ ...card(), agent: { prior: { status: 'done' } } }, { pickup: true }).rerun, null)
})

test('an old link is named by its host only when the host is a name', () => {
  const named = u => claims(`Open in Hermes: ${u}`)[0].mac
  assert.equal(named('https://Nickys-Mac-mini.tail1.ts.net/reminders?owner=o&link=l'), 'nickys-mac-mini')
  assert.equal(named('https://100.101.5.9/reminders?owner=o&link=l'), 'another Mac')
  assert.equal(named('https://4.example.com/reminders?owner=o&link=l'), 'another Mac')
  assert.equal(named('https://[fd7a::1]/reminders?owner=o&link=l'), 'another Mac')
  assert.equal(named('https://x.ts.net/reminders?owner=o&link=l&mac='), 'x')
  assert.equal(elsewhereAgent(card({ elsewhere: { mac: 'another Mac', url: null } })).label, 'On another Mac')
})

test('a snapshot that differs only by a claim line is safe to send again', () => {
  const before = { id: 'r1', title: 'Book flights', notes: `Window seat\n\n${LOCAL}`, modified: 'm1', due: null }
  const after = { ...before, notes: 'Window seat', modified: 'm2' }
  assert.equal(onlyClaimChanged(before, after), true)
  assert.equal(onlyClaimChanged(before, { ...after, title: 'Book trains' }), false)
  assert.equal(onlyClaimChanged(before, { ...after, notes: 'Aisle seat' }), false)
  assert.equal(onlyClaimChanged(before, before), false)
  assert.equal(onlyClaimChanged(before, null), false)
  assert.equal(onlyClaimChanged(before, { ...after, id: 'r2' }), false)
})

test('a confirm that appears under the pointer ignores the second click of a double-click', () => {
  assert.equal(CONFIRM_GUARD_MS, 400)
  assert.equal(confirmArmed(1000, 1100), false)
  assert.equal(confirmArmed(1000, 1399), false)
  assert.equal(confirmArmed(1000, 1400), true)
})

test('a finished reminder with the other Mac’s link keeps Open task, and nothing to take over', () => {
  const source = { id: 'r1', title: 'Book flights', notes: `x\n\nOpen in Hermes: ${URL_A}`, completed: true, rules: [] }
  const done = { id: 'c', owner: 'human', column: 'Done', claim: 'foreign', source }
  assert.deepEqual(theirTaskLink(done), { label: 'Open task', url: URL_A })
  assert.equal(elsewhereDialog(done, { pickup: true }), null)
  // Not for an open one (its dialog has the footer above), this Mac's own, or a line with no link.
  assert.equal(theirTaskLink({ ...done, source: { ...source, completed: false } }), null)
  assert.equal(theirTaskLink({ ...done, claim: 'mine' }), null)
  assert.equal(theirTaskLink({ ...done, source: { ...source, notes: `x\n\n${LOCAL}` } }), null)
})

test('Delegate on a reminder the other Mac just claimed says whose it is', () => {
  assert.equal(problemText({ status: 'conflict', reason: 'other_mac', mac: 'Studio' }), 'Hermes on Studio has this')
  assert.equal(actionOutcome({ status: 'conflict', reason: 'other_mac', mac: 'Studio', tasks: [] }, 'ready', 'r1').message, 'Hermes on Studio has this')
})

test('a claim line coming or going is not a change to the notes in the edit form', () => {
  const before = { id: 'r1', title: 'Book flights', notes: 'Window seat', calendarId: 'l', priority: 0, due: null, completed: false }
  const claimed = { ...before, notes: `Window seat\n\n${LOCAL}` }
  assert.deepEqual(sourceChanges(before, claimed), [])
  assert.deepEqual(sourceChanges(claimed, before), [])
  assert.deepEqual(sourceChanges(before, { ...claimed, notes: `Aisle seat\n\n${LOCAL}` }), ['notes'])
  // The draft follows the reminder (so an append still starts from its real notes), with no
  // conflict, and what was being added is kept.
  const base = draftFromSource(before)
  const rebased = rebaseDraft(base, { ...base, title: 'Book trains', notesAdd: 'Row 12' }, claimed)
  assert.deepEqual(rebased.conflicts, [])
  assert.deepEqual([rebased.draft.notes, rebased.draft.notesAdd, rebased.draft.title], [claimed.notes, 'Row 12', 'Book trains'])
})
