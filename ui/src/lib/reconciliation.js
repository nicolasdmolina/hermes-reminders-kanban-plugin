// Recovery after disconnection and uncertain reminder identity (ticket 25), from the owner's
// reconciliation contract (reminders_kanban/api/reconciliation-contract.md). Pure: no host imports.
//
// The backend never moves a task to another reminder. A held identity stays held until the
// reminder is checked off or the task is stopped, so nothing here offers Resume or "Check again"
// for it; the only ways out are the reminder itself (Reminders) and Stop.

import { currentRecovery } from './recovery.js'
import { taskLinkOf } from './task-link.js'

/** What changed about a delegated reminder, in plain words. Shared by one-off cards (placement.js)
 *  and repeating reminders' occurrences (occurrences.js), so both name a reason the same way. */
export const SOURCE_TEXT = {
  source_unavailable: "Hermes can't read this reminder",
  identity_replaced: 'The reminder was replaced in Reminders',
  identity_changed: 'The reminder was replaced in Reminders',
  missing_identity: "Hermes can't find this reminder",
  deleted: 'The reminder was deleted in Reminders',
  multiple_candidates: 'More than one reminder matches this one',
  conflicting_links: 'Another reminder has the same task link'
}

/**
 * One-off guard reasons that hold a task until the person acts on the reminder: { label, line }.
 * label is the card's state line; line is the dialog's sentence. The guard keeps these reasons
 * through later reads (source.py), so the board offers Stop and the reminder itself, never Resume.
 */
export const HELD = {
  identity_changed: { label: 'Reminder was replaced', line: "The reminder was replaced in Reminders. Hermes won't move this task to the new one." },
  identity_replaced: { label: 'Reminder was replaced', line: "The reminder was replaced in Reminders. Hermes won't move this task to the new one." },
  missing_identity: { label: "Can't find the reminder", line: "Hermes can't find this reminder, and won't match the task to another one." },
  multiple_candidates: { label: 'Several reminders match', line: "More than one reminder matches this one. Hermes won't pick one." },
  conflicting_links: { label: 'Task link copied', line: "Another reminder has this task's link. Hermes won't follow the copy." },
  occurrence_changed: { label: 'Due date changed', line: 'The due date changed in Reminders. Hermes stopped picking this up.' }
}

/** A task waiting because Hermes couldn't read Reminders: it resumes by itself after the next full
 *  read (reconciliation-contract.md, #74). An older owner paused it instead (guard paused,
 *  source_unavailable); both read as this wait. */
export const SOURCE_WAIT = {
  label: 'Waiting for Reminders',
  line: "Hermes can't read Reminders right now. It picks this up again on its own."
}

/** The held reason for a delegation row, or null. */
export function heldReason(row) {
  const guard = row?.guard
  if (!guard || guard.status !== 'paused') return null
  return HELD[guard.reason] ? guard.reason : null
}

// Board notices (lib/state.js NOTICES) that mean the last read is not current.
const STALE = new Set(['refresh_failed', 'list_unavailable', 'access_denied', 'unavailable_host', 'auth', 'backend_missing', 'bad_request'])

/** Whether the board's notice means its reminders (and so its queue) are not current. */
export const isStale = notice => Boolean(notice && STALE.has(notice.kind))

export const QUEUED_STALE = 'Waiting for Reminders'
export const QUEUED_CHECKING = 'Checking Reminders first'
// Pickup was turned off with work still queued: nothing new starts until it is back on, so a
// queued or waiting card must not promise "Up next" or a next check time.
export const QUEUED_PICKUP_OFF = 'Waiting for pickup'

/**
 * Queued work while the board can't read Reminders, or while it rereads them after reconnecting:
 * never "Up next". Hermes reads each reminder again before it starts (dispatch_requires_fresh_read).
 * label: QUEUED_STALE or QUEUED_CHECKING; null returns the cards unchanged.
 */
export function holdQueued(cards, label) {
  if (!label) return cards
  return cards.map(card => {
    const agent = card.agent
    if (!agent) return card
    // With pickup off, a usage or slot wait is held too, and its next check time no longer applies.
    // A wait on Reminders keeps its own words (it resumes when Reminders is back, whatever pickup is).
    if (label === QUEUED_PICKUP_OFF && agent.waiting && agent.column !== 'Needs you' && agent.action !== 'source_wait') return { ...card, agent: { ...agent, label, line: label, nextCheckAt: null, pickupOff: true } }
    // So does a repeating reminder's next occurrence: Hermes prepares none while pickup is off.
    // (and it links none either: a row still waiting for its task says the same.)
    if (label === QUEUED_PICKUP_OFF && (agent.status === 'series_next' || agent.status === 'preparing')) return { ...card, agent: { ...agent, label, line: label, pickupOff: true } }
    if (agent.status !== 'ready' || agent.waiting) return card
    // A requeued task that needs you (an empty balance, a sign-in to repair, a check) keeps saying
    // so whatever holds the queue: that is the thing to act on, and its dialog keeps the button for it.
    if (agent.column === 'Needs you') return card
    return { ...card, agent: { ...agent, label, line: label, pickupOff: label === QUEUED_PICKUP_OFF } }
  })
}

/** Rows that belong to this reminder (one-off by source id, an occurrence by its card match). */
const rowsOfCard = (rows, id) => rows.filter(row => (row?.match ? row.match === id : row?.expected?.id === id || row?.source?.id === id))

// The reminder a row was delegated from, or the next occurrence Apple made of it. An accepted This
// occurrence row places on its completed copy (`match`), while the pending next occurrence keeps the
// reminder's id and inherits its task link: that card is the same reminder, not a copy.
const sameReminder = (row, id) => row?.expected?.id === id || row?.source?.id === id || row?.completion?.successor?.id === id

/**
 * A reminder whose notes carry another reminder's task link (a copy in Reminders, or a replacement
 * reminder): { taskId, title } of the task the link names, or null. Such a card is not that task's:
 * the board shows no conversation for it and no opener lands on it (story 60).
 */
export function linkCopyOf(card, rows) {
  const dest = taskLinkOf(card?.source)
  const id = card?.source?.id
  if (!dest || !id || !Array.isArray(rows)) return null
  const named = rows.filter(row => row?.destination?.link_id === dest.link && (!row.destination.owner_id || row.destination.owner_id === dest.owner))
  if (!named.length || rowsOfCard(named, id).length || named.some(row => sameReminder(row, id))) return null
  const row = named.find(entry => !entry.storage_key) ?? named.at(-1)
  return { taskId: row.task_id ?? null, title: row.history?.task?.title ?? row.expected?.title ?? row.source?.title ?? '' }
}

export const COPY_LABEL = 'Copied task link'

// What a reconnect read found, per row: one-off status and guard reason, or an occurrence's status,
// reason and series state. Only these changes are reported.
const signature = row =>
  [row?.status ?? '', row?.guard?.status ?? '', row?.guard?.reason ?? '', row?.reason ?? '', row?.series_state ?? '', row?.held_reason ?? ''].join('|')

const FOUND = {
  deleted: 'Deleted in Reminders',
  completed: 'Checked off in Reminders',
  instructions_changed: 'Instructions changed',
  occurrence_changed: 'Due date changed'
}

function finding(row) {
  const guard = row?.guard ?? {}
  if (row.status === 'deleted' || guard.reason === 'deleted' || row.reason === 'deleted') return 'deleted'
  if (guard.reason === 'completed' || row.reason === 'completed') return 'completed'
  const reason = guard.status === 'paused' ? guard.reason : row.reason
  if (reason === 'instructions_changed' || reason === 'changed_instructions') return 'instructions_changed'
  if (HELD[reason]) return reason
  if (row.series_state === 'needs_reconciliation') return 'series'
  return null
}

/** Plain words for one reconnect finding kind. */
export function findingText(kind, row = null) {
  if (FOUND[kind]) return FOUND[kind]
  if (HELD[kind]) return HELD[kind].label
  if (kind === 'series') return 'Needs a decision'
  return row ? 'Changed in Reminders' : null
}

/**
 * What changed for delegated work between the rows held before Reminders went unreadable and the
 * rows the reconnect read returned: [{ key, taskId, kind, text, title, destination, occurrence }], in the
 * order of `after`. A row is reported only when its state changed and the change is one the person
 * should see (deleted, checked off, instructions or identity, a held series). Pure: rows as given
 * by GET /delegation, GET /occurrences or POST /reconciliation/actions (tasks).
 */
export function reconnectFindings(before, after) {
  const earlier = new Map((before ?? []).map(row => [row?.key, signature(row)]))
  const found = []
  for (const row of after ?? []) {
    if (!row?.key || !earlier.has(row.key) || earlier.get(row.key) === signature(row)) continue
    const kind = finding(row)
    if (!kind) continue
    found.push({
      key: row.key,
      taskId: row.task_id ?? null,
      kind,
      text: findingText(kind, row),
      title: String(row.history?.task?.title ?? row.source?.title ?? row.expected?.title ?? '').trim() || 'Untitled task',
      destination: row.destination ?? null,
      occurrence: row.scope ? row.key : null
    })
  }
  return found
}

/**
 * The task conversation's live line for a task the board holds or waits on, from its agent state
 * (placement.js agentState, which already folds in the live state and the guard): a held identity
 * reads "Held: several reminders match" (kind 'held'), a Reminders wait "Waiting for Reminders"
 * (kind 'waiting'). Neither is running work: no spinner, no timer. null for anything else, and the
 * conversation keeps its own line. One-off tasks and occurrences alike (ticket 25).
 * `blocks`: the backend refuses a reply or changes while this lasts, so no composer is offered.
 * `pill` and `line`: the card's words and its reason, for the browser page, which has no board footer.
 */
export function holdActivity(agent) {
  if (agent?.action === 'held' && agent.label) {
    return { kind: 'held', label: `Held: ${agent.label.charAt(0).toLowerCase()}${agent.label.slice(1)}`, since: null, blocks: true, pill: agent.label, line: Object.values(HELD).find(entry => entry.label === agent.label)?.line ?? null }
  }
  if (agent?.action === 'source_wait') return { kind: 'waiting', label: SOURCE_WAIT.label, since: null, blocks: true, pill: SOURCE_WAIT.label, line: SOURCE_WAIT.line }
  // Held by pickup being off (holdQueued): the dialog says what the card says, not a retry time.
  // (A repeating reminder between occurrences says it on its own next-occurrence line instead.)
  if (agent?.pickupOff && agent.status !== 'series_next') return { kind: 'waiting', label: QUEUED_PICKUP_OFF, since: null }
  return null
}

/**
 * The hold line for the conversation on screen, or null: only on its current (not historical)
 * occurrence. hold: the Desktop card's holdActivity; else derived from the browser page's one-off
 * row, or the row of the occurrence on screen. stateOf: placement.js agentState (passed in, as
 * placement imports this module).
 */
export function conversationHold(view, { hold = null, recoveryRow = null, occurrenceRows = null } = {}, stateOf) {
  if (!view || view.historical) return null
  if (hold) return hold
  if (recoveryRow) return holdActivity(stateOf(recoveryRow))
  const key = view.selectedOccurrence ?? view.currentOccurrence
  const row = (occurrenceRows ?? []).find(entry => entry?.task_id === view.taskId && entry.key === key)
  return row ? holdActivity(stateOf(row)) : null
}

/**
 * How many tasks Hermes has out per Reminders list ({ listId: count }), from the placed cards:
 * queued, running, asking, awaiting review, or a repeating series it still holds. Taking such a
 * list off the board ends that work (the reminder is no longer one Hermes may act on), so the
 * list picker asks for it to be stopped first.
 */
export function listsWithWork(cards) {
  const counts = {}
  for (const card of cards ?? []) {
    const status = card?.agent?.status
    // Work another Mac's Hermes has is not this one's to stop.
    if (card?.owner !== 'agent' || !status || status === 'done' || status === 'stopped' || status === 'elsewhere' || card.source?.completed) continue
    const list = card.source?.calendarId
    if (list) counts[list] = (counts[list] ?? 0) + 1
  }
  return counts
}

/**
 * The browser page's word for a task that is only waiting its turn. Admission parks queued work in
 * Hermes, which reports it as paused; the page has no card to say otherwise, so it reads its own
 * row (the one-off's, or the occurrence on screen). A source veto (guard paused) and rows the board
 * paused for a check are real pauses and keep their own words. null: nothing to correct.
 */
export function browserQueuedLabel(view, { recoveryRow = null, occurrenceRows = null } = {}) {
  if (!view || view.historical || (view.state !== 'paused' && view.state !== 'ready')) return null
  const key = view.selectedOccurrence ?? view.currentOccurrence
  const row = recoveryRow ?? (occurrenceRows ?? []).find(entry => entry?.task_id === view.taskId && entry.key === key)
  if (!row || row.guard?.status === 'paused' || row.stop_intent) return null
  // An unresolved failure (a retry, a check, a usage wait) is parked too, and is not a queue.
  if (currentRecovery(row, view.state)) return null
  if (row.held_reason === 'not_due' || row.guard?.status === 'waiting_due' || row.state === 'waiting_due') return 'Not due yet'
  const queued = row.state ? row.state === 'ready' : row.status === 'ready' || row.status === 'paused'
  return queued ? 'Queued' : null
}

/** How many Ready tasks activation would start. GET /delegation is a stored display read since #80
 *  (`stale: true`, `eligible: []`), so its list counts only on a fresh read; otherwise the board's
 *  own count of imported Ready reminders (envelope.ready_count). delegation: useDelegation's. */
export function readyCount(delegation, fallback = 0) {
  const data = delegation?.data
  return data?.status === 'ok' && !data.stale ? (delegation.eligible ?? []).length : fallback
}

/** Ready reminders activation would start, from the board's cards: imported Ready, open and one-off
 *  (the backend's `eligible` skips completed and repeating reminders). The fallback for
 *  readyCount where a count of tasks to start is meant. */
export function startableReady(cards) {
  // Placed cards say what Hermes already has: work that is out (a question, a result, running) or
  // was stopped is not started again by turning pickup on. Queued work is.
  return (cards ?? []).filter(card => card && card.column !== 'Done' && !card.source?.completed && !(card.source?.rules?.length) && ((card.imported_ready && !card.agent && !card.finishedBefore) || card.agent?.status === 'ready')).length
}
