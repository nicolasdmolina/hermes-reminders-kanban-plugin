// Where delegated work sits on the board, and which agent moves a drag or key may make.
// Pure: no host imports. Contracts: reminders_kanban/api/delegation-contract.md (task rows,
// statuses, limits), workflow/source-contract.md (ticket 11's guard), api/recovery-contract.md
// (ticket 17's recovery column/action) and execution/admission.md (queue reasons).
//
// The board reads two things: GET /human/board (the reminders) and GET /delegation (the agent
// work). A reminder with a delegation row is the agent's, whatever its title says; its column,
// label and next action come from the row, never from the title. Tickets 15 and 17 extend the
// STATUS table or the recovery labels here instead of placing cards themselves.

import { rerunToConfirm } from './delegation-outcomes.js'
import { elsewhereAgent, elsewhereFor, elsewhereOf, elsewhereRefusal } from './elsewhere.js'
import { currentRecovery, recoveryView } from './recovery.js'
import { COPY_LABEL, HELD, linkCopyOf, SOURCE_WAIT } from './reconciliation.js'

/** Column, label, tone and the user's next action for each delegation status.
 *  tone: agent | running | attention | danger | done | muted. action: what Needs you asks for. */
export const STATUS = {
  preparing: { column: 'Ready for Agent', label: 'Linking to Hermes', tone: 'agent', action: null },
  preparation_attention: { column: 'Needs you', label: "Couldn't add the task link", tone: 'danger', action: 'check' },
  ready: { column: 'Ready for Agent', label: 'Queued', tone: 'agent', action: null },
  active: { column: 'In progress', label: 'Working', tone: 'running', action: null },
  question: { column: 'Needs you', label: 'Answer Hermes', tone: 'attention', action: 'reply' },
  result: { column: 'Needs you', label: 'Review result', tone: 'attention', action: 'review' },
  failed: { column: 'Needs you', label: 'Failed', tone: 'danger', action: 'retry' },
  paused: { column: 'Needs you', label: 'Paused', tone: 'attention', action: 'resume' },
  needs_reconciliation: { column: 'Needs you', label: 'Check what happened', tone: 'danger', action: 'reconcile' },
  // A stopped run is never a result: the reminder stays open and goes back to you (To do), with a
  // quiet Stopped label; the dialog keeps the run's history (spec, Columns: Done is completed work).
  stopped: { column: 'To do', label: 'Stopped', tone: 'muted', action: null },
  done: { column: 'Done', label: 'Accepted', tone: 'done', action: null },
  // Reminders couldn't be read on the owner's last check (reconciliation-contract.md, #74): a wait
  // that keeps its place and resumes by itself after the next full read. Not counted in Needs you.
  waiting_source: { column: 'In progress', label: 'Waiting for Reminders', tone: 'waiting', action: 'source_wait' },
  deleted: { column: null, label: 'Deleted', tone: 'muted', action: null }
}

// Rows the owner has finished with; a live read never revives them.
const TERMINAL = new Set(['done', 'stopped', 'deleted'])

/** Ticket 11's paused reasons: what changed and what the user does next. Ticket 24's identity
 *  reasons and a moved due date are held (reconciliation.js HELD): the guard keeps them
 *  through later reads, so the way out is the reminder itself or Stop, never Resume. */
export const PAUSED = {
  instructions_changed: { label: 'Instructions changed', action: 'resume' },
  resume_uncertain: { label: 'Check before resuming', action: 'reconcile' },
  // A one-off given a repeat rule (or otherwise no longer delegable as it was).
  source_ineligible: { label: 'Changed in Reminders', action: 'reconcile' },
  // Hermes couldn't read Reminders on a check: a wait for the next full read, never a dead end.
  // Stop stays available; there is nothing to resume from the board (ticket 25).
  source_unavailable: { label: SOURCE_WAIT.label, tone: 'waiting', action: 'source_wait' },
  ...Object.fromEntries(Object.entries(HELD).map(([reason, held]) => [reason, { label: held.label, action: 'held' }]))
}

// Ticket 17's recovery labels and tones (recovery.action) live in lib/recovery.js, with the
// dialog's words, so a card and its dialog name a recovery the same way.

/** Admission queue reasons (limits.queue[].reason) for queued work. Null means "next up". */
export const QUEUE = {
  board_capacity: 'Waiting for a free slot',
  host_capacity: 'Waiting for Hermes',
  host_cooldown: 'Waiting for capacity',
  dependencies: 'Waiting on another task',
  resource_busy: 'Waiting on shared work',
  worker_still_alive: 'Waiting for the last run to stop'
}

/**
 * What one delegation row means on the board.
 * Returns { column, label, tone, action, status, waiting, stopUnverified, queueIndex, nextCheckAt }.
 * column null means the card leaves the board (deleted; its history stays in Hermes).
 */
export function agentState(row, limits = null, live = null) {
  // Admission parks queued work in Hermes' scheduled state, which the owner reports as `paused`.
  // A paused row the admission queue still holds, with no source veto (guard active), is queued.
  const queued = (limits?.queue ?? []).some(entry => entry.task_id === row?.task_id)
  const ticked = row?.status === 'paused' && queued && row?.guard?.status !== 'paused' ? 'ready' : row?.status
  // GET /attention reads each task's state live from Hermes (with the same queue and guard rules);
  // the delegation row is as of the last owner tick. Live wins, so a question that just arrived
  // is in Needs you at once and the header count, the column and notifications agree.
  // A source veto (ticket 11's guard paused the task: changed instructions, an unreadable or
  // uncertain reminder) wins over the live task state too, so the card says why it stopped.
  const vetoed = row?.guard?.status === 'paused' && row?.status === 'paused'
  const status = live?.state && !TERMINAL.has(ticked) && !vetoed ? live.state : ticked
  const base = STATUS[status] ?? { column: 'Needs you', label: 'Check this task', tone: 'danger', action: 'check' }
  const state = { ...base, status, waiting: status === 'waiting_source', queueIndex: null, nextCheckAt: null }
  // The live view keeps its state (running, a question, a result) and adds wait_reason; an
  // occurrence row keeps its own status while its guard waits. Either way it is this wait.
  const sourceWait = row?.guard?.status === 'waiting_source' || live?.wait_reason === 'source_unavailable'
  // A delivered result stays reviewable through the outage (#80: state result, review, counted);
  // only accepting it waits for Reminders.
  const delivered = sourceWait && (status === 'result' || live?.state === 'result' || row?.state === 'result')
  if (delivered && status !== 'result') Object.assign(state, STATUS.result, { status: 'result', waiting: false })
  if (sourceWait && !delivered && status !== 'waiting_source' && !TERMINAL.has(status)) {
    Object.assign(state, STATUS.waiting_source, { status: 'waiting_source', waiting: true })
  }
  // While it waits for Reminders, no queue label or cached recovery replaces that (ticket 25).
  const waitingForSource = state.status === 'waiting_source'
  const guard = row?.guard
  state.stopUnverified = guard?.worker_stop_verified === false
  // From here on the normalized status (a delivered result or a Reminders wait) decides.
  if (state.status === 'paused' && guard?.reason && PAUSED[guard.reason]) {
    Object.assign(state, PAUSED[guard.reason])
  }
  // Resume waits for the owner's reconciliation; the board never supplies that evidence.
  if (state.action === 'resume' && (guard?.reconciliation === 'required' || state.stopUnverified)) {
    state.action = 'reconcile'
  }
  if (state.status === 'ready' && !waitingForSource) {
    const queue = limits?.queue ?? []
    const at = queue.findIndex(entry => entry.task_id === row.task_id)
    if (at !== -1) {
      state.queueIndex = at
      const reason = queue[at].reason
      if (reason === 'host_cooldown') {
        // A routine usage wait belongs in In progress, labeled as waiting (spec, column table).
        Object.assign(state, { column: 'In progress', label: QUEUE.host_cooldown, tone: 'running', waiting: true })
      } else if (reason && QUEUE[reason]) {
        state.label = QUEUE[reason]
      } else if (!reason) {
        state.label = 'Up next'
      }
    }
  }
  // Recovery describes a failed attempt; like the owner's Recovery.observe, it no longer applies
  // once a new attempt runs, asks, delivers or stops, or once the owner authorized a new attempt
  // (currentRecovery). /attention carries the same durable recovery, read live; it wins over the
  // last tick's row. Only a usage wait shows a time (its native next check).
  // The live read wins as a whole: its state and its recovery (an explicit null included) replace
  // the tick's, so a stale row never hides a fresh recovery nor revives a finished one.
  const recoveryRow = live ? { ...row, status, recovery: 'recovery' in live ? live.recovery : row?.recovery } : row
  state.recoveryRow = recoveryRow
  const shown = waitingForSource ? null : recoveryView(currentRecovery(recoveryRow, status))
  if (shown) {
    Object.assign(state, {
      column: shown.column ?? state.column,
      action: shown.action,
      label: shown.card,
      tone: shown.tone,
      waiting: shown.action === 'wait',
      nextCheckAt: shown.nextCheck ? shown.nextCheck.toISOString() : null,
      recovery: shown
    })
  }
  return state
}

const withoutElsewhere = ({ elsewhere, ...card }) => card

/** The delegation row for a board card, matched by the reminder's source id. */
const reopenedSince = (card, row) => {
  if (card.source?.completed || row.scope || card.source?.rules?.length) return false
  // The newest state of the reminder Hermes saw: its guard rereads it on every check and on Resume.
  const seen = Math.max(...[row.guard?.source?.modified, row.source?.modified, row.expected?.modified].map(at => Date.parse(at ?? '')).filter(Number.isFinite))
  const now = Date.parse(card.source?.modified ?? '')
  return Number.isFinite(seen) && Number.isFinite(now) && now > seen
}

const startedAfterStop = (card, row, state) => {
  if (state.status !== 'stopped' || card.source?.completed || card.column !== 'In progress') return false
  // `stopped_seen_at`: a stop the board only observed (archived in Hermes, checked off and reopened).
  const stopped = Date.parse(row.stopped_at ?? row.stopped_seen_at ?? '')
  // A row stopped before stop times were recorded has none: the board's own In progress stands.
  if (!Number.isFinite(stopped)) return true
  return Number.isFinite(card.progress_at) && card.progress_at * 1000 > stopped
}

export function rowFor(card, delegation) {
  const id = card?.source?.id
  if (!id) return null
  // A repeating reminder's occurrence rows name their card in `match` (lib/occurrences.js).
  const rows = (delegation?.tasks ?? []).filter(row => (row?.match ? row.match === id : row?.expected?.id === id || row?.source?.id === id))
  // Delegating again after a Stop keeps the stopped row (archived under `storage_key`) beside the
  // new task: the current one is the row without it, else the newest.
  return rows.find(row => !row.storage_key) ?? rows.at(-1) ?? null
}

/**
 * Board cards with delegated work placed: owner 'agent', the column from its row, and
 * `card.agent` (agentState plus the row). Deleted work leaves the board. Ready for Agent follows
 * the admission queue (oldest eligible readiness first); In progress puts active work before
 * waits. Cards without a row are returned unchanged. A completed reminder stays in Done.
 * live: GET /attention `tasks` (live state by task_id), optional.
 */
export function placeCards(cards, delegation, live = null) {
  const list = cards ?? []
  if (!delegation?.tasks?.length && !list.some(elsewhereOf)) return list
  const liveById = new Map((live ?? []).map(task => [task.task_id, task]))
  const placed = []
  for (let card of list) {
    const row = rowFor(card, delegation)
    // Another Mac's Hermes has it (elsewhere.js): its card, read-only, whatever this Mac once ran.
    const where = elsewhereFor(card, row)
    if (where) {
      const theirs = { ...card, elsewhere: where, imported_ready: false, capabilities: { ...card.capabilities, edit: false, complete: false, progress: false } }
      placed.push({ ...theirs, owner: 'agent', column: 'In progress', agent: elsewhereAgent(theirs, row) })
      continue
    }
    // This Mac's own task is on the card now: a claim the board read earlier no longer applies.
    if (card.elsewhere) card = withoutElsewhere(card)
    if (!row) {
      // A reminder carrying another reminder's task link is yours, marked, never that task (story 60).
      const copy = linkCopyOf(card, delegation?.tasks)
      placed.push(copy ? { ...card, linkCopy: { ...copy, label: COPY_LABEL, tone: 'danger', action: null } } : card)
      continue
    }
    const state = agentState(row, delegation.limits, liveById.get(row.task_id))
    if (!state.column) continue
    // Accepted, then unchecked in Reminders: Hermes is finished with it and never looks again, so
    // the open reminder is yours, a plain card with its own column and moves. `finishedBefore`
    // keeps it from being handed to Hermes again here (the backend would return the old result).
    // Only a reminder changed since Hermes last read it counts: right after Accept the board can
    // still hold the pre-accept reminder for a moment, and that is not a reopen.
    if (state.status === 'done' && reopenedSince(card, row)) {
      // Yours even when its title still carries an agent label (the board would call it the agent's):
      // then its moves and dialog say to remove the label (moves.js labelledAfterStop). It keeps the
      // way to Hermes's conversation and accepted result (task-link.js cardBinding).
      placed.push({ ...card, owner: 'human', column: card.column === 'Ready for Agent' ? 'To do' : card.column, finishedBefore: true, finishedDestination: row.destination ?? null })
      continue
    }
    const agentColumn = card.source?.completed ? 'Done' : state.column
    // A stopped reminder is yours again: once you start it, it stays in In progress. Only a Start
    // after the Stop counts (`progress_at`, human-contract.md); one from before Hermes had it does
    // not. Its agent state keeps To do, so the dialog still offers Run again and never a Stop.
    const column = startedAfterStop(card, row, state) ? 'In progress' : agentColumn
    // After Stop the reminder is yours again; its card keeps the agent state for the label and dialog.
    const owner = state.status === 'stopped' ? 'human' : 'agent'
    // Its notes carry another task's link (copied in from another reminder): that conversation is
    // never shown as this task's (story 60).
    const copy = linkCopyOf(card, delegation?.tasks)
    placed.push({ ...card, owner, column, agent: { ...state, column: agentColumn, row }, ...(copy ? { linkCopy: { ...copy, label: COPY_LABEL, tone: 'danger', action: null } } : {}) })
  }
  // Columns are bucketed later (groupCards keeps order), so one rank-then-index sort orders each
  // column and keeps the board's own order inside each rank.
  return byAgentRank(placed)
}

// Ready for Agent follows the admission queue; In progress puts active work before waits.
const agentRank = card => {
  const agent = card.agent
  if (card.column === 'Ready for Agent') return agent?.queueIndex ?? (agent ? 1e6 : 2e6)
  if (card.column === 'In progress') return agent?.status === 'elsewhere' ? 2 : agent?.waiting ? 1 : 0
  return 0
}

const byAgentRank = cards =>
  cards
    .map((card, index) => ({ card, index }))
    .sort((a, b) => agentRank(a.card) - agentRank(b.card) || a.index - b.index)
    .map(entry => entry.card)

/**
 * The View's arranged board (ui/src/lib/views.js) with the agent order kept in its default sort:
 * the server orders by reminder fields and does not know the admission queue, so Ready for Agent
 * and In progress are re-ranked here, keeping the server's order inside each rank.
 */
export function keepAgentOrder(arranged) {
  if (!arranged?.groups) return arranged
  return {
    ...arranged,
    groups: arranged.groups.map(group =>
      group.name === 'Ready for Agent' || group.name === 'In progress' ? { ...group, cards: byAgentRank(group.cards) } : group
    )
  }
}

/** Short reasons for agent moves the workflow does not allow. */
export const AGENT_REFUSALS = {
  pickup_off: 'Turn on agent pickup first',
  pickup_unknown: 'Agent pickup is still loading',
  recurring: "Repeating reminders can't go to an agent yet",
  linked: 'Already linked to a Hermes task',
  queued: 'Hermes already has this task',
  working: 'Hermes is working on it',
  question: 'Answer Hermes first',
  review: 'Accept or request changes in the task',
  resume: 'Resume it from the task',
  attention: 'Open the task to see what it needs',
  finished: 'Finished tasks stay done',
  finished_before: 'Hermes already finished this one'
}

const refuse = key => ({ refused: key, reason: AGENT_REFUSALS[key] })

/**
 * Verdict for an agent move, or undefined when it isn't one (then ticket 10's human rules apply).
 * pickup: true (on), false (off) or null/undefined (not read yet). linked: the reminder already carries
 * a task link. Delegation moves have kind 'delegation' and action 'ready' or 'accept'. choose: the board
 * offers ticket 21's occurrence choice, so a repeating reminder dropped here asks which occurrence
 * (kind 'choose') instead of being refused.
 */
export function agentVerdict(card, to, { pickup, linked = false, choose = false } = {}) {
  if (!card || !to || card.column === to) return undefined
  // The other Mac's Hermes has it: nothing moves it from here (Take over is in its dialog).
  if (elsewhereOf(card)) return { refused: 'other_mac', reason: elsewhereRefusal(card.elsewhere.mac) }
  // A stopped task's reminder is yours again: human moves apply, and Ready delegates it afresh
  // (delegation-contract.md, "Explicit delegation after Stop").
  if (card.agent?.status === 'stopped') {
    if (to !== 'Ready for Agent') return undefined
    if (card.source?.completed) return refuse('finished')
    // A stopped occurrence of a repeating reminder runs again from its dialog (ticket 21).
    if (card.recurring || card.source?.rules?.length) return choose ? { kind: 'choose', action: 'choose' } : refuse('recurring')
    if (pickup == null) return refuse('pickup_unknown')
    if (!pickup) return refuse('pickup_off')
    // Hermes had started it: running again needs the person's yes first (RerunAsk in its dialog).
    return { kind: 'delegation', action: rerunToConfirm(card.agent.row) != null ? 'confirm' : 'ready' }
  }
  const agent = card.agent
  if (!agent) {
    if (to !== 'Ready for Agent') return undefined
    if (card.column === 'Done' || card.source?.completed) return refuse('finished')
    if (card.finishedBefore) return refuse('finished_before')
    if (card.recurring || card.source?.rules?.length) {
      if (!choose) return refuse('recurring')
      if (pickup == null) return refuse('pickup_unknown')
      return pickup ? { kind: 'choose', action: 'choose' } : refuse('pickup_off')
    }
    if (linked) return refuse('linked')
    if (pickup == null) return refuse('pickup_unknown')
    if (!pickup) return refuse('pickup_off')
    return { kind: 'delegation', action: 'ready' }
  }
  if (agent.status === 'result' && to === 'Done') return { kind: 'delegation', action: 'accept' }
  if (card.column === 'Done') return refuse('finished')
  if (agent.action === 'reply') return refuse('question')
  if (agent.action === 'review') return refuse('review')
  if (agent.action === 'resume') return refuse('resume')
  if (agent.column === 'Needs you') return refuse('attention')
  if (agent.column === 'In progress') return refuse('working')
  return refuse('queued')
}
