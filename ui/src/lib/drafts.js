// Create/edit form drafts, request bodies and outcome copy for human actions.
// Pure: no host imports. Contract: reminders_kanban/api/human-contract.md and
// reminders_kanban/reminders/CONTRACT.md (due components, priority values).

import { notesWithoutLink } from './task-link.js'
import { ACCESS } from './access.js'

/** Apple Reminders priorities the backend accepts: none, high, medium, low. */
export const PRIORITIES = [
  { value: 0, label: 'None' },
  { value: 9, label: 'Low' },
  { value: 5, label: 'Medium' },
  { value: 1, label: 'High' }
]

// Native priority 1-4 is high, 5 medium, 6-9 low (preview cards keep the raw value).
const nearestPriority = value => (!value ? 0 : value <= 4 ? 1 : value === 5 ? 5 : 9)

const pad = value => String(value).padStart(2, '0')

/** Form fields read from a source snapshot. */
export function draftFromSource(source) {
  const due = source?.due
  const hasDate = due && due.year != null && due.month != null && due.day != null
  return {
    title: source?.title ?? '',
    notes: source?.notes ?? '',
    calendarId: source?.calendarId ?? '',
    date: hasDate ? `${due.year}-${pad(due.month)}-${pad(due.day)}` : '',
    time: hasDate && due.hour != null ? `${pad(due.hour)}:${pad(due.minute ?? 0)}` : '',
    priority: nearestPriority(source?.priority),
    // Text to add after the existing notes when notes are append-only.
    notesAdd: ''
  }
}

/** Notes after appending `addition` on a new line. The original stays the exact prefix. */
export function appendNotes(original, addition) {
  const before = original ?? ''
  if (!addition.trim()) return before
  if (!before) return addition
  return before.endsWith('\n') ? before + addition : `${before}\n${addition}`
}

/** The draft as it would be saved: append-only notes folded into `notes`. */
export const effectiveDraft = (draft, notesMode) =>
  notesMode === 'append' && draft.notesAdd ? { ...draft, notes: appendNotes(draft.notes, draft.notesAdd) } : draft

export const emptyDraft = calendarId => ({ title: '', notes: '', calendarId: calendarId ?? '', date: '', time: '', priority: 0, notesAdd: '' })

export const FIELDS = ['title', 'notes', 'calendarId', 'due', 'priority']

const dueKey = draft => `${draft.date}|${draft.time}`
// Notes are compared without the claim line (which Hermes has the reminder): one coming or going
// is not a change to the person's notes.
const fieldChanged = (a, b, field) =>
  field === 'due' ? dueKey(a) !== dueKey(b) : field === 'notes' ? notesWithoutLink(a.notes) !== notesWithoutLink(b.notes) : a[field] !== b[field]

/** Native due components for the draft, or null without a date. Timed dates carry the zone. */
export function dueFromDraft(draft, timeZone) {
  if (!draft.date) return null
  const [year, month, day] = draft.date.split('-').map(Number)
  const due = { calendar: 'gregorian', year, month, day }
  if (!draft.time) return due
  const [hour, minute] = draft.time.split(':').map(Number)
  return { ...due, hour, minute, timeZone }
}

export function withDueDate(draft, date) {
  return { ...draft, date, time: date ? draft.time : '' }
}

// Without advertised modes, keep the pre-ticket-31 gate: same date type, never cleared.
const legacyDueModes = base =>
  base.date ? { all_day: !base.time, timed: Boolean(base.time), clear: false } : { all_day: true, timed: true, clear: true }

/**
 * Why a due edit can't be saved here, or null. `modes` is the card's
 * `capabilities.due_modes` (human-contract.md): which resulting due shapes keep the
 * reminder's start time zone. An unchanged due is always fine.
 */
export function dueModeError(base, draft, modes) {
  if (!base || !fieldChanged(base, draft, 'due') || (draft.time && !draft.date)) return null
  const allowed = modes ?? legacyDueModes(base)
  if (!draft.date) return allowed.clear ? null : allowed.clear_reason || 'Clear this date in Apple Reminders'
  if (draft.time) return allowed.timed ? null : base.time ? 'Change the time in Apple Reminders' : 'Add a time in Apple Reminders'
  return allowed.all_day ? null : 'Remove the time in Apple Reminders'
}

/** Field errors keyed by field. `labels` are the board's configured agent title labels. */
export function validateDraft(draft, { mode = 'create', base = null, labels = null, dueModes = null } = {}) {
  const errors = {}
  const title = draft.title.trim()
  if (!title) errors.title = 'Add a title'
  // Checked as it is saved (trimmed): a space before the label must not slip an agent label through.
  // An edit that leaves the title alone doesn't send it, so it isn't judged.
  else if ((mode !== 'edit' || !base || draft.title !== base.title) && Object.values(labels ?? {}).some(label => label && title.startsWith(label))) {
    errors.title = `Titles starting with ${Object.values(labels).find(label => label && title.startsWith(label))} are agent tasks`
  }
  if (!draft.calendarId) errors.calendarId = 'Choose a list'
  if (draft.time && !draft.date) errors.due = 'Pick a date for this time'
  if (mode === 'edit' && base) {
    // List moves are standalone edits (human-contract.md, move_separately).
    const others = ['title', 'notes', 'priority', 'due'].some(field => fieldChanged(base, draft, field))
    if (draft.calendarId !== base.calendarId && others) errors.calendarId = 'Save your other changes first, then change the list'
    const due = dueModeError(base, draft, dueModes)
    if (due) errors.due = due
  }
  return errors
}

/** `fields` for a create request. */
export function createFields(draft, timeZone) {
  const fields = { title: draft.title.trim(), calendarId: draft.calendarId }
  if (draft.notes.trim()) fields.notes = draft.notes
  if (draft.priority) fields.priority = draft.priority
  const due = dueFromDraft(draft, timeZone)
  if (due) fields.due = due
  return fields
}

/** Only the fields the user changed from `base` (the form as it opened). */
export function editFields(base, draft, timeZone) {
  const fields = {}
  for (const field of FIELDS) {
    if (!fieldChanged(base, draft, field)) continue
    if (field === 'due') fields.due = dueFromDraft(draft, timeZone)
    else if (field === 'title') fields.title = draft.title.trim()
    else fields[field] = draft[field]
  }
  return fields
}

/** Fields that differ between two source snapshots, for "changed in Apple Reminders". */
export function sourceChanges(before, after) {
  if (!before) return []
  if (!after) return ['gone']
  const a = draftFromSource(before)
  const b = draftFromSource(after)
  const changed = FIELDS.filter(field => fieldChanged(a, b, field))
  if (Boolean(before.completed) !== Boolean(after.completed)) changed.push('completed')
  return changed
}

/**
 * Applies a newer source snapshot under an open draft. Fields the user hasn't touched
 * follow the source; touched fields keep the user's text and are reported as conflicts
 * when the source also changed them.
 */
export function rebaseDraft(base, draft, current) {
  const next = draftFromSource(current)
  const merged = { ...draft }
  const conflicts = []
  for (const field of FIELDS) {
    const keys = field === 'due' ? ['date', 'time'] : [field]
    const touched = fieldChanged(base, draft, field)
    const moved = fieldChanged(base, next, field)
    if (!touched) for (const key of keys) merged[key] = next[key]
    else if (moved && fieldChanged(draft, next, field)) conflicts.push(field)
  }
  return { base: next, draft: merged, conflicts }
}

export const FIELD_NAMES = {
  title: 'Title',
  notes: 'Notes',
  calendarId: 'List',
  due: 'Due',
  priority: 'Priority',
  completed: 'Completed',
  gone: 'Deleted'
}

/** Title label settings: both nonempty, and neither may start with the other. */
export function labelErrors({ agent, ready }) {
  const errors = {}
  if (!agent.trim()) errors.agent = 'Add a label'
  if (!ready.trim()) errors.ready = 'Add a label'
  if (!errors.agent && !errors.ready && (agent.startsWith(ready) || ready.startsWith(agent))) {
    errors.ready = "One label can't start with the other"
  }
  return errors
}

// ── outcomes ────────────────────────────────────────────────────────────────

const RESOLVED = new Set([
  'ok',
  'conflict',
  'move_refused',
  'reopen_recurring_unsupported',
  'reopen_origin_unverified',
  'agent_workflow_required',
  'gated_field',
  'access_denied',
  'not_found',
  'not_saved',
  'bad_request'
])

/**
 * Presentation for a /human/actions result, or for a thrown transport error that
 * `classifyError` turned into `{ kind }`.
 *
 * Returns { status, tone, short, message, field?, replay, action? }:
 *   short   a few words for a card that snapped back
 *   message one sentence for a form or notice
 *   replay  true when the same operation ID and body must be retried, never a new write
 *   action  'privacy' | 'reminders' | 'replay' | 'retry' | null
 */
export function describeOutcome(result, error = null) {
  if (error) {
    const kind = error.kind
    const base = { status: kind, tone: 'error', replay: true, action: 'replay' }
    if (kind === 'auth') return { ...base, short: 'Sign in to Hermes', message: 'Sign in to Hermes again. Your changes are kept here.' }
    if (kind === 'backend_missing') {
      return { ...base, short: 'Plugin is off', message: 'Reminders Kanban is off for this profile. Your changes are kept here.' }
    }
    if (kind === 'bad_request') return { ...base, replay: false, action: null, short: "Hermes didn't accept that", message: "Hermes didn't accept that request." }
    return { ...base, short: "Can't reach Hermes", message: "Can't reach Hermes, so this may not have saved. Your changes are kept; try again." }
  }
  const status = result?.status ?? 'unknown'
  const reason = result?.reason ?? null
  const out = (tone, short, message, extra = {}) => ({ status, reason, tone, short, message, replay: false, action: null, ...extra })
  switch (status) {
    case 'ok':
      return out('ok', 'Saved', 'Saved.')
    case 'conflict':
      if (reason === 'operation_id_reused') return out('error', 'Try again', 'That save collided with an earlier one. Save again.', { action: 'retry' })
      if (reason === 'agent_owned') return out('error', 'Hermes moves agent tasks', 'This is an agent task now, so Hermes moves it.')
      // Another Mac's Hermes is working on it (two Macs on one Reminders account).
      if (reason === 'other_mac') return out('error', `Hermes on ${result.mac ?? 'another Mac'} has this`, `Hermes on ${result.mac ?? 'another Mac'} has this.`)
      return out('error', 'Changed in Apple Reminders', 'Not saved, because it changed in Apple Reminders. Check the changes, then save again.')
    case 'reopen_recurring_unsupported':
    case 'reopen_origin_unverified':
      // Apple drops repeat details from completed history, so only reminders this plugin
      // completed as one-offs can be reopened here.
      return out('warn', 'Reopen it in Apple Reminders', 'Reopen it in Apple Reminders.', { action: 'reminders' })
    case 'agent_workflow_required':
      return out('warn', 'Agent work: reopen it from its task', 'This is agent work, so reopen it from its agent task.', { action: 'details' })
    case 'move_refused':
      // Apple left the reminder where it was (for example, it has subtasks).
      return out('error', "Couldn't move it", "Couldn't move this reminder; move it in Reminders.", { action: 'reminders' })
    case 'gated_field':
      // Saving would move the reminder's start to another time zone (human-contract.md).
      if (reason === 'due_recurring') {
        return out('warn', 'Repeating reminders need a date', 'Change the repeat schedule in Apple Reminders.', { action: 'reminders', field: 'due' })
      }
      if (reason === 'due_start_timezone') {
        return out('warn', 'Change the date in Apple Reminders', "This reminder's dates use another time zone. Change the due date in Apple Reminders.", {
          action: 'reminders',
          field: 'due'
        })
      }
      return out(
        'warn',
        'Edit in Apple Reminders',
        reason === 'notes_append_only'
          ? 'Notes can only be added to here. Change existing notes in Apple Reminders.'
          : reason === 'opaque_preservation_unproved'
            ? "Hermes can't safely change that here yet. Edit it in Apple Reminders."
            : 'Edit this in Apple Reminders.',
        { action: 'reminders' }
      )
    case 'uncertain':
      // Refused before any write because an earlier save is still unconfirmed: this one wasn't sent,
      // so there is nothing of its own to check again.
      if (result?.pending_operation_id && result.pending_operation_id !== result.operation_id) {
        return out('error', 'An earlier save is unconfirmed', "Not saved. An earlier save hasn't been confirmed yet. Look for it in Apple Reminders.", { action: 'reminders' })
      }
      return out('error', 'Not sure it saved', "Hermes isn't sure this saved. It's checking, and changes here wait until it knows.", {
        replay: true,
        action: 'replay'
      })
    case 'access_denied':
      return out('error', "Can't read Reminders", ACCESS.full, { action: 'privacy' })
    case 'not_saved':
      // Settled from a fresh read after a save went unanswered: Reminders is unchanged.
      return out('error', "Didn't save", "That save didn't go through, and nothing changed in Apple Reminders. Save again.", { action: 'retry' })
    case 'not_found':
      return out('error', 'Gone from Apple Reminders', 'This reminder is gone from Apple Reminders. Your text is kept here.')
    case 'bad_request':
      if (reason === 'human_title_required') {
        return out('error', 'Agent label in title', 'Titles starting with an agent label are agent tasks.', { field: 'title' })
      }
      if (reason === 'move_separately') {
        return out('error', 'Move it on its own', 'Save your other changes first, then change the list.', { field: 'calendarId' })
      }
      if (reason === 'selected_list_required') return out('error', 'Pick a board list', "Pick one of this board's lists.", { field: 'calendarId' })
      if (reason === 'selected_source_required') return out('error', 'Not in a board list', "This reminder isn't in one of this board's lists anymore.")
      return out('error', "Hermes didn't accept that", "Hermes didn't accept that. Check the fields and try again.")
    case 'persistence_failed':
      return out('error', "Hermes couldn't save", "Hermes couldn't write its board data. Your changes are kept; try again.", { replay: true, action: 'replay' })
    case 'unavailable_host':
      return out('error', "Can't reach Hermes", "Can't reach this Hermes profile. Your changes are kept; try again.", { replay: true, action: 'replay' })
    default:
      return out('error', "Couldn't save", "Couldn't save. Your changes are kept.", { action: 'retry' })
  }
}

/**
 * What a replay of the unknown save settles. `unsure` is the stored request
 * ({ body, cardId?, draftKey? }); `status` and `shown` are the replay's answer.
 *   unsure     the next stored unknown save, or null when resolved
 *   clearDraft the originating form's draft is saved; drop it
 *   draft      fields to merge into the originating form's stored state
 *   notice     a reason to show on the originating card
 */
export function replaySettlement(unsure, status, shown) {
  if (shown?.replay) {
    return { unsure: { ...unsure, outcome: shown, checking: false }, clearDraft: false, draft: unsure.draftKey ? { outcome: shown } : null, notice: null }
  }
  if (status === 'ok') return { unsure: null, clearDraft: Boolean(unsure.draftKey), draft: null, notice: null }
  return {
    unsure: null,
    clearDraft: false,
    draft: unsure.draftKey ? { operation: null, outcome: shown } : null,
    notice: unsure.cardId ? shown : null
  }
}

/** What the unsure-save bar and its form say once a check has already come back unsure: the board
 *  keeps checking by itself (useEditor), so it says that instead of asking for another press. Null while the first check is still worth pressing, or when the
 *  save is only waiting on a connection or a sign-in (those keep their own words). */
export const stuckMessage = unsure => {
  if (!(unsure?.tries > 0) || unsure.outcome?.status !== 'uncertain') return null
  // Every kind of save settles by itself once the Reminders writer has stopped (human-contract.md).
  return `Hermes is still checking whether "${unsure.title}" saved, and will keep checking. Changes here wait until it knows.`
}

/** True when the backend recorded a final outcome for that operation ID. */
export const isResolved = status => RESOLVED.has(status)
