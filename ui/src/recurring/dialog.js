// What the task dialog says about a repeating reminder's occurrence (tickets 21 and 23). Pure.

import { dueInfo } from '../lib/cards.js'
import { acceptUnsure, notDue, pauseText, SCOPES, SERIES_READING, seriesHeldText, sourcePaused } from '../lib/occurrences.js'

/**
 * What TaskDialog passes to the conversation for a repeating reminder's occurrence:
 * - yours: the card is the reminder's next occurrence. Hermes has none of it; the dialog says You
 *   and shows the reminder's column, not the earlier task's state.
 * - key: the occurrence the conversation opens (this one's, or the latest earlier result's).
 * - pill: a meta pill naming which occurrence went to Hermes, with its date, like the card
 *   ("Nov 7 · This occurrence"), whether or not the reminder's date has moved since.
 * - earlier: for the next occurrence, the date of the earlier one its conversation shows.
 * - upcoming: for the next occurrence, the line under that history ("Nov 8 · Not started"; under
 *   Every occurrence "Nov 8 · Up next"), or "No more repeats" after a series' last occurrence.
 * - paused: the notice line for an occurrence a Reminders change paused (pauseText), or why
 *   Run again was refused.
 * - previous: the run a Run again replaced ({ key, date }), shown as history above the new one.
 * - labels: what the board already knows to call each occurrence, before the dialog's own read.
 */
export function occurrenceDialog(card, now = new Date()) {
  const occurrence = card?.occurrence
  const none = { yours: false, key: null, pill: null, earlier: null, upcoming: null, paused: null, previous: null, labels: null }
  if (!occurrence) return none
  const labels = Object.fromEntries(
    [occurrence.entry, ...occurrence.history].filter(Boolean).map(entry => [entry.key, { date: entry.date, state: entry.state, text: `${entry.date} · ${entry.state}` }])
  )
  if (occurrence.role === 'successor' || occurrence.role === 'series') {
    const shown = occurrence.history.find(entry => entry.key === occurrence.key)
    const next = dueInfo(card.source?.due, now)?.label
    if (occurrence.role === 'series') {
      // Every occurrence still holds the reminder: its next occurrence is on its way, or held.
      // Held: the line after that history says why the series can't continue.
      const status = card.agent?.row?.status
      const state = status === 'series_held' ? seriesHeldText(card.agent.row) : status === 'series_waiting' ? SERIES_READING : card.agent?.pickupOff ? card.agent.label : 'Up next'
      return { ...none, key: occurrence.key, earlier: shown?.date ?? true, upcoming: next ? `${next} · ${state}` : state, pill: { label: SCOPES.every_occurrence, tone: 'agent' }, labels }
    }
    return { ...none, yours: true, key: occurrence.key, earlier: shown?.date ?? true, upcoming: next ? `${next} · Not started` : 'Not started', labels }
  }
  const scope = SCOPES[occurrence.scope] ?? SCOPES.this_occurrence
  const row = card.agent?.row
  // Keep going just made this occurrence's row and Hermes hasn't linked a task to it yet: there is
  // no conversation to open, so show the one it follows, with this one as the line after it.
  const followed = !row?.task_id && row?.predecessor ? occurrence.history.find(entry => entry.key === row.predecessor) : null
  if (followed) {
    const state = card.agent?.label ?? 'Up next'
    return { ...none, key: followed.key, earlier: followed.date ?? true, upcoming: occurrence.entry ? `${occurrence.entry.date} · ${state}` : state, pill: { label: scope, tone: 'agent' }, labels }
  }
  const paused = occurrence.refusal ?? ((row?.status === 'needs_reconciliation' && !row.stop_intent && !acceptUnsure(row)) || sourcePaused(row) ? pauseText(row, card.source, now) : null)
  const before = row?.rerun_of ? occurrence.history.find(entry => entry.key === row.rerun_of) : null
  // The run this one replaced (Run again). An accepted occurrence it merely follows is not an
  // earlier run of this one: it has its own entry in the picker.
  const previous = before && before.status !== 'done' ? { key: before.key, date: before.date } : null
  const upcoming = occurrence.role === 'history' && occurrence.entry?.ended ? 'No more repeats' : null
  return { ...none, key: occurrence.key, pill: { label: occurrence.entry ? `${occurrence.entry.date} · ${scope}` : scope, tone: 'agent' }, paused, previous, upcoming, labels }
}

// placement.js tones → the dialog StatusPill's tones.
const PILL_TONES = { agent: 'agent', running: 'active', attention: 'attention', danger: 'danger', done: 'done', muted: 'muted' }

/**
 * The dialog's status pill when the board knows a state the Hermes task can't. It names the state
 * and leaves the detail to the thread's activity line, so the two never repeat each other:
 * - queued work (the held task reads Paused), including a capacity wait: "Queued";
 * - Every occurrence before its due time, or between occurrences: the card's label ("Not due yet",
 *   "Up next", "Waiting for Reminders"); a series the backend held: "Needs a decision";
 * - work the board paused for a check (needs_reconciliation, preparation_attention): the card's label;
 * - a task held on its reminder or waiting for Reminders (ticket 25): the card's label.
 * Otherwise null, and the conversation keeps the task's own pill (Working, Result ready, ...).
 */
export function boardPill(card) {
  const agent = card?.agent
  if (!agent) return null
  if (agent.notDue || ['series_next', 'series_held', 'series_waiting'].includes(agent.status) || notDue(agent.row)) return { label: agent.label, tone: PILL_TONES[agent.tone] ?? 'muted' }
  if (agent.status === 'needs_reconciliation' || agent.status === 'preparation_attention') return { label: agent.label, tone: PILL_TONES[agent.tone] ?? 'muted' }
  // A one-off paused by a change in Reminders that only Stop gets out of: the card's words ("Instructions changed").
  if (agent.status === 'paused' && agent.action === 'reconcile' && !agent.row?.scope) return { label: agent.label, tone: PILL_TONES[agent.tone] ?? 'attention' }
  // A task held on its reminder, or waiting for Reminders (ticket 25): the card's words, not "Paused".
  if (agent.action === 'held') return { label: agent.label, tone: 'attention' }
  if (agent.action === 'source_wait') return { label: agent.label, tone: 'muted' }
  // A failed run that needs you (a check, funds, a sign-in): the card's words, never "Queued".
  if (agent.recovery && agent.recovery.action !== 'wait') return { label: agent.label, tone: PILL_TONES[agent.tone] ?? 'attention' }
  // Queued work includes a capacity wait, which sits in In progress ("Waiting for capacity").
  if (agent.column === 'Ready for Agent' || agent.status === 'ready' || agent.waiting) return { label: 'Queued', tone: 'agent' }
  return null
}
