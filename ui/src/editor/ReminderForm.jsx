// Create and edit forms in the host Dialog. Drafts survive closing, board refreshes,
// conflicts and failed saves (useStoredDraft). Edit sends only changed fields against
// the last source snapshot the form showed; gated fields stay visible with the reason.
import {
  Badge,
  Button,
  Codicon,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea
} from '@hermes/plugin-sdk'
import { useEffect, useMemo, useRef, useState } from 'react'

import { openPrivacySettings, openRemindersApp } from '../api/client.js'
import { dueInfo, repeatSummary } from '../lib/cards.js'
import {
  createFields,
  describeOutcome,
  draftFromSource,
  dueModeError,
  effectiveDraft,
  editFields,
  emptyDraft,
  FIELD_NAMES,
  keptDraft,
  PRIORITIES,
  rebaseDraft,
  sourceChanges,
  stuckMessage,
  validateDraft,
  withDueDate
} from '../lib/drafts.js'
import { notesWithoutLink } from '../lib/task-link.js'
import { DialogHead, MetaPills, StatusPill } from '../task/shell.jsx'
import { COLUMN_TONES, metaFor } from '../task/TaskDialog.jsx'
import { newOperationId, sendAction } from './useEditor.js'
import { recallValue, rememberValue, useStoredDraft } from './useStoredDraft.js'

const BODY = 'flex max-h-[min(84vh,54rem)] flex-col gap-0 overflow-hidden p-0'
const ZONE = () => Intl.DateTimeFormat().resolvedOptions().timeZone
const ALL_FIELDS = new Set(['title', 'notes', 'calendarId', 'due', 'priority'])

/** Fields the workflow lets this card edit: `capabilities.edit` gates the card and
 *  `capabilities.edit_fields` names the fields (human-contract.md). */
export function editableFields(card) {
  const can = card?.capabilities ?? {}
  if (can.edit !== true) return new Set()
  return Array.isArray(can.edit_fields) ? new Set(can.edit_fields.filter(field => ALL_FIELDS.has(field))) : ALL_FIELDS
}

// Why a field the card can't edit here is unavailable (human-contract.md).
const LOCK_REASONS = {
  calendarId: "Lists can't be changed here yet. Change it in Apple Reminders."
}

// Due edits are saved only when they keep the reminder's start time zone; the card's
// `capabilities.due_modes` names which due shapes do (human-contract.md).
const DUE_FIELDS = new Set(['date', 'time'])
const outcomeField = field => (DUE_FIELDS.has(field) ? 'due' : field)

const BLOCKED = {
  status: 'blocked',
  tone: 'warn',
  short: 'Check the last save first',
  message: "An earlier save hasn't been confirmed yet. Close this and see the note at the bottom of the board.",
  replay: false,
  action: null
}

const sameSource = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Edit swaps in for the task details dialog without a jump: the same shell class (width and
 *  surface, ui/src/task/task.css) and, when opened from it, the same top edge, growing downward. */
function editShell(anchorTop) {
  if (!Number.isFinite(anchorTop)) return undefined
  return { top: `${anchorTop}px`, translate: '-50% 0', transformOrigin: 'top center', maxHeight: `calc(100dvh - ${anchorTop}px - 1rem)` }
}

export function ReminderForm({ anchorTop, editor, mode, card, cardId, lists, labels, onClose, onCloseAutoFocus }) {
  const key = mode === 'edit' ? `${editor.scope.join('\u0000')}|edit|${card?.id ?? cardId}` : `${editor.scope.join('\u0000')}|create`
  return (
    <Dialog onOpenChange={open => !open && onClose()} open>
      <DialogContent
        aria-describedby={undefined}
        bodyClassName={BODY}
        className={mode === 'edit' ? 'rk-task-dialog max-w-none' : 'max-w-none'}
        onCloseAutoFocus={onCloseAutoFocus}
        showCloseButton={false}
        style={mode === 'edit' ? editShell(anchorTop) : { width: 'min(46rem, 94vw)' }}
      >
        {mode === 'edit' && !card ? (
          <Gone onClose={onClose} storeKey={key} />
        ) : (
          <Form card={card} editor={editor} key={key} labels={labels} lists={lists} mode={mode} onClose={onClose} storeKey={key} />
        )}
      </DialogContent>
    </Dialog>
  )
}

/** The card left the board under an open edit. Text typed and not saved stays readable here,
 *  so it can be copied out. */
function Gone({ onClose, storeKey }) {
  const stored = recallValue(storeKey)
  const kept = ['title', 'notes', 'notesAdd'].filter(f => stored?.draft?.[f]?.trim() && stored.draft[f] !== stored.base?.[f])
  return (
    <div className="rk-form" data-head="task">
      <DialogHead onClose={onClose} title={<DialogTitle className="rk-task-title">Reminder not on the board</DialogTitle>} />
      <p className="rk-form-gone">This reminder isn't on the board anymore. It was deleted, moved to another list, or its list was removed.</p>
      {kept.length > 0 && (
        <div className="rk-form-kept">
          <span className="rk-form-kept-label">Your unsaved text</span>
          {kept.map(f => (
            <p className="rk-form-kept-text" key={f}>
              {stored.draft[f]}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

function CloseButton({ onClose }) {
  return (
    <Button type="button" aria-label="Close" className="rk-form-close" onClick={onClose} size="icon-xs" variant="ghost">
      <Codicon name="close" />
    </Button>
  )
}

function initialState(mode, card, lists) {
  if (mode === 'edit') {
    const base = draftFromSource(card.source)
    return { baseSource: card.source, base, draft: base, operation: null, outcome: null, changed: [], conflicts: [] }
  }
  const remembered = recallValue('rk-last-list')
  const list = lists.find(entry => entry.id === remembered)?.id ?? lists[0]?.id ?? ''
  return { baseSource: null, base: null, draft: emptyDraft(list), operation: null, outcome: null, changed: [], conflicts: [] }
}

function Form({ editor, mode, card, lists, labels, onClose, storeKey }) {
  const [stored, setState, discard] = useStoredDraft(storeKey, () => initialState(mode, card, lists))
  const state = stored ?? initialState(mode, card, lists)
  const [tried, setTried] = useState(false)
  // A request in flight (`state.pending`) or with an unknown outcome blocks new saves: only
  // the stored request may be replayed, with its own operation ID (human-contract.md).
  const unresolved = editor.unsure
  const mine = unresolved?.draftKey === storeKey
  const saving = Boolean(state.pending) || Boolean(mine && unresolved.checking)
  const titleRef = useRef(null)
  const { draft, base } = state
  const editing = mode === 'edit'
  const editable = editing ? editableFields(card) : ALL_FIELDS
  const appendOnly = editing && card?.capabilities?.notes_mode === 'append'
  const completed = editing && card?.source?.completed
  const agent = editing && card?.owner === 'agent'
  const gated = editing && (editable.size === 0 || completed || agent)
  const locked = field => saving || mine || (editing && (!editable.has(field) || completed || agent))

  // Source updates under an open form: untouched fields follow the source, touched
  // fields keep the user's text, and both kinds of change are named.
  useEffect(() => {
    if (!editing || !card || sameSource(card.source, state.baseSource)) return
    setState(current => {
      if (!current || sameSource(card.source, current.baseSource)) return current
      const changed = sourceChanges(current.baseSource, card.source)
      const rebased = rebaseDraft(current.base, current.draft, card.source)
      return {
        ...current,
        baseSource: card.source,
        base: rebased.base,
        draft: rebased.draft,
        changed: [...new Set([...current.changed, ...changed])],
        conflicts: [...new Set([...current.conflicts.filter(f => rebased.conflicts.includes(f) || !changed.includes(f)), ...rebased.conflicts])]
      }
    })
  }, [editing, card, state.baseSource, setState])

  useEffect(() => {
    if (!gated) titleRef.current?.focus({ preventScroll: true })
  }, [gated])
  // Fields are disabled while a save is out, which drops focus. When it comes back with something
  // to fix, the caret returns to the title (a field's own error focuses that field instead).
  const wasSaving = useRef(false)
  useEffect(() => {
    if (wasSaving.current && !saving && state.outcome && !state.outcome.field && (!document.activeElement || document.activeElement === document.body)) {
      titleRef.current?.focus({ preventScroll: true })
    }
    wasSaving.current = saving
  }, [saving]) // eslint-disable-line react-hooks/exhaustive-deps

  const saved = effectiveDraft(draft, appendOnly ? 'append' : null)
  const dueModes = editing ? (card?.capabilities?.due_modes ?? null) : null
  const errors = useMemo(() => validateDraft(saved, { mode, base, labels, dueModes }), [saved, mode, base, labels, dueModes])
  const shownErrors = tried ? errors : {}
  const outcome = state.outcome
  const fieldError = field => shownErrors[field] ?? (outcome?.field === field ? outcome.message : null)
  const fieldAction = field => (!shownErrors[field] && outcome?.field === field ? outcome.action : null)
  const dirty = editing ? Object.keys(editFields(base, saved, ZONE())).length > 0 : Boolean(draft.title || draft.notes || draft.date)
  // An edit closed with nothing typed leaves nothing behind: otherwise its old snapshot would
  // name a later change in Reminders as "your edits are kept" the next time it opens.
  const untouched = useRef(false)
  untouched.current = editing && !dirty && !saving && !mine && !state.pending
  useEffect(
    () => () => {
      if (untouched.current) discard()
      else setState(keptDraft)
    },
    [discard, setState]
  )
  // A field this card can't edit here says so in place, instead of disappearing.
  const lockNote = field =>
    editing && !gated && !editable.has(field) ? (
      <p className="rk-form-locked">{LOCK_REASONS[field] ?? 'Change it in Apple Reminders'}</p>
    ) : null

  const set = (field, value) =>
    setState(current => ({
      ...current,
      draft: field === 'date' ? withDueDate(current.draft, value) : { ...current.draft, [field]: value },
      outcome: current.outcome?.field === outcomeField(field) ? null : current.outcome
    }))
  // Due controls the reminder's modes allow. Unchanged values always stay.
  const dueOpen = !locked('due')
  const canClear = !editing || !dueModeError(base, { ...draft, date: '', time: '' }, dueModes)
  const canTime = !editing || Boolean(draft.time) || !draft.date || !dueModeError(base, { ...draft, time: '12:00' }, dueModes)
  const canAllDay = !editing || !draft.time || !dueModeError(base, { ...draft, time: '' }, dueModes)
  const dueNote =
    editing && dueOpen && draft.date && !fieldError('due')
      ? dueModes?.clear_reason || (!canTime
        ? 'Add a time in Apple Reminders.'
        : !canClear
          ? canAllDay
            ? 'Clear the date in Apple Reminders.'
            : 'Clear the date or remove the time in Apple Reminders.'
          : null)
      : null
  const useTheirs = field =>
    setState(current => ({
      ...current,
      draft: field === 'due' ? { ...current.draft, date: current.base.date, time: current.base.time } : { ...current.draft, [field]: current.base[field] },
      conflicts: current.conflicts.filter(entry => entry !== field)
    }))

  const submit = async event => {
    event?.preventDefault()
    if (saving || gated) return
    if (unresolved) {
      if (mine) void editor.replay()
      else setState(current => ({ ...current, outcome: BLOCKED }))
      return
    }
    setTried(true)
    const invalid = Object.keys(errors)
    if (invalid.length) {
      document.getElementById(`rk-field-${invalid[0]}`)?.focus()
      return
    }
    // The form shows the reminder's own clock time, so an edit keeps the reminder's zone.
    const zone = (editing && (card?.capabilities?.due_modes?.time_zone ?? state.baseSource?.due?.timeZone)) || ZONE()
    const core = editing
      ? { action: 'edit', expected: state.baseSource, fields: editFields(base, saved, zone) }
      : { action: 'create', expected: null, fields: createFields(draft, zone) }
    if (editing && Object.keys(core.fields).length === 0) return onClose()
    // Stored before sending, outside this dialog: closing and reopening mid-save shows the
    // same pending request instead of allowing a second one.
    const body = { operation_id: newOperationId(), ...core }
    const title = draft.title.trim()
    setState(current => ({ ...current, pending: body, outcome: null }))
    const answer = await sendAction(editor.scope, body)
    // A profile switch drops the answer, not the request: it may have saved, so keep it
    // as this scope's unknown save and allow only a verbatim replay.
    const { result, shown } = answer.superseded ? { result: null, shown: describeOutcome({ status: 'uncertain' }) } : answer
    if (result?.status === 'ok') {
      discard()
      if (!editing) rememberValue('rk-last-list', draft.calendarId)
      editor.announce(editing ? `Saved ${title}.` : `Created ${title}.`)
      if (result.card?.id) {
        editor.focusCard(result.card.id)
        if (!editing) editor.markCreated(result.card)
        else editor.patchSource(result.card)
      }
      void editor.refreshBoard()
      editor.closeFormFor(storeKey)
      return
    }
    setState(current => current && { ...current, pending: null, outcome: shown })
    if (shown.replay) editor.setUnsure({ body, outcome: shown, title, draftKey: storeKey })
    // A refused move reports the unchanged source; show it under the kept draft.
    if (result?.status === 'move_refused' && result.current && editing) {
      setState(current => {
        if (!current) return current
        if (sameSource(result.current, current.baseSource)) return current
        const rebased = rebaseDraft(current.base, current.draft, result.current)
        return { ...current, baseSource: result.current, base: rebased.base, draft: rebased.draft }
      })
    }
    // A gated due edit may mean the reminder changed under the form; the refreshed card
    // brings its current modes, and the draft stays.
    if (['conflict', 'not_found', 'move_refused', 'gated_field'].includes(result?.status)) void editor.refreshBoard()
  }

  const onKeyDown = event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(event)
  }

  const listName = id => lists.find(entry => entry.id === id)?.title ?? card?.source?.calendarTitle ?? 'Unavailable list'
  const repeats = editing ? repeatSummary(card.source.rules) : null

  const titleField = (
    <div className={editing ? 'rk-form-titlefield' : 'rk-form-head'}>
      <label className="rk-sr" htmlFor="rk-field-title">
        Title
      </label>
      <input
        aria-describedby={fieldError('title') ? 'rk-error-title' : undefined}
        aria-invalid={Boolean(fieldError('title')) || undefined}
        autoComplete="off"
        className="rk-form-title"
        disabled={locked('title')}
        dir="auto"
        id="rk-field-title"
        onChange={event => set('title', event.target.value)}
        placeholder="Reminder"
        ref={titleRef}
        value={draft.title}
      />
      <FieldMessage error={fieldError('title')} id="rk-error-title" />
      <Theirs conflicts={state.conflicts} field="title" onUse={useTheirs} value={base?.title} />
    </div>
  )

  return (
    <form className="rk-form" data-head={editing ? 'task' : undefined} noValidate onKeyDown={onKeyDown} onSubmit={submit}>
      {editing ? (
        // The task dialog's header (ui/src/task/shell.jsx): status pill, title, meta pills. The
        // title is the editable field; the pill row says this is an edit.
        <DialogHead
          meta={<MetaPills items={metaFor(card)} />}
          onClose={onClose}
          pill={
            <>
              {/* The other Mac claimed it while this form was open: the pill says whose it is. */}
              {card.agent?.status === 'elsewhere' ? <StatusPill label={card.agent.label} tone="muted" /> : <StatusPill label={card.column} tone={COLUMN_TONES[card.column]} />}
              <DialogTitle aria-label="Edit reminder" className="rk-form-kind">
                {saving ? 'Saving…' : 'Editing'}
              </DialogTitle>
            </>
          }
          title={titleField}
        />
      ) : (
        <div className="rk-form-bar">
          <DialogTitle className="rk-form-kind">New reminder</DialogTitle>
          {saving && <Badge variant="muted">Saving…</Badge>}
          <CloseButton onClose={onClose} />
        </div>
      )}

      {gated && <GateNotice agent={agent} completed={completed} />}
      {editing && state.changed.length > 0 && (
        <div className="rk-form-banner" data-tone="info" role="status">
          <Codicon name="sync" size="0.85rem" />
          <span>
            {state.changed.includes('gone')
              ? "It's gone from Apple Reminders. Your text is kept here."
              : `Changed in Apple Reminders: ${state.changed.map(f => FIELD_NAMES[f]).join(', ')}.${dirty ? ' Your edits are kept.' : ''}`}
          </span>
        </div>
      )}

      {!editing && titleField}

      <div className="rk-form-body">
        <div className="rk-form-main">
          {/* Stays while saving or unsure, so what was typed is still in sight (only disabled). */}
          {appendOnly && editable.has('notes') && !completed && !agent ? (
            <>
              <span className="rk-label">Notes</span>
              {/* Without the line that says which Hermes has it: it is not the person's text. */}
              {notesWithoutLink(draft.notes) ? (
                <p className="rk-notes rk-form-existing" data-selectable-text="true" dir="auto">
                  {notesWithoutLink(draft.notes)}
                </p>
              ) : null}
              <label className="rk-sr" htmlFor="rk-field-notes">
                Add to notes
              </label>
              <Textarea
                className="rk-form-notes"
                disabled={saving || mine}
                dir="auto"
                id="rk-field-notes"
                onChange={event => set('notesAdd', event.target.value)}
                placeholder={draft.notes ? 'Add to notes' : 'Add notes'}
                rows={4}
                value={draft.notesAdd}
              />
            </>
          ) : (
            <>
              <label className="rk-label" htmlFor="rk-field-notes">
                Notes
              </label>
              <Textarea
                className="rk-form-notes"
                disabled={locked('notes')}
                dir="auto"
                id="rk-field-notes"
                onChange={event => set('notes', event.target.value)}
                placeholder={locked('notes') ? 'No notes' : 'Add notes'}
                rows={7}
                // Locked (Hermes has it now): the notes without the line that says which Hermes,
                // and whatever was being added stays in sight.
                value={locked('notes') ? appendNotes(notesWithoutLink(draft.notes), draft.notesAdd ?? '') : draft.notes}
              />
              <Theirs conflicts={state.conflicts} field="notes" onUse={useTheirs} value={base?.notes} />
            </>
          )}
        </div>

        <div className="rk-form-side">
          <Field error={fieldError('calendarId')} label="List" name="calendarId">
            <Select disabled={locked('calendarId')} onValueChange={value => set('calendarId', value)} value={draft.calendarId || undefined}>
              <SelectTrigger
                aria-describedby={fieldError('calendarId') ? 'rk-error-calendarId' : undefined}
                aria-invalid={Boolean(fieldError('calendarId')) || undefined}
                id="rk-field-calendarId"
                size="sm"
              >
                <SelectValue placeholder="Choose a list">{draft.calendarId ? listName(draft.calendarId) : null}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {lists.map(list => (
                  <SelectItem key={list.id} value={list.id}>
                    {list.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {lockNote('calendarId')}
            <Theirs conflicts={state.conflicts} field="calendarId" onUse={useTheirs} value={base && listName(base.calendarId)} />
          </Field>

          <Field action={fieldAction('due')} error={fieldError('due')} label="Due" name="due">
            <div className="rk-form-due">
              <Input
                aria-describedby={fieldError('due') ? 'rk-error-due' : undefined}
                aria-label="Due date"
                aria-invalid={Boolean(fieldError('due')) || undefined}
                disabled={locked('due')}
                id="rk-field-due"
                onChange={event => set('date', event.target.value)}
                size="sm"
                type="date"
                value={draft.date}
              />
              <Input
                aria-label="Due time (optional)"
                disabled={locked('due') || !draft.date || !canTime}
                onChange={event => set('time', event.target.value)}
                size="sm"
                type="time"
                value={draft.time}
              />
            </div>
            {dueOpen && canClear && (draft.date || draft.time) && (
              <Button type="button"
                className="rk-form-clear"
                onClick={() => {
                  setState(current => ({
                    ...current,
                    draft: { ...current.draft, date: '', time: '' },
                    outcome: current.outcome?.field === 'due' ? null : current.outcome
                  }))
                  // This button removes itself: focus goes to the date it cleared.
                  document.getElementById('rk-field-due')?.focus()
                }}
                size="inline"
                variant="text"
              >
                Clear date
              </Button>
            )}
            {dueNote && <p className="rk-form-locked">{dueNote}</p>}
            <Theirs
              conflicts={state.conflicts}
              field="due"
              onUse={useTheirs}
              value={base && (base.date ? shownDate(base) : 'No date')}
            />
          </Field>

          <Field label="Priority" name="priority">
            <Select disabled={locked('priority')} onValueChange={value => set('priority', Number(value))} value={String(draft.priority)}>
              <SelectTrigger id="rk-field-priority" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIORITIES.map(entry => (
                  <SelectItem key={entry.value} value={String(entry.value)}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Theirs
              conflicts={state.conflicts}
              field="priority"
              onUse={useTheirs}
              value={base && PRIORITIES.find(entry => entry.value === base.priority)?.label}
            />
          </Field>

          {repeats && (
            <div className="rk-form-field">
              <span className="rk-label">Repeats</span>
              <span className="rk-form-static">{repeats}</span>
            </div>
          )}
        </div>
      </div>

      <div className="rk-form-foot">
        <Outcome outcome={mine ? { ...unresolved.outcome, message: stuckMessage(editor.unsure) ?? unresolved.outcome.message } : outcome} />
        <div className="rk-form-actions">
          {/* Create and edit alike: Cancel keeps the draft for next time, Discard drops it. */}
          {dirty && !gated && !saving && !mine && (
            <Button type="button"
              onClick={() => {
                discard()
                onClose()
              }}
              size="sm"
              variant="text"
            >
              Discard
            </Button>
          )}
          <Button type="button" onClick={onClose} size="sm" variant="ghost">
            {gated ? 'Close' : 'Cancel'}
          </Button>
          {!gated && (
            <Button disabled={editing && !dirty && !mine} loading={saving} size="sm" type="submit">
              {mine ? 'Check again' : editing ? 'Save' : 'Create'}
            </Button>
          )}
        </div>
      </div>
    </form>
  )
}

function Field({ action, children, error, label, name }) {
  return (
    <div className="rk-form-field">
      <label className="rk-label" htmlFor={`rk-field-${name}`}>
        {label}
      </label>
      {children}
      <FieldMessage action={action} error={error} id={`rk-error-${name}`} />
    </div>
  )
}

function FieldMessage({ action, error, id }) {
  if (!error) return null
  return (
    <p className="rk-form-error" id={id} role="alert">
      {error}
      {action === 'reminders' && (
        <>
          {' '}
          <Button type="button" onClick={openRemindersApp} size="inline" variant="textStrong">
            Open Reminders
          </Button>
        </>
      )}
    </p>
  )
}

/** A draft's date and time the way the board writes dates: "Nov 10, 2:00 PM". */
function shownDate({ date, time }) {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time ? time.split(':').map(Number) : [null, null]
  return dueInfo({ year, month, day, hour, minute })?.label ?? date
}

/** Apple Reminders' newer value for a field the user also changed. */
function Theirs({ conflicts, field, onUse, value }) {
  if (!conflicts.includes(field)) return null
  return (
    <p className="rk-form-theirs">
      <span>
        Apple Reminders now says <q>{value || 'nothing'}</q>
      </span>
      <Button type="button" onClick={() => onUse(field)} size="inline" variant="textStrong">
        Use this
      </Button>
    </p>
  )
}

function GateNotice({ agent, completed }) {
  const message = agent
    ? 'Hermes manages agent tasks, so this one is read-only here.'
    : completed
      ? 'Completed reminders are read-only here.'
      : describeOutcome({ status: 'gated_field', reason: 'opaque_preservation_unproved' }).message
  return (
    <div className="rk-form-banner" data-tone="warn" role="note">
      <Codicon name="lock" size="0.85rem" />
      <span>{message}</span>
      <Button type="button" onClick={openRemindersApp} size="xs" variant="secondary">
        Open Reminders
      </Button>
    </div>
  )
}

function Outcome({ outcome }) {
  if (!outcome || outcome.status === 'ok' || outcome.field) return <span className="rk-form-outcome" />
  return (
    <div className="rk-form-outcome" data-tone={outcome.tone} role="alert">
      <Codicon name={outcome.tone === 'warn' ? 'info' : 'warning'} size="0.8rem" />
      <span>{outcome.message}</span>
      {outcome.action === 'privacy' && (
        <Button type="button" onClick={openPrivacySettings} size="inline" variant="textStrong">
          Open Privacy Settings
        </Button>
      )}
      {outcome.action === 'reminders' && (
        <Button type="button" onClick={openRemindersApp} size="inline" variant="textStrong">
          Open Reminders
        </Button>
      )}
    </div>
  )
}
