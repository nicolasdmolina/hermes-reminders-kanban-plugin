// Task details in the host Dialog (focus trap, Escape, outside click), in the one shared look:
// status pill, title, meta pills, hairline, body, footer. A reminder linked to a Hermes task shows
// the task as a conversation (ui/src/task-link/); a plain reminder shows its details and ticket 10's
// actions (Start, Mark done, Edit) in the footer.
import { Codicon, Dialog, DialogContent, DialogTitle } from '@hermes/plugin-sdk'

import { pluginContext } from '../api/client.js'
import { dueInfo, priorityLabel, repeatSummary, splitTitle } from '../lib/cards.js'
import { dialogQueuedLabel } from '../lib/delegation-outcomes.js'
import { isRecurring } from '../lib/occurrences.js'
import { holdActivity } from '../lib/reconciliation.js'
import { cardBinding } from '../lib/task-link.js'
import { boardPill, occurrenceDialog } from '../recurring/dialog.js'
import { hasHermesTask, TaskSection, taskNotes } from '../task-link/TaskSection.jsx'
import { DialogHead, MetaPills, StatusPill } from './shell.jsx'

// The host drawer's own body classes, so the dialog sizes and scrolls the same way.
const BODY = 'flex max-h-[min(84vh,54rem)] flex-col gap-0 overflow-hidden p-0'

const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const when = iso => (iso ? DATE_TIME.format(new Date(iso)) : null)

export const COLUMN_TONES = { 'To do': 'muted', 'Ready for Agent': 'agent', 'In progress': 'active', 'Needs you': 'attention', Done: 'done' }

export function TaskDialog({ actions, card, onClose, onCloseAutoFocus }) {
  // A Hermes task opens with the caret in its reply box (the composer focuses itself once loaded),
  // not with a focus ring on the first header action.
  // A copied task link (ticket 25) is not this reminder's task: it opens as a plain reminder.
  // Nor is a reminder another Mac's Hermes has: its task is not on this Mac to show.
  const linked = Boolean(card && hasHermesTask(card) && !card.linkCopy && card.agent?.status !== 'elsewhere')
  return (
    <Dialog onOpenChange={open => !open && onClose()} open>
      <DialogContent
        aria-describedby={undefined}
        bodyClassName={linked ? `${BODY} rk-task-dialog-body` : BODY}
        className={`rk-task-dialog max-w-none${linked ? ' rk-task-dialog-tall' : ''}${linked && (card?.agent?.column === 'Ready for Agent' || card?.agent?.status === 'ready' || card?.agent?.waiting) ? ' rk-task-dialog-brief' : ''}`}
        onCloseAutoFocus={onCloseAutoFocus}
        onOpenAutoFocus={linked ? event => (event.preventDefault(), event.currentTarget?.focus?.()) : undefined}
        showCloseButton={false}
      >
        <div className="rk-task">{card ? <Details actions={actions} card={card} onClose={onClose} /> : <Gone onClose={onClose} />}</div>
      </DialogContent>
    </Dialog>
  )
}

function Gone({ onClose }) {
  return (
    <>
      <DialogHead onClose={onClose} title={<DialogTitle className="rk-task-title">Reminder not on the board</DialogTitle>} />
      <div className="rk-task-body">
        <p className="rk-gone">It was deleted, moved to another list, or its list was removed from the board.</p>
      </div>
    </>
  )
}

/** Owner, list, due and priority, as the header's meta pills. A reminder with a Hermes task is
 *  the agent's, whatever its title label says. */
export function metaFor(card, occurrence = occurrenceDialog(card)) {
  const source = card.source
  const due = dueInfo(source.due)
  const priority = priorityLabel(source.priority)
  return [
    // A stopped task's reminder is yours again, though it keeps its Hermes task link.
    card.owner === 'agent' || (hasHermesTask(card) && !card.linkCopy && !occurrence.yours && card.agent?.status !== 'stopped' && !card.finishedBefore) ? { label: 'Agent', tone: 'agent' } : { label: 'You' },
    { label: source.calendarTitle },
    due && { label: `Due ${due.near === due.label ? due.label : due.near.charAt(0).toLowerCase() + due.near.slice(1)}`, tone: due.overdue && !source.completed ? 'overdue' : undefined, sr: due.overdue && !source.completed ? 'Overdue.' : undefined },
    occurrence.pill,
    priority && { label: `${priority} priority` }
  ]
}

function Details({ actions, card, onClose }) {
  const source = card.source
  const { text } = splitTitle(source.title)
  const title = (
    <DialogTitle className="rk-task-title" data-selectable-text="true" dir="auto">
      {text}
    </DialogTitle>
  )
  // A repeating reminder's occurrence (ticket 21): which one Hermes has, or that this one is yours.
  const occurrence = occurrenceDialog(card)
  const meta = <MetaPills items={metaFor(card, occurrence)} />
  const details = <ReminderDetails keepLink={Boolean(card.linkCopy)} source={source} />

  const elsewhere = card.agent?.status === 'elsewhere'
  if (hasHermesTask(card) && !card.linkCopy && !elsewhere) {
    return (
      <TaskSection
        binding={cardBinding(card)}
        foreign={card.claim === 'foreign'}
        details={details}
        earlier={occurrence.earlier}
        knownLabels={occurrence.labels}
        paused={occurrence.paused}
        previous={occurrence.previous}
        upcoming={occurrence.upcoming}
        footer={actions}
        hold={holdActivity(card.agent)}
        meta={meta}
        occurrence={occurrence.key}
        onClose={onClose}
        queuedLabel={dialogQueuedLabel(card.agent, isRecurring(card))}
        // With pickup off a usage wait won't retry by itself: no recovery line promising a next check.
        recoveryRow={card.agent?.row && !card.agent.row.scope && !card.agent.pickupOff ? (card.agent.recoveryRow ?? card.agent.row) : null}
        repeating={isRecurring(card)}
        // A stopped reminder you started or finished yourself reads as your own work, like its card.
        pill={occurrence.yours || card.finishedBefore || (card.agent?.status === 'stopped' && (card.column === 'In progress' || card.column === 'Done')) ? <StatusPill label={card.column} tone={COLUMN_TONES[card.column]} /> : boardPill(card) ? <StatusPill {...boardPill(card)} /> : undefined}
        source={source}
        title={title}
      />
    )
  }

  return (
    <>
      <DialogHead meta={meta} onClose={onClose} pill={elsewhere ? <span id={`rk-elsewhere-pill-${card.id}`}><StatusPill label={card.agent.label} tone="muted" /></span> : <StatusPill label={card.column} tone={COLUMN_TONES[card.column]} />} title={title} />
      <div className="rk-task-body" data-selectable-text="true">
        {card.linkCopy && (
          <p className="rk-copy-note" role="note">
            <Codicon name="link" size="0.8rem" />
            <span>Its notes have another reminder's task link. That task stays with the original reminder.</span>
          </p>
        )}
        {details}
      </div>
      {actions && <div className="rk-task-foot">{actions}</div>}
    </>
  )
}

/** Notes, link, location and the remaining properties (list, due and priority are meta pills). */
/** keepLink: show the notes whole, task link line included (a copied link, for inspection). */
export function ReminderDetails({ keepLink = false, source }) {
  const notes = keepLink ? (source.notes ?? '') : taskNotes(source)
  const repeats = repeatSummary(source.rules)
  const alarms = source.alarms?.length ?? 0
  // Only what the reminder has: no "None" rows.
  const properties = [
    ['Repeats', repeats],
    ['Alarms', alarms ? (alarms === 1 ? '1 alarm' : `${alarms} alarms`) : null],
    ['Completed', when(source.completedAt)],
    ['Created', when(source.created)],
    ['Modified', when(source.modified)]
  ].filter(([, value]) => value)
  return (
    <>
      {notes && (
        <section className="rk-section">
          <h3 className="rk-label">Notes</h3>
          <p className="rk-notes" dir="auto">{notes}</p>
        </section>
      )}
      {source.url && (
        <section className="rk-section">
          <h3 className="rk-label">Link</h3>
          <button className="rk-link" onClick={() => void pluginContext()?.os.openExternal(source.url)} type="button">
            {source.url}
          </button>
        </section>
      )}
      {source.location && (
        <section className="rk-section">
          <h3 className="rk-label">Location</h3>
          <p className="rk-notes">{source.location}</p>
        </section>
      )}
      {properties.length > 0 && <dl className="rk-section rk-props">
        {properties.map(([name, value]) => (
          <div key={name}>
            <dt className="rk-label">{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>}
    </>
  )
}
