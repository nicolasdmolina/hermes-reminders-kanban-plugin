// Repeating reminders and their delegated occurrences (tickets 21 and 23). Pure: no host imports.
// Contracts: reminders_kanban/api/occurrence-contract.md (This occurrence) and
// recurring-contract.md (Every occurrence).
//
// Apple reuses a repeating reminder's ID for the next occurrence and gives the completed one a
// new ID. So an occurrence row never belongs to "the reminder with this ID" for good:
// - work still in flight belongs to the reminder's current card (its own `expected.id`);
// - accepted work belongs to the completed copy Apple made (`completion.history_id`), in Done;
// - the next occurrence (same ID, new due date) gets no row at all. It stays the user's, and
//   only shows the earlier results as history. This occurrence's authority never carries forward.
// - Every occurrence: the backend's owner tick carries the series forward to Apple's verified next
//   occurrence as a new row (`predecessor`). Until that row exists the reminder's card shows the
//   series continuing; a series the backend held (`series_state: needs_reconciliation`) needs
//   you; one with no next occurrence (`series_state: ended`) is over. Nothing here decides any of it.
import { dueInfo } from './cards.js'
import { problemText } from './delegation-outcomes.js'
import { sourceIdFor } from './task-link.js'
import { STATUS } from './placement.js'
import { SOURCE_TEXT } from './reconciliation.js'
import { currentRecovery, recoveryView } from './recovery.js'

export const SCOPES = {
  this_occurrence: 'This occurrence',
  every_occurrence: 'Every occurrence'
}

export const isRecurring = card => Boolean(card?.recurring || card?.source?.rules?.length)

const rowsOf = occ => (occ?.status === 'ok' && Array.isArray(occ.tasks) ? occ.tasks : [])

/** Paused by a change in Reminders (date, repeat or notes), not by a Stop: before the owner answers
 *  (needs_reconciliation), or after they said the date moved (paused). */
/** Accepted, but the check-off in Reminders couldn't be confirmed: not a Reminders-change pause. */
export const acceptUnsure = row => row?.status === 'needs_reconciliation' && Boolean(row.accepted) && !row.stop_intent

export const sourcePaused = row =>
  Boolean(row) && !row.stop_intent && row.reason === 'source_occurrence_changed' && (row.status === 'needs_reconciliation' || row.status === 'paused')

/** An Every occurrence row admission holds until its due time (recurring-contract.md: `not_due`;
 *  the task's view reads `waiting_due`). It can't run yet, so it waits in To do. */
export const notDue = row =>
  Boolean(row) && row.status !== 'done' && row.status !== 'stopped' && (row.held_reason === 'not_due' || row.guard?.status === 'waiting_due' || row.state === 'waiting_due')

/** An accepted Every occurrence whose next occurrence the owner tick hasn't prepared yet (including
 *  a retryable wait to read Reminders, `series_state: waiting_source`). */
const awaitingSuccessor = (row, rows) =>
  row.scope === 'every_occurrence' &&
  row.status === 'done' &&
  [undefined, null, 'active', 'waiting_source'].includes(row.series_state) &&
  !rows.some(other => other.predecessor === row.key)

/** The owner question (occurrence-contract.md, "Owner answer for ambiguous advancement"): the date
 *  moved while a result waited, and Hermes can't tell a check-off from a moved date. */
export const advanceQuestion = row => row?.owner_question === 'checked_off_or_moved' && Boolean(row.source_accept_intent && row.advance_snapshot) && !row.accepted

/** A repeating reminder's review or question as its GET /occurrences row says (occurrence-contract.md,
 *  "Occurrence review and question attention"); the reply token still comes from GET /attention:
 *  { key, review, question } for the row running `taskId`; null when it isn't an occurrence (or
 *  this Hermes has no occurrences yet); undefined when the read failed and it can't tell. */
export function occurrenceAttention(occ, taskId) {
  if (occ?.status === 'setup_required') return null
  if (occ?.status !== 'ok' || !Array.isArray(occ.tasks)) return undefined
  const row = taskId ? rowsOf(occ).find(task => task.task_id === taskId) : null
  if (!row) return null
  return { key: row.key, review: row.review_available === true, question: row.required_action === 'reply' && row.state === 'question' }
}

/** Whether an occurrence's footer offers Stop: queued or running work (agent: agentState of its row).
 *  Never a question: the conversation's reply box answers it, as a one-off task's does, even
 *  while ticket 13's live attention read still says it runs (agentState lets live win until the
 *  two reads agree). */
export const occurrenceStoppable = (agent, row) =>
  Boolean(row?.task_id) && row.status !== 'question' && (agent?.column === 'Ready for Agent' || agent?.column === 'In progress')

/** POST /occurrences/actions resolve_advance for that question. answer: 'checked_off' | 'date_moved'. */
export const resolveRequest = (row, answer) => ({
  action: 'resolve_advance',
  occurrence_id: row.key,
  answer,
  intent_id: row.source_accept_intent,
  expected: row.advance_snapshot
})

/** POST /recurring/actions retry (recurring-contract.md) for an occurrence whose failed run the
 *  owner reconciled: the occurrence key and that run, never the reusable Apple ID. null when the
 *  row has no failed run to retry. */
export const retryRequest = row => (row?.key && row.recovery?.run_id != null ? { action: 'retry', occurrence_id: row.key, run_id: row.recovery.run_id } : null)

const RESOLVE_REFUSALS = {
  stale_advance: 'Reminders changed again. Check the date, then answer again.',
  history_contradicts_answer: "Reminders' history doesn't match that answer. Check it in Reminders.",
  advance_already_resolved: 'This was already answered',
  worker_still_alive: 'The last run is still stopping. Try again in a moment.',
  source_needs_reconciliation: 'The reminder changed in Reminders. Check it there.'
}

/** Plain words for a refused resolve_advance. */
export const resolveProblem = (answer, kind = null) => (!kind && RESOLVE_REFUSALS[answer?.reason]) || occurrenceProblem(answer, kind)

// Fields GET /occurrences adds to each row (its task view); ticks and actions answer bare rows.
const VIEW_FIELDS = ['state', 'recovery', 'waiting', 'required_action', 'stopped_at', 'work_before_stop', 'history', 'review_available']

/** Fresh bare rows over the cached GET rows: the row's own fields come from the answer (so a field
 *  the backend dropped, like an answered owner_question, is gone), the view fields stay. */
export function withViews(cached, fresh) {
  const byKey = new Map((cached ?? []).map(row => [row.key, row]))
  return (fresh ?? []).map(row => {
    const before = byKey.get(row.key)
    if (!before) return row
    const views = Object.fromEntries(VIEW_FIELDS.filter(field => field in before && !(field in row)).map(field => [field, before[field]]))
    return { ...row, ...views }
  })
}

const held = row => row?.status === 'paused' && row.guard?.status === 'active' && !row.stop_intent

/**
 * Hermes reports a new task held for admission as `paused` until a tick parks it in the queue, the
 * same state as a worker that paused itself. `fresh` maps the occurrence keys this board just
 * created (This occurrence, Run again) to when: those read Queued while held, not "waiting for an
 * owner check". Any other paused row keeps its state.
 */
export function queuedWhileHeld(occ, fresh) {
  if (!fresh?.size || !Array.isArray(occ?.tasks)) return occ
  return { ...occ, tasks: occ.tasks.map(row => (fresh.has(row.key) && held(row) ? { ...row, status: 'ready' } : row)) }
}

// The owner tick (every 20s) parks a held task or starts it. Past this, a paused row is a real
// pause (a worker can pause itself before any read sees it working), so it reads Paused again.
export const FRESH_MS = 45_000

/** The fresh keys still waiting: a key leaves once its row moves past the hold, or after FRESH_MS. */
export function stillHeld(occ, fresh, now = Date.now()) {
  const rows = new Map(rowsOf(occ).map(row => [row.key, row]))
  return new Map(
    [...fresh].filter(([key, at]) => now - at < FRESH_MS && (!rows.has(key) || held(rows.get(key)) || rows.get(key).status === 'ready'))
  )
}

/** The occurrence keys an answer's rows add to what the board had for one reminder (This
 *  occurrence's new row). Other reminders' rows in the same answer are not this action's. */
export function newKeys(before, answer, sourceId) {
  const known = new Set(rowsOf(before).map(row => row.key))
  return rowsOf(answer)
    .filter(row => row.key && !known.has(row.key) && idOf(row) === sourceId)
    .map(row => row.key)
}
const idOf = row => row?.expected?.id ?? row?.source?.id ?? null
const dueOf = row => row?.expected?.due ?? row?.source?.due ?? null
const stamp = due => (due ? due.year * 10000 + due.month * 100 + due.day : 0)

/** Occurrence rows in the shape placement.js reads, each with `match`: the card's reminder ID it
 *  belongs to. Accepted rows without a completed copy (nothing Apple made) place nowhere. */
export function occurrenceTasks(occ) {
  const rows = rowsOf(occ)
  // A row another one reran (rerun_of) is history: the card shows the new run.
  const rerun = new Set(rows.map(row => row.rerun_of).filter(Boolean))
  return rows.flatMap(row => {
    if (row.status === 'done') return row.completion?.history_id ? [{ ...row, match: row.completion.history_id }] : []
    if (rerun.has(row.key)) return []
    return [{ ...row, match: idOf(row) }]
  })
}

/** Ticket 13's /delegation read with the occurrence rows added, for placeCards. */
export function withOccurrenceTasks(delegation, occ) {
  const extra = occurrenceTasks(occ)
  if (!extra.length) return delegation
  return { ...(delegation ?? {}), tasks: [...(delegation?.tasks ?? []), ...extra], limits: delegation?.limits ?? occ?.limits ?? null }
}

/** One occurrence as the dialog and history list name it: its due date and where it stands. */
export function occurrenceEntry(row, now = new Date()) {
  const due = dueInfo(dueOf(row), now)
  return {
    key: row.key,
    taskId: row.task_id ?? null,
    date: due?.label ?? 'No date',
    overdue: Boolean(due?.overdue),
    status: row.status,
    // Paused by a Reminders change: the picker says Paused, as the card and the pill do.
    state: row.status === 'done' ? 'Accepted' : sourcePaused(row) || (row.status === 'needs_reconciliation' && !row.stop_intent && !acceptUnsure(row)) ? 'Paused' : notDue(row) ? 'Not started' : (recoveryLabel(row) ?? STATUS[liveStatus(row)]?.label ?? 'Check this task'),
    scope: row.scope ?? 'this_occurrence',
    series: row.authorization_id ?? null,
    ended: row.series_state === 'ended'
  }
}

const NOT_DUE = 'Not due yet'

// GET /occurrences adds each task's live view `state`; the row's own `status` is as of the last
// owner tick. A delivered result reads Review result at once, not Working until the next tick.
// waiting_source: Reminders couldn't be read (#74); it resumes by itself ("Waiting for Reminders").
const LIVE = new Set(['active', 'question', 'result', 'waiting_source'])
// Queued work is parked in Hermes (row status paused, live state ready): the picker says Queued, as the pill does.
const queuedLive = row => row.status === 'paused' && row.state === 'ready' && row.guard?.status === 'active'
const liveStatus = row => (queuedLive(row) ? 'ready' : LIVE.has(row.state) && !['stopped', 'needs_reconciliation', 'preparation_attention'].includes(row.status) ? row.state : row.status)

// A failed attempt's recovery names the occurrence while it applies ("Waiting for capacity"), as on
// its card; a new attempt that runs, asks or delivers replaces it.
// Ticket 17's names (lib/recovery.js), the same as on the card and the dialog's pill.
const recoveryLabel = row => recoveryView(currentRecovery(row))?.label ?? null

/** Every delegated occurrence of one series, oldest first. */
function seriesRows(occ, series) {
  const rows = rowsOf(occ)
  // A rerun, or Keep going on a held series, starts a new authorization; its history still includes
  // the run it replaced (rerun_of) or the occurrence it follows (predecessor), and the other way
  // round. Walk both links until nothing new joins.
  const linked = new Set(series ? [series] : [])
  for (let grew = true; grew; ) {
    grew = false
    for (const row of rows) {
      const before = rows.find(other => other.key === row.rerun_of || (row.predecessor && other.key === row.predecessor))
      const pair = before ? [row.authorization_id, before.authorization_id] : []
      if (pair.some(id => linked.has(id)) && pair.some(id => !linked.has(id))) {
        pair.forEach(id => linked.add(id))
        grew = true
      }
    }
  }
  return rows
    .filter(row => linked.has(row.authorization_id))
    .sort((a, b) => stamp(dueOf(a)) - stamp(dueOf(b)) || (a.rerun_of === b.key ? 1 : b.rerun_of === a.key ? -1 : 0))
}

/**
 * How "Run again" can go for this occurrence, checked before asking (occurrence-contract.md,
 * "Explicit rerun"; delegation-contract.md, "Owner confirmation before rerun"):
 * - 'run': no Hermes run happened yet, or the owner already confirmed the latest one; send rerun.
 * - 'confirm': Hermes did work; the owner first accepts that running again may repeat it
 *   (Stop a paused one, confirm_rerun on its latest finished run, then rerun).
 * - null: it can't run again here (not stopped or paused by a change in Reminders, the reminder no
 *   longer repeats with a due date, a completion is pending, or its runs aren't known yet).
 * runs: the task's runs if the row doesn't carry them (the conversation's attempts).
 * current: the reminder now.
 */
export function rerunMode(row, runs = null, current = null) {
  if (!row?.scope || row.accept_intent || row.accepted) return null
  // A completion Hermes may have started (a source check-off it couldn't reconcile) blocks every
  // rerun and confirmation, so offering it would only stop the work and then refuse.
  if (row.completion && row.completion.status !== 'completed') return null
  if (advanceQuestion(row)) return null
  if (!current || current.completed || !current.due || !current.rules?.length) return null
  if (row.status !== 'stopped' && !sourcePaused(row)) return null
  if (row.status === 'stopped' && row.rerun_reconciliation) return 'run'
  const seen = row.work_before_stop?.runs ?? row.stop_receipt?.runs ?? runs
  if (!Array.isArray(seen)) return null
  return seen.length ? 'confirm' : 'run'
}

/** The run a confirmation binds to: the latest one, once it has ended (else null). */
export function confirmableRun(work) {
  const latest = (work?.runs ?? []).at(-1)
  return latest?.ended_at ? latest.id : null
}

/**
 * Cards with `occurrence` set where a repeating reminder has delegated history:
 * { role: 'delegated' | 'history' | 'successor', key, entry, scope, history }.
 * - delegated: this card is the occurrence Hermes has now (`key` is its occurrence).
 * - history: this card is an accepted occurrence's completed copy, in Done.
 * - successor: the reminder's next occurrence. Not delegated; `key` is the latest earlier one.
 * history: the series' other occurrences, oldest first (occurrenceEntry shapes).
 */
export function withOccurrences(cards, occ, now = new Date()) {
  const rows = rowsOf(occ)
  if (!rows.length) return cards ?? []
  // One pass builds each series' history and each row's entry once. A long-running daily series
  // has a Done card per past occurrence, and rebuilding the whole history for every one of them
  // froze the board for seconds.
  const seriesCache = new Map()
  const seriesOf = id => {
    if (!seriesCache.has(id)) seriesCache.set(id, seriesRows(occ, id))
    return seriesCache.get(id)
  }
  const entryCache = new Map()
  const entryOf = row => {
    if (!entryCache.has(row)) entryCache.set(row, occurrenceEntry(row, now))
    return entryCache.get(row)
  }
  return (cards ?? []).map(card => {
    const row = card.agent?.row
    if (row?.scope) {
      const series = seriesOf(row.authorization_id)
      // A Reminders change paused it: the card, the dialog pill and its notice all say Paused.
      // (An uncertain Stop keeps ticket 13's own label.)
      const paused = (row.status === 'needs_reconciliation' && !row.stop_intent && !acceptUnsure(row)) || sourcePaused(row)
      // Every occurrence before its due time: Hermes has it, but it can't run until then.
      // GET /attention may read it live as waiting_due before the row carries the marker.
      const waiting = !paused && (notDue(row) || card.agent?.status === 'waiting_due')
      const agent = paused
        ? { ...card.agent, label: 'Paused', tone: 'attention' }
        : waiting
          ? // Queued until its date: the card and pill say Not due yet, the thread's line says when.
            { ...card.agent, status: 'ready', column: 'To do', label: NOT_DUE, line: `Starts ${entryOf(row).date}`, tone: 'agent', action: null, waiting: false, notDue: true }
          : card.agent
      return {
        ...card,
        column: waiting && !card.source?.completed ? 'To do' : card.column,
        agent,
        occurrence: {
          role: row.status === 'done' ? 'history' : 'delegated',
          key: row.key,
          scope: row.scope,
          // The task's stored binding: Desktop opens it when the reminder has no written link.
          destination: row.destination ?? null,
          entry: entryOf(row),
          history: series.filter(other => other.key !== row.key).map(other => entryOf(other))
        }
      }
    }
    if (card.agent) return card
    const earlier = rows.filter(other => idOf(other) === card.source?.id && other.status === 'done')
    if (!earlier.length) return card
    // The latest is the one nothing follows (Keep going or Run again may move to an earlier date),
    // then by date.
    const followed = new Set(rows.flatMap(other => [other.predecessor, other.rerun_of]).filter(Boolean))
    const leaves = earlier.filter(other => !followed.has(other.key))
    const latest = (leaves.length ? leaves : earlier).sort((a, b) => stamp(dueOf(a)) - stamp(dueOf(b))).at(-1)
    const occurrence = {
      role: 'successor',
      key: latest.key,
      scope: null,
      destination: latest.destination ?? null,
      entry: null,
      history: seriesOf(latest.authorization_id).map(other => entryOf(other))
    }
    // Every occurrence still holds this reminder: the next one is on its way (the owner tick
    // prepares it, or retries reading Reminders), or the backend held the series for you to decide.
    // Either way it isn't yours to delegate again, and Delegate would be refused. Once you end the
    // series (authorization_ended) it is yours again, with its history.
    const held = latest.scope === 'every_occurrence' && latest.series_state === 'needs_reconciliation'
    const reading = latest.scope === 'every_occurrence' && latest.series_state === 'waiting_source'
    // Stop repeating with Hermes: the reminder is yours again, in To do, with its history, even if
    // its title carries an agent marker or its repeat was removed while the series was held.
    if (latest.series_state === 'authorization_ended') {
      return { ...card, owner: 'human', column: card.source?.completed || card.column === 'In progress' ? card.column : 'To do', occurrence }
    }
    // A held series needs you even if its repeat was removed in Reminders since.
    if (!held && !isRecurring(card)) return card
    if (!held && !(latest.scope === 'every_occurrence' && awaitingSuccessor(latest, rows))) return { ...card, occurrence }
    const series = {
      key: latest.key,
      scope: 'every_occurrence',
      status: held ? 'series_held' : reading ? 'series_waiting' : 'series_next',
      series_state: latest.series_state ?? null,
      held_reason: latest.held_reason ?? null,
      hold_id: latest.hold_id ?? null,
      authorization_id: latest.authorization_id,
      destination: latest.destination ?? null
    }
    const state = held
      ? { column: 'Needs you', label: SERIES_HELD, tone: 'danger', action: 'reconcile' }
      : reading
        ? { column: 'In progress', label: SERIES_READING, tone: 'running', action: null }
        : { column: 'To do', label: 'Up next', tone: 'agent', action: null }
    return {
      ...card,
      owner: 'agent',
      column: card.source?.completed ? card.column : state.column,
      agent: { ...state, status: series.status, waiting: false, queueIndex: null, nextCheckAt: null, row: series },
      occurrence: { ...occurrence, role: 'series', scope: 'every_occurrence' }
    }
  })
}

const SERIES_HELD = 'Needs a decision'
export const SERIES_READING = 'Waiting for Reminders'

// recurring-contract.md: a rejected carry-forward keeps its reason in `held_reason` (a sentence
// from the owner, or a native helper code).
const SERIES_REASONS = [
  [/successor needs reconciliation/i, 'The next occurrence changed in Reminders'],
  [/changed_instructions/, "The reminder's notes changed in Reminders"],
  [/conflicting_or_missing_history/, "Reminders' history doesn't match what Hermes saw"],
  [/no authorized successor|source_not_advanced/i, "Hermes can't confirm the last occurrence was checked off"],
  [/copied_link|conflicting_links/, 'Another reminder has the same task link'],
  [/missing_identity|not_found/, "Hermes can't find this reminder"],
  [/identity_replaced/, 'The reminder was replaced in Reminders'],
  [/multiple_candidates/, 'More than one reminder matches this one'],
  [/^conflict$/, 'The reminder changed in Reminders'],
  [/access|denied|helper|timed out|unavailable/i, "Hermes couldn't read Reminders"]
]

/** Why the backend held an Every occurrence series, in plain words. */
export function seriesHeldText(row) {
  const reason = String(row?.held_reason ?? '')
  return SERIES_REASONS.find(([pattern]) => pattern.test(reason))?.[1] ?? "Hermes can't match the next occurrence"
}

/** Whether this card's reminder is held by Every occurrence (the series continues or waits for you). */
export const inSeries = card => card?.occurrence?.role === 'series'

/** POST /recurring/actions resolve_series for a held series (recurring-contract.md, "Owner
 *  resolution of a held series"). decision: 'end' (stop repeating with Hermes) or 'reauthorize'
 *  (keep going under the reminder's current instructions, confirming the held cause).
 *  expected: the reminder's complete current snapshot (GET current). */
export const resolveSeriesRequest = (row, decision, expected) => ({
  action: 'resolve_series',
  occurrence_id: row.key,
  hold_id: row.hold_id,
  decision,
  expected,
  ...(decision === 'reauthorize' ? { confirmed_cause: row.held_reason } : {})
})

const SERIES_REFUSALS = {
  stale_hold: 'This changed since it was shown. Check it again.',
  stale_source: 'The reminder changed in Reminders. Check it, then try again.',
  series_already_resolved: 'This was already decided'
}
const SERIES_ATTENTION = [
  [/history needs reconciliation/, "Reminders' history doesn't match. Check it in Reminders."],
  [/source needs reconciliation/, 'The reminder changed in Reminders. Check it there.'],
  [/confirm held cause|pending recurring snapshot/, 'Only a repeating reminder with a due date can keep going']
]

/** Plain words for a refused resolve_series (or a transport failure `kind`). */
export function resolveSeriesProblem(answer, kind = null) {
  if (!kind && SERIES_REFUSALS[answer?.reason]) return SERIES_REFUSALS[answer.reason]
  if (!kind && answer?.status === 'attention') {
    const known = SERIES_ATTENTION.find(([pattern]) => pattern.test(String(answer.reason ?? '')))
    if (known) return known[1]
  }
  return occurrenceProblem(answer, kind)
}

/** A stopped occurrence whose reminder has since moved to its next date (checked off by hand: Apple
 *  reuses the reminder). The card is that next occurrence now: its own date, not the stopped one's. */
const movedOnFromStop = card => {
  const occurrence = card?.occurrence
  if (occurrence?.role !== 'delegated' || card.agent?.row?.status !== 'stopped' || !occurrence.entry) return false
  const now = dueInfo(card.source?.due)?.label
  return Boolean(now && now !== occurrence.entry.date)
}

/** The card's repeat marker: which occurrence went to Hermes, or plain "Repeats". */
export function repeatLabel(card) {
  const occurrence = card?.occurrence
  if (movedOnFromStop(card)) return 'Repeats'
  if (occurrence?.role === 'delegated' || occurrence?.role === 'history' || occurrence?.role === 'series') return SCOPES[occurrence.scope] ?? SCOPES.this_occurrence
  return isRecurring(card) ? 'Repeats' : null
}

/** The card's date pill for an occurrence Hermes has or had: its own date, "Nov 7 · This occurrence"
 *  (the reminder may have moved on since). null for anything else; the card shows its due date. */
export function occurrenceDateLabel(card) {
  const occurrence = card?.occurrence
  if (occurrence?.role !== 'delegated' || !occurrence.entry || movedOnFromStop(card)) return null
  return `${occurrence.entry.date} · ${SCOPES[occurrence.scope] ?? SCOPES.this_occurrence}`
}

/** An accepted occurrence's copy in Done says which occurrence it was: "Nov 6 · This occurrence",
 *  or "Nov 8 · Last occurrence" when Every occurrence ended with it (Apple has no next one). */
export function doneOccurrenceLabel(card) {
  const occurrence = card?.occurrence
  if (occurrence?.role !== 'history') return null
  return `${occurrence.entry.date} · ${occurrence.entry.ended ? 'Last occurrence' : (SCOPES[occurrence.scope] ?? SCOPES.this_occurrence)}`
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

// Shared with one-off cards (reconciliation.js), so a reason reads the same everywhere.
const PAUSED = SOURCE_TEXT

/** What paused a delegated occurrence, as the dialog's notice line: what changed in Reminders,
 *  with both dates when the due date moved ("Due date moved from Nov 7 to Nov 8").
 *  row: its occurrence row (`reason`, and `source` as delegated); current: the reminder now. */
export function pauseText(row, current, now = new Date()) {
  if (PAUSED[row?.reason]) return PAUSED[row.reason]
  // The owner question names both dates the backend saw.
  if (row?.old_due && row?.new_due) {
    const from = dueInfo(row.old_due, now)?.label
    const to = dueInfo(row.new_due, now)?.label
    if (from && to && from !== to) return `Due date moved from ${from} to ${to}`
  }
  const before = row?.source ?? row?.expected
  if (before && current) {
    if (!same(before.due, current.due)) {
      const from = dueInfo(before.due, now)?.label
      const to = dueInfo(current.due, now)?.label
      if (from && to) return `Due date moved from ${from} to ${to}`
      return to ? `Due date moved to ${to}` : 'Due date removed in Reminders'
    }
    if (!same(before.rules, current.rules)) return 'Repeat changed in Reminders'
  }
  return 'The reminder changed in Reminders'
}

/** The picker's labels with the occurrence the conversation shows named by its own live state,
 *  the same source as the dialog's pill ("Result ready"), so the two never disagree while the
 *  stored occurrence read lags a tick. view: the conversation's resolved task view. */
export function pickerLabels(labels, view) {
  const key = view?.selectedOccurrence
  const shown = key && labels?.[key]
  if (!shown || view.historical || !LIVE.has(view.state) || !view.info?.label) return labels
  return { ...labels, [key]: { ...shown, state: view.info.label, text: `${shown.date} · ${view.info.label}` } }
}

/** The history line above an earlier entry the picker selected: "Earlier occurrence · Nov 8" for a
 *  repeating reminder, "Earlier run" for a one-off (whose entries are runs; with the date if known). */
export const earlierLabel = (date, repeating = true) => `Earlier ${repeating ? 'occurrence' : 'run'}${date ? ` · ${date}` : ''}`

/** What the occurrence picker calls each entry, in the order given: its dated label when the
 *  board or /occurrences knows it, otherwise its place. Earlier entries are numbered among
 *  themselves, wherever the current one sits, so one earlier entry is always "Earlier … 1". A
 *  one-off reminder's entries are its runs (Run again adds one under the same task link), so
 *  they read "Current run" and "Earlier run N", not occurrences. */
export function pickerTexts(labels, entries, repeating = true) {
  const noun = repeating ? 'occurrence' : 'run'
  const earlier = entries.filter(entry => !entry.current)
  return entries.map(
    entry => labels?.[entry.id]?.text ?? (entry.current ? `Current ${noun}` : `Earlier ${noun} ${earlier.length - earlier.indexOf(entry)}`)
  )
}

/** Picker and badge labels for a task's occurrences, keyed by occurrence ID: "Nov 6 · Accepted". */
export function occurrenceLabels(occ, now = new Date()) {
  const labels = {}
  for (const row of rowsOf(occ)) {
    const entry = occurrenceEntry(row, now)
    labels[row.key] = { date: entry.date, state: entry.state, text: `${entry.date} · ${entry.state}` }
  }
  return labels
}

/** The reminder's complete current snapshot from GET /occurrences `current` (what Run again sends). */
export const currentSnapshot = (occ, card) => (occ?.current ?? []).find(source => source?.id === card?.source?.id) ?? null

/** Whether the owner tick has work to observe (anything delegated that hasn't finished: accepted,
 *  stopped or deleted). An uncertain Stop is needs_reconciliation, so ticks keep checking it. An
 *  accepted Every occurrence keeps it ticking until its next occurrence is prepared or the series
 *  ends or is held: acceptance seen in Reminders lands after that tick's carry-forward. */
export const hasOutstanding = occ => {
  const rows = rowsOf(occ)
  return rows.some(row => !['done', 'stopped', 'deleted'].includes(row.status) || awaitingSuccessor(row, rows))
}

const shown = (tone, short, message) => ({ tone, short, message, replay: false, action: null })

const ATTENTION = [
  [/inherited link/, "Has another task's link. Remove that line in Reminders first."],
  [/successor needs reconciliation/, "Can't match it to the last occurrence. Check it in Reminders."],
  [/changed or ambiguous source|source changed/, 'The reminder changed in Reminders. Try again.'],
  [/full identity required/, 'A repeating reminder needs a due date before Hermes can take it.'],
  [/different scope/, 'This occurrence is already delegated another way.'],
  [/ongoing series/, 'Hermes already has every occurrence of this reminder.'],
  [/unknown occurrence/, "Hermes doesn't know this occurrence. Refresh and try again."],
  [/external effects need reconciliation/, 'Hermes needs the last run checked before it runs again'],
  [/worker still alive/, 'The last run is still stopping. Try again in a moment.'],
  [/completion needs reconciliation/, 'This reminder may already be completed. Check it in Reminders.'],
  [/source identity or eligibility/, 'The reminder was replaced or left the board'],
  [/stopped occurrence required|source needs reconciliation/, "This occurrence can't run again"],
  [/stale_run/, 'Hermes ran again since this was shown. Check what it did, then try again'],
  [/attempt requires reconciliation/, "Hermes couldn't retry this yet"],
  [/verified_stop_required/, "Hermes hasn't finished stopping. Try again in a moment"]
]

/** Plain words for a non-ok POST /occurrences/actions answer (or a transport failure `kind`). */
export function occurrenceProblem(answer, kind = null) {
  if (!kind && answer?.status === 'needs_reconciliation') return "Hermes couldn't confirm the last run stopped. It stays here until that's checked"
  if (!kind && answer?.status === 'attention') {
    const reason = String(answer.reason ?? '')
    const known = ATTENTION.find(([pattern]) => pattern.test(reason))
    if (known) return known[1]
  }
  return problemText(answer, kind)
}

const READY = new Set(['preparing', 'preparation_attention', 'ready', 'active', 'question', 'result', 'paused'])

/**
 * What a This occurrence action answer means for the card that asked, in ticket 10's
 * { result: { status }, shown, message } shape. ready reads the reminder's open occurrence (never an
 * accepted earlier one with the same ID); accept reads its own occurrence by key.
 */
export function occurrenceOutcome(answer, action, { sourceId = null, key = null } = {}, kind = null) {
  const fail = message => ({ result: { status: 'failed' }, shown: shown('error', short(message), message), message })
  if (kind || answer?.status !== 'ok') return fail(occurrenceProblem(answer, kind))
  const rows = rowsOf(answer)
  if (action === 'rerun') {
    const task = answer.task
    if (task && READY.has(task.status)) {
      const date = occurrenceEntry(task).date
      return { result: { status: 'ok' }, shown: shown('ok', 'Running again', `Running again for ${date}.`), message: `Running again for ${date}.`, task }
    }
    return fail("Couldn't run it again. Try again.")
  }
  if (action === 'accept') {
    const row = rows.find(task => task.key === key)
    if (row?.status === 'done' && row.completion?.status === 'completed') return { result: { status: 'ok' }, shown: shown('ok', 'Accepted', 'Accepted.') }
    if (row?.status === 'needs_reconciliation') {
      return { result: { status: 'pending' }, shown: shown('warn', 'Hermes is checking it', "Accepted in Hermes, but the reminder isn't completed yet. Hermes needs to check it.") }
    }
    return fail("Couldn't accept yet. Try again.")
  }
  if (action === 'retry') {
    if (rows.some(task => task.key === key)) return { result: { status: 'ok' }, shown: shown('ok', 'Retrying', 'Retry started.'), message: 'Retry started.' }
    return fail("Hermes couldn't retry this yet")
  }
  const open = rows.filter(task => idOf(task) === sourceId && task.status !== 'done').at(-1)
  if (open && READY.has(open.status) && action === 'every') {
    if (open.scope !== 'every_occurrence') return fail('This occurrence is already delegated another way.')
    return { result: { status: 'ok' }, shown: shown('ok', 'Delegated', 'Delegated every occurrence.'), message: 'Delegated every occurrence.', task: open }
  }
  if (open && READY.has(open.status)) {
    return { result: { status: 'ok' }, shown: shown('ok', 'Delegated', `Delegated this occurrence (${occurrenceEntry(open).date}).`) }
  }
  return fail("Couldn't hand it to Hermes. Try again.")
}

// Card notices are one short line; the full sentence goes to the screen reader.
function short(message) {
  const first = message.split('. ')[0].replace(/\.$/, '')
  return first.length <= 44 ? first : `${first.slice(0, 41).trimEnd()}…`
}

/**
 * Where Accept goes for the task behind a link: ticket 13's one-off route, or this occurrence's.
 * api: { get(path) } resolving JSON. Returns [path, body] or null when neither knows the task.
 */
export async function acceptRequest(api, taskId, { task, occurrence, occurrenceTaskId } = {}) {
  if (task?.task_id === taskId && !task.scope && task.expected?.id) {
    return ['/delegation/actions', { action: 'accept', expected: { id: task.expected.id } }]
  }
  if (occurrenceTaskId === taskId && occurrence?.key && occurrence.review) {
    return ['/occurrences/actions', { action: 'accept', occurrence_id: occurrence.key }]
  }
  const [single, occ] = await Promise.allSettled([api.get('/delegation'), api.get('/occurrences')])
  const sourceId = single.status === 'fulfilled' ? sourceIdFor(single.value, taskId) : null
  if (sourceId) return ['/delegation/actions', { action: 'accept', expected: { id: sourceId } }]
  const row = occ.status === 'fulfilled' ? rowsOf(occ.value).find(task => task.task_id === taskId) : null
  if (row) return ['/occurrences/actions', { action: 'accept', occurrence_id: row.key }]
  if (single.status === 'rejected') throw single.reason
  return null
}
