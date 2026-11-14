import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applyMoves, moveVerdict, REFUSALS, stepTarget } from '../src/lib/moves.js'

const human = (column, capabilities = { edit: false, complete: true, progress: true }) => ({
  id: 'h1',
  owner: 'human',
  column,
  capabilities,
  source: { id: 'r1', title: 'Milk' }
})

test('human moves map onto the contract actions', () => {
  assert.deepEqual(moveVerdict(human('To do'), 'In progress'), { action: 'progress', fields: { column: 'In progress' } })
  assert.deepEqual(moveVerdict(human('In progress'), 'To do'), { action: 'progress', fields: { column: 'To do' } })
  assert.deepEqual(moveVerdict(human('To do'), 'Done'), { action: 'complete', fields: {} })
  assert.deepEqual(moveVerdict(human('In progress'), 'Done'), { action: 'complete', fields: {} })
  assert.equal(moveVerdict(human('To do'), 'To do'), null)
})

test('moves the workflow does not allow are refused with a reason', () => {
  assert.equal(moveVerdict(human('To do'), 'Ready for Agent').refused, 'ready')
  assert.equal(moveVerdict(human('To do'), 'Needs you').refused, 'needs_you')
  // Without the workflow's reopen capability, Done stays Done.
  assert.equal(moveVerdict(human('Done'), 'To do').refused, 'reopen')
  assert.equal(moveVerdict(human('Done'), 'In progress').reason, REFUSALS.reopen)
  const agent = { ...human('To do'), owner: 'agent', capabilities: { edit: false, complete: false, progress: false } }
  assert.equal(moveVerdict(agent, 'Done').refused, 'agent')
  assert.equal(moveVerdict(agent, 'In progress').refused, 'agent')
})

test('a reopenable Done card reopens into To do or In progress, and nowhere else', () => {
  const done = human('Done', { complete: true, progress: true, reopen: true })
  assert.deepEqual(moveVerdict(done, 'To do'), { action: 'reopen', fields: { column: 'To do' } })
  assert.deepEqual(moveVerdict(done, 'In progress'), { action: 'reopen', fields: { column: 'In progress' } })
  assert.equal(moveVerdict(done, 'Ready for Agent').refused, 'ready')
  assert.equal(moveVerdict(done, 'Needs you').refused, 'needs_you')
  assert.equal(moveVerdict({ ...done, owner: 'agent' }, 'To do').refused, 'agent')
})

test('capabilities from the workflow gate each action; missing capabilities allow nothing', () => {
  assert.equal(moveVerdict(human('To do', { complete: false, progress: true }), 'Done').refused, 'no_actions')
  assert.equal(moveVerdict(human('To do', { complete: true, progress: false }), 'In progress').refused, 'no_actions')
  // A plain preview envelope (after PUT /setup) has no capabilities yet.
  assert.equal(moveVerdict({ id: 'x', owner: 'human', column: 'To do' }, 'Done').refused, 'no_actions')
  assert.equal(moveVerdict(human('To do'), 'Done', { pending: true }).refused, 'pending')
})

test('keyboard steps follow To do → In progress → Done and stop at the ends', () => {
  assert.equal(stepTarget(human('To do'), 1), 'In progress')
  assert.equal(stepTarget(human('In progress'), 1), 'Done')
  assert.equal(stepTarget(human('Done'), 1), null)
  assert.equal(stepTarget(human('In progress'), -1), 'To do')
  assert.equal(stepTarget(human('To do'), -1), null)
  assert.equal(stepTarget(human('Done'), -1), 'In progress')
})

test('pending moves overlay server cards without mutating them', () => {
  const cards = [human('To do'), { ...human('To do'), id: 'h2' }]
  const shown = applyMoves(cards, { h1: 'Done' })
  assert.equal(shown[0].column, 'Done')
  assert.equal(shown[1], cards[1])
  assert.equal(cards[0].column, 'To do')
  assert.equal(applyMoves(cards, {}), cards)
})

test('once the board knows about agent pickup, agent moves follow placement.js', () => {
  assert.deepEqual(moveVerdict(human('To do'), 'Ready for Agent', { pickup: true }), { kind: 'delegation', action: 'ready' })
  assert.equal(moveVerdict(human('To do'), 'Ready for Agent', { pickup: false }).reason, 'Turn on agent pickup first')
  assert.equal(moveVerdict(human('To do'), 'Ready for Agent', { pickup: null }).refused, 'pickup_unknown')
  // A reminder that already carries a task link is not delegated again.
  const linked = { ...human('To do'), source: { id: 'r1', title: 'Milk', notes: 'x\n\nOpen in Hermes: https://h.example/reminders?owner=o1&link=l1&profile=default' } }
  assert.equal(moveVerdict(linked, 'Ready for Agent', { pickup: true }).refused, 'linked')
  // Human moves are unchanged.
  assert.deepEqual(moveVerdict(human('To do'), 'Done', { pickup: true }), { action: 'complete', fields: {} })
  assert.equal(moveVerdict(human('To do'), 'Done', { pickup: true, pending: true }).refused, 'pending')
  const result = { ...human('Needs you'), owner: 'agent', agent: { status: 'result', action: 'review', column: 'Needs you' } }
  assert.deepEqual(moveVerdict(result, 'Done', { pickup: true }), { kind: 'delegation', action: 'accept' })
})

test('a stopped reminder that still carries an agent label says what frees it', () => {
  const stuck = { id: 'c', owner: 'human', column: 'To do', source: { id: 's', title: '[Agent] Book flights', completed: false }, capabilities: { progress: false, complete: false }, agent: { status: 'stopped', column: 'To do' } }
  assert.equal(moveVerdict(stuck, 'In progress').refused, 'labelled')
  assert.match(moveVerdict(stuck, 'Done').reason, /agent label/)
  // Without the label the workflow offers the moves, and they go through.
  assert.equal(moveVerdict({ ...stuck, capabilities: { progress: true, complete: true } }, 'In progress').action, 'progress')
  // Before the first read lands a card has no capabilities yet: that is not a label.
  assert.equal(moveVerdict({ ...stuck, capabilities: undefined }, 'In progress').refused, 'no_actions')
})

test('nothing moves a reminder another Mac’s Hermes is working on', () => {
  const theirs = { id: 'e1', owner: 'agent', column: 'In progress', elsewhere: { mac: 'Studio', url: null }, source: { id: 'r9', title: 'Book flights', completed: false, rules: [] }, capabilities: { progress: false, complete: false, edit: false } }
  for (const to of ['To do', 'Ready for Agent', 'Needs you', 'Done']) {
    for (const pickup of [undefined, null, false, true]) {
      assert.deepEqual(moveVerdict(theirs, to, { pickup }), { refused: 'other_mac', reason: 'Hermes on Studio has this' })
    }
  }
  assert.equal(moveVerdict(theirs, 'Done', { pickup: true, pending: true }).refused, 'other_mac')
  assert.equal(moveVerdict(theirs, 'In progress', { pickup: true }), null)
})

test('a claim this Hermes lost the task for can be delegated again', () => {
  const notes = 'x\n\nIn Hermes on Studio (ref 00000000-0000-4000-8000-00000000000a.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa)'
  const lost = { ...human('To do'), claim: 'lost', source: { id: 'r1', title: 'Milk', notes } }
  assert.deepEqual(moveVerdict(lost, 'Ready for Agent', { pickup: true }), { kind: 'delegation', action: 'ready' })
  const linkedLost = { ...lost, source: { ...lost.source, notes: 'x\n\nOpen in Hermes: https://h.example/reminders?owner=o1&link=l1&profile=default' } }
  assert.deepEqual(moveVerdict(linkedLost, 'Ready for Agent', { pickup: true }), { kind: 'delegation', action: 'ready' })
  // A claim it still has a task for (a copy of another reminder's) stays refused.
  assert.equal(moveVerdict({ ...linkedLost, claim: 'mine' }, 'Ready for Agent', { pickup: true }).refused, 'linked')
})
