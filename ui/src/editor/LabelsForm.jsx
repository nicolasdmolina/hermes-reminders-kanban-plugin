// Title labels: which leading title text marks a reminder as an agent task. The change
// is explicit and only reclassifies titles; it never rewrites reminders (human-contract.md).
import { Button, Codicon, Dialog, DialogContent, DialogTitle, Input } from '@hermes/plugin-sdk'
import { useState } from 'react'

import { describeOutcome, labelErrors } from '../lib/drafts.js'
import { newOperationId, sendAction } from './useEditor.js'
import { useStoredDraft } from './useStoredDraft.js'

const BODY = 'flex flex-col gap-0 overflow-hidden p-0'

export function LabelsForm({ editor, labels, onClose, onCloseAutoFocus }) {
  const key = `${editor.scope.join('\u0000')}|labels`
  const [stored, setState, discard] = useStoredDraft(key, () => ({ draft: { ...labels }, outcome: null }))
  const state = stored ?? { draft: { ...labels }, outcome: null }
  const [saving, setSaving] = useState(false)
  const [tried, setTried] = useState(false)
  const errors = tried ? labelErrors(state.draft) : {}
  const dirty = state.draft.agent !== labels.agent || state.draft.ready !== labels.ready

  const set = (field, value) => setState(current => ({ ...current, draft: { ...current.draft, [field]: value }, outcome: null }))

  // A request whose answer never arrived is the scope's unknown save: replayed verbatim
  // through editor.replay(), with the fields locked until it resolves.
  const mine = editor.unsure?.draftKey === key
  const unresolved = mine ? editor.unsure.body : null

  // Cancel and Close mean it: the next open starts from the saved labels. (Escape and an outside
  // click keep the draft, as a slip.) An unknown save keeps its fields until it resolves.
  const cancel = () => {
    if (!mine && !saving) discard()
    onClose()
  }

  const submit = async event => {
    event.preventDefault()
    setTried(true)
    if (saving || editor.unsure?.checking) return
    if (mine) return void editor.replay()
    const invalid = Object.keys(labelErrors(state.draft))
    if (invalid.length) return void document.getElementById(`rk-label-${invalid[0]}`)?.focus()
    if (!dirty) return onClose()
    if (editor.unsure) {
      setState(current => ({ ...current, outcome: { tone: 'warn', message: "An earlier save hasn't been confirmed yet. Close this and see the note at the bottom of the board." } }))
      return
    }
    const body = {
      operation_id: newOperationId(),
      action: 'labels',
      expected: null,
      fields: { agent: state.draft.agent, ready: state.draft.ready }
    }
    setSaving(true)
    const answer = await sendAction(editor.scope, body)
    setSaving(false)
    if (answer.result?.status === 'ok') {
      discard()
      editor.patchLabels(answer.result.title_labels)
      editor.announce('Title labels saved.')
      void editor.refreshBoard()
      onClose()
      return
    }
    const shown = answer.superseded
      ? describeOutcome({ status: 'uncertain' })
      : answer.result?.status === 'bad_request'
        ? describeOutcome({ status: 'bad_request' })
        : answer.shown
    setState(current => current && { ...current, outcome: shown })
    if (shown.replay) editor.setUnsure({ body, outcome: shown, title: 'Title labels', draftKey: key })
  }

  return (
    <Dialog onOpenChange={open => !open && onClose()} open>
      <DialogContent
        aria-describedby="rk-labels-help"
        bodyClassName={BODY}
        className="max-w-none"
        onCloseAutoFocus={onCloseAutoFocus}
        showCloseButton={false}
        style={{ width: 'min(26rem, 94vw)' }}
      >
        <form className="rk-form" noValidate onSubmit={submit}>
          <div className="rk-form-bar">
            <DialogTitle className="rk-form-kind">Title labels</DialogTitle>
            <Button aria-label="Close" className="rk-form-close" onClick={cancel} size="icon-xs" type="button" variant="ghost">
              <Codicon name="close" />
            </Button>
          </div>
          <p className="rk-labels-help" id="rk-labels-help">
            Reminders whose titles start with these are agent tasks. Changing them doesn't edit any reminder.
          </p>
          <div className="rk-labels-fields">
            <LabelField disabled={Boolean(unresolved)} error={errors.agent} label="Agent task" name="agent" onChange={set} value={state.draft.agent} />
            <LabelField disabled={Boolean(unresolved)} error={errors.ready} label="Ready for Agent" name="ready" onChange={set} value={state.draft.ready} />
          </div>
          <div className="rk-form-foot">
            {state.outcome ? (
              <div className="rk-form-outcome" data-tone={state.outcome.tone} role="alert">
                <Codicon name="warning" size="0.8rem" />
                <span>{state.outcome.message}</span>
              </div>
            ) : (
              <span className="rk-form-outcome" />
            )}
            <div className="rk-form-actions">
              <Button onClick={cancel} size="sm" type="button" variant="ghost">
                Cancel
              </Button>
              <Button disabled={!dirty && !unresolved} loading={saving} size="sm" type="submit">
                {unresolved ? 'Check again' : 'Save'}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function LabelField({ disabled, error, label, name, onChange, value }) {
  return (
    <div className="rk-form-field">
      <label className="rk-label" htmlFor={`rk-label-${name}`}>
        {label}
      </label>
      <Input
        aria-describedby={error ? `rk-label-${name}-error` : undefined}
        aria-invalid={Boolean(error) || undefined}
        disabled={disabled}
        id={`rk-label-${name}`}
        onChange={event => onChange(name, event.target.value)}
        size="sm"
        value={value}
      />
      {error && (
        <p className="rk-form-error" id={`rk-label-${name}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
