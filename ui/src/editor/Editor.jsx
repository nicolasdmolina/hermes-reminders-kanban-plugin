// The editor feature's pieces the page places: header actions, task-dialog actions,
// card notices, and one layer with the forms, the unknown-save bar and announcements.
import { Button, Codicon, Tip } from '@hermes/plugin-sdk'

import { openPrivacySettings, openRemindersApp } from '../api/client.js'
import { stuckMessage } from '../lib/drafts.js'
import { labelledAfterStop } from '../lib/moves.js'
import { defineStyles } from '../styles.js'
import css from './editor.css'
import { LabelsForm } from './LabelsForm.jsx'
import { ReminderForm } from './ReminderForm.jsx'

defineStyles(css)

const DEFAULT_LABELS = { agent: '[Agent]', ready: '[Agent · Ready]' }

/** Board header: new reminder and title labels. */
export function EditorHeaderActions({ editor, envelope }) {
  const canCreate = (envelope?.setup?.selected_list_ids?.length ?? 0) > 0
  return (
    <>
      <Tip label="Title labels">
        <Button aria-label="Title labels" onClick={editor.openLabels} size="icon-xs" variant="ghost">
          <Codicon name="tag" size="0.85rem" />
        </Button>
      </Tip>
      <Button data-rk-new="" disabled={!canCreate} onClick={editor.openCreate} size="xs" variant="secondary">
        <Codicon name="add" size="0.8rem" />
        <span>New</span>
      </Button>
    </>
  )
}

const STEPS = {
  'To do': [
    { to: 'In progress', label: 'Start', icon: 'play', keys: '⌥→' },
    { to: 'Done', label: 'Mark done', icon: 'check' }
  ],
  'In progress': [
    { to: 'To do', label: 'Back to To do', icon: 'arrow-left', keys: '⌥←' },
    { to: 'Done', label: 'Mark done', icon: 'check', keys: '⌥→' }
  ],
  Done: [{ to: 'To do', label: 'Reopen', icon: 'debug-restart', needs: 'reopen' }]
}

/** Task dialog bar: progress, completion and edit for human reminders. */
export function EditorCardActions({ card, editor }) {
  if (!card || card.owner === 'agent') return null
  // An unsure save holds every change: the buttons say so by being off, not by doing nothing.
  const busy = Boolean(editor.pending[card.id] || editor.unsure)
  const steps = STEPS[card.column] ?? []
  const can = card.capabilities ?? {}
  // Stopped, but still labelled for the agent: say what frees it instead of showing dead buttons.
  if (labelledAfterStop(card)) {
    return (
      <div className="rk-card-actions">
        <span className="rk-agent-why">Its title still has an agent label. Remove it in Reminders to work on this yourself.</span>
        <Button onClick={() => void openRemindersApp()} size="xs" variant="ghost">
          <Codicon name="link-external" size="0.75rem" />
          <span>Open Reminders</span>
        </Button>
      </div>
    )
  }
  // Nothing to offer (a completed reminder this board can't reopen): no empty bar.
  if (card.source?.completed && !steps.some(step => (step.needs ? can[step.needs] : true))) return null
  return (
    <div className="rk-card-actions">
      {steps.map(step => {
        const allowed = step.needs ? can[step.needs] : step.to === 'Done' ? can.complete : can.progress
        // A Done card this board can't reopen keeps no dead button; its reason shows on a drag.
        if (step.needs && !allowed) return null
        const button = (
          <Button
            disabled={!allowed || busy}
            key={step.to}
            onClick={() => void editor.move(card, step.to)}
            size="xs"
            variant={step.to === 'Done' ? 'secondary' : 'ghost'}
          >
            <Codicon name={step.icon} size="0.75rem" />
            <span>{step.label}</span>
          </Button>
        )
        return step.keys ? (
          <Tip key={step.to} label={`${step.label} · ${step.keys} on the card`}>
            {button}
          </Tip>
        ) : (
          button
        )
      })}
      {/* The form opens where the details dialog was: same top edge (ReminderForm). A completed
          reminder is read-only here, so it offers no Edit to open a form that only says so. */}
      {!card.source?.completed && <Button
        onClick={event => editor.openEdit(card.id, event.currentTarget.closest('[role="dialog"]')?.getBoundingClientRect().top)}
        size="xs"
        variant="ghost"
      >
        <Codicon name="edit" size="0.75rem" />
        <span>Edit</span>
      </Button>}
    </div>
  )
}

/** The reason a card snapped back or rolled back, under that card. */
export function CardNotice({ editor, notice, cardId, onOpenCard }) {
  if (!notice) return null
  return (
    <div className="rk-card-notice" data-tone={notice.tone} key={notice.key}>
      <Codicon name={notice.tone === 'warn' ? 'info' : 'warning'} size="0.7rem" />
      <span>{notice.short}</span>
      {notice.action === 'privacy' && (
        <button className="rk-card-notice-action" onClick={() => (editor.dismissNotice(cardId), editor.focusCard(cardId), openPrivacySettings())} type="button">
          Settings
        </button>
      )}
      {notice.action === 'details' && onOpenCard && (
        <button className="rk-card-notice-action" onClick={() => (editor.dismissNotice(cardId), onOpenCard(cardId))} type="button">
          Open
        </button>
      )}
      {notice.action === 'reminders' && (
        <button className="rk-card-notice-action" onClick={() => (editor.dismissNotice(cardId), editor.focusCard(cardId), openRemindersApp())} type="button">
          Open Reminders
        </button>
      )}
      <button aria-label="Dismiss" className="rk-card-notice-close" onClick={() => (editor.dismissNotice(cardId), editor.focusCard(cardId))} type="button">
        <Codicon name="close" size="0.65rem" />
      </button>
    </div>
  )
}

/** Forms, the unknown-save bar and the live region. */
export function EditorLayer({ editor, envelope, cards, onCloseAutoFocus }) {
  const lists = (envelope?.setup?.selected_list_ids ?? []).map(id => ({
    id,
    title: envelope.lists?.find(list => list.id === id)?.title ?? cards.find(card => card.source?.calendarId === id)?.source?.calendarTitle ?? 'Unavailable list'
  }))
  const labels = envelope?.title_labels ?? DEFAULT_LABELS
  const form = editor.form
  const card = form?.mode === 'edit' ? (cards.find(entry => entry.id === form.cardId) ?? null) : null

  return (
    <>
      {form?.mode === 'labels' && <LabelsForm editor={editor} labels={labels} onClose={editor.closeForm} onCloseAutoFocus={onCloseAutoFocus} />}
      {(form?.mode === 'create' || form?.mode === 'edit') && (
        <ReminderForm
          anchorTop={form.anchorTop}
          card={card}
          cardId={form.cardId}
          editor={editor}
          labels={labels}
          lists={lists}
          mode={form.mode}
          onClose={editor.closeForm}
          onCloseAutoFocus={onCloseAutoFocus}
        />
      )}
      {editor.unsure && (
        <div className="rk-unsure rk-enter" role="alert">
          <Codicon name="warning" size="0.85rem" />
          <span className="rk-unsure-text">
            {stuckMessage(editor.unsure) ?? editor.unsure.outcome.message.replace(/^Hermes isn't sure this saved/, `Hermes isn't sure "${editor.unsure.title}" saved`)}
          </span>
          {stuckMessage(editor.unsure) && (
            <Button onClick={() => openRemindersApp()} size="xs" variant="ghost">
              Open Reminders
            </Button>
          )}
          <Button disabled={editor.unsure.checking} onClick={editor.replay} size="xs" variant="secondary">
            {editor.unsure.checking ? 'Checking…' : 'Check again'}
          </Button>
        </div>
      )}
      <div aria-live="polite" className="rk-sr" role="status">
        {editor.announcement}
      </div>
    </>
  )
}
