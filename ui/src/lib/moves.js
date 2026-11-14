// Which column moves a human may make, and the backend action each one becomes.
// Pure: no host imports. Contract: reminders_kanban/api/human-contract.md.
//
// The workflow owns the rules; this file only reads what a card says it can do
// (`card.capabilities`) and maps a drop onto the contract's action table. It never
// decides recurrence or agent authority: a recurring card that completes comes back
// in To do on the next board read, and that read wins. Agent moves (into Ready for Agent, and
// a result into Done) are ticket 13's, in placement.js; they apply once the board knows whether
// agent pickup is on (`pickup` true, false, or null while loading).

import { elsewhereOf, elsewhereRefusal } from './elsewhere.js'
import { agentVerdict } from './placement.js'
import { taskLinkOf } from './task-link.js'

export const HUMAN_PATH = ['To do', 'In progress', 'Done']

/** Short, plain reasons for moves the workflow doesn't allow. */
export const REFUSALS = {
  agent: 'Hermes moves agent tasks',
  ready: 'Turn on agent pickup first',
  needs_you: 'Only agent tasks wait here',
  reopen: 'Reopen it in Apple Reminders',
  pending: 'Still saving the last move',
  no_actions: 'Refresh to move this reminder',
  labelled: 'Remove the agent label in Reminders first',
  unknown: "This board can't move it there"
}

/** A reminder taken back with Stop whose title still carries an agent label: the person's on the
 *  board, but the workflow offers it no moves (human-contract.md, agent-labelled titles). */
export const labelledAfterStop = card => (card?.agent?.status === 'stopped' || Boolean(card?.finishedBefore)) && !card.source?.completed && Boolean(card.capabilities) && !card.capabilities.progress && !card.capabilities.complete

/**
 * Verdict for moving `card` into column `to`.
 * Returns null for a no-op (same column), `{ refused, reason }` for a move the
 * workflow does not allow, or `{ action, fields }` for the request to send.
 */
export function moveVerdict(card, to, { pending = false, pickup, choose = false } = {}) {
  if (!card || !to || card.column === to) return null
  const refuse = key => ({ refused: key, reason: REFUSALS[key] })
  // Another Mac's Hermes is working on it: no move from here, whatever the board knows of pickup.
  if (elsewhereOf(card)) return { refused: 'other_mac', reason: elsewhereRefusal(card.elsewhere.mac) }
  if (pending) return refuse('pending')
  if (pickup !== undefined) {
    // A claim this Hermes wrote but no longer has a task for (`claim: 'lost'`) is no link to keep:
    // Delegate replaces it. A board that doesn't say goes by the link in the notes.
    const linked = card.claim ? card.claim !== 'lost' : Boolean(taskLinkOf(card.source))
    const agent = agentVerdict(card, to, { pickup, linked, choose })
    if (agent !== undefined) return agent
  }
  if (card.owner === 'agent') return refuse('agent')
  if (to === 'Ready for Agent') return refuse('ready')
  if (to === 'Needs you') return refuse('needs_you')
  const can = card.capabilities ?? {}
  // Out of Done is a reopen. The workflow allows it only for one-off reminders this plugin
  // completed (capabilities.reopen); others are reopened in Apple Reminders.
  if (card.column === 'Done') {
    if (to !== 'To do' && to !== 'In progress') return refuse('unknown')
    return can.reopen ? { action: 'reopen', fields: { column: to } } : refuse('reopen')
  }
  // Stopped, but its title still carries an agent label: the workflow keeps treating it as agent
  // work, so it can't be moved by hand until the label is gone (or it is run again).
  const blocked = labelledAfterStop(card) ? 'labelled' : 'no_actions'
  if (to === 'Done') return can.complete ? { action: 'complete', fields: {} } : refuse(blocked)
  if (to === 'To do' || to === 'In progress') {
    return can.progress ? { action: 'progress', fields: { column: to } } : refuse(blocked)
  }
  return refuse('unknown')
}

/** Keyboard step along To do → In progress → Done. `direction` is 1 or -1.
 *  Returns the target column, or null at either end of the path. */
export function stepTarget(card, direction) {
  const at = HUMAN_PATH.indexOf(card?.column)
  // Agent columns sit off the human path; stepping from them lands on the nearest end.
  if (at === -1) return direction > 0 ? 'In progress' : 'To do'
  return HUMAN_PATH[at + direction] ?? null
}

/** Cards with in-flight or just-confirmed moves shown in their target column.
 *  `overlay` maps card id → column. Server data is never mutated. */
export function applyMoves(cards, overlay) {
  if (!cards || !overlay || Object.keys(overlay).length === 0) return cards ?? []
  return cards.map(card => (overlay[card.id] && overlay[card.id] !== card.column ? { ...card, column: overlay[card.id] } : card))
}
