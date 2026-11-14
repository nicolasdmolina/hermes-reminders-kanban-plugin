// A repeating reminder in the task dialog (tickets 21 and 23): the Delegate menu that asks which
// occurrences go to Hermes, and the footer for the occurrence Hermes has.
import { Button, Codicon, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, host, Tip } from '@hermes/plugin-sdk'
import { useContext, useEffect, useRef, useState } from 'react'

import { openRemindersApp } from '../api/client.js'
import { RerunAsk } from '../delegation/Agent.jsx'
import { dueInfo } from '../lib/cards.js'
import { acceptUnsure, advanceQuestion, isRecurring, notDue, occurrenceStoppable, rerunMode, retryRequest, SCOPES, seriesHeldText, sourcePaused } from '../lib/occurrences.js'
import { BILLING_ROUTE, REPAIR_ROUTE } from '../recovery/Recovery.jsx'
import { TaskViewContext } from './taskView.js'
import './styles.js'

/**
 * Delegate ▾ for a repeating reminder that Hermes doesn't have: This occurrence (its own due date)
 * or Every occurrence (this one and each later one once it's due, under the same instructions).
 * Only a choice here delegates: opening the card, a link or a filter never does. Opens by itself
 * when the card was dropped on Ready for Agent. Both items delegate through the editor, so the card
 * moves and settles (or snaps back with a reason) the same way a one-off drag does.
 */
export function DelegateChoice({ card, editor, recurring }) {
  const shown = Boolean(card && editor && isRecurring(card) && !card.agent && card.column !== 'Done')
  const [open, setOpen] = useState(false)
  const asked = shown && recurring.asking === card.id
  useEffect(() => {
    if (!asked) return
    setOpen(true)
    recurring.settleAsking()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked])
  if (!shown) return null

  const busy = Boolean(editor.pending[card.id])
  const pickup = recurring.agent.pickup
  const refused = editor.unsure ? 'Check the last save first' : pickup == null ? 'Agent pickup is still loading' : !pickup ? (recurring.agent.error || (recurring.agent.data && recurring.agent.data.status !== 'ok') ? "Agent pickup isn't available" : 'Turn on agent pickup first') : null
  const date = dueInfo(card.source?.due)?.label
  const delegate = action => () => void editor.move(card, 'Ready for Agent', { verdict: { kind: 'delegation', action } })

  return (
    <div className="rk-agent-actions">
      {refused && (
        <span className="rk-agent-why" id={`rk-occ-why-${card.id}`}>
          {refused}
        </span>
      )}
      <DropdownMenu modal={false} onOpenChange={setOpen} open={open && !refused && !busy}>
        <DropdownMenuTrigger asChild>
          <Button aria-describedby={refused ? `rk-occ-why-${card.id}` : undefined} disabled={Boolean(refused) || busy} size="xs" variant="secondary">
            <Codicon name="hubot" size="0.75rem" />
            <span>{busy ? 'Delegating…' : 'Delegate'}</span>
            <Codicon name="chevron-down" size="0.7rem" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="rk-occ-menu">
          <DropdownMenuItem className="rk-occ-item" onSelect={delegate('ready')}>
            <span>{SCOPES.this_occurrence}</span>
            {date && <span className="rk-occ-when">{date}</span>}
          </DropdownMenuItem>
          <DropdownMenuItem className="rk-occ-item" onSelect={delegate('every')}>
            <span>{SCOPES.every_occurrence}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/**
 * Footer for a delegated occurrence (ticket 13's AgentActions leaves occurrence tasks to this).
 * - Needs reconciliation: the thread says what changed (pauseText). This board never guesses a
 *   match or carries the work forward, so the action is to look at the reminder in Reminders.
 * - Paused for an owner check: says so, with no bypass.
 * - Queued or running: Stop, ticket 13's button and wording, through the occurrence route. The
 *   reminder stays open and keeps its date and repeat; the card goes back to To do as Stopped.
 * - Paused by a change in Reminders, or stopped: Run again for the reminder's date (rerunMode).
 *   When Hermes already did work, pressing it first asks, in place of the footer, whether running
 *   again may repeat that work (ConfirmRerun); confirming records the owner's consent, then reruns.
 */
export function OccurrenceActions({ card, editor, onClose, recurring }) {
  const view = useContext(TaskViewContext)
  const [asking, setAsking] = useState(false)
  const agent = card?.agent
  const row = agent?.row
  if (!row?.scope) return null
  // Every occurrence between occurrences: Hermes prepares the next one, or retries reading
  // Reminders on its next check; nothing to do here.
  if (row.status === 'series_next' || row.status === 'series_waiting') return null
  // A series Hermes held: you decide whether it keeps going or stops repeating with Hermes.
  if (row.status === 'series_held') return <SeriesDecision card={card} editor={editor} recurring={recurring} />
  // Run again on its way: busy in the same place until the new run is on the board.
  const sending = recurring?.rerunning?.(card.id)
  if (sending === 'confirm') return <RerunAsk id={card.id} onCancel={() => {}} onConfirm={() => {}} sending />
  if (sending) {
    return (
      <div className="rk-agent-actions">
        <Button disabled size="xs">
          <Codicon name="debug-restart" size="0.75rem" />
          <span>Starting…</span>
        </Button>
      </div>
    )
  }
  // The conversation's attempts are the task's Hermes runs, once it shows this occurrence.
  const showing = view?.kind === 'resolved' && view.selectedOccurrence === row.key
  const runs = showing ? view.attempts : null
  // Consent covers the work on screen: only while the dialog shows this occurrence's own run.
  const possible = rerunMode(row, runs, card.source)
  const mode = possible === 'confirm' && !showing ? null : possible
  if (asking && mode === 'confirm') {
    return <ConfirmRerun card={card} editor={editor} onCancel={() => setAsking(false)} recurring={recurring} />
  }
  // The date moved while a result waited: the owner says which (a check-off, or a moved date).
  if (advanceQuestion(row)) return <AdvanceQuestion card={card} editor={editor} onMoved={() => setAsking(true)} recurring={recurring} />
  const again = mode ? <RunAgain card={card} editor={editor} onAsk={mode === 'confirm' ? () => setAsking(true) : null} recurring={recurring} /> : null
  if (row.status === 'stopped') return again && <div className="rk-agent-actions">{again}</div>
  // Every occurrence before its due time: Stop ends it (later occurrences too).
  // Not when its date moved or its last run needs a check: those say so below, with Run again.
  if ((agent.notDue || notDue(row)) && row.task_id && !sourcePaused(row) && row.status !== 'needs_reconciliation') return <OccurrenceStop card={card} editor={editor} recurring={recurring} />
  // A failed run the owner check cleared: Retry starts a new attempt on the same occurrence.
  if (agent.action === 'retry' && retryRequest(row)) {
    return (
      <OccurrenceStop after={<OccurrenceRetry card={card} editor={editor} recurring={recurring} />} card={card} editor={editor} recurring={recurring} />
    )
  }
  // A capacity wait is queued work: Stop, never the owner-check line.
  if (agent.waiting && row.task_id) return <OccurrenceStop card={card} editor={editor} recurring={recurring} />
  // A failed run that needs you (a check, funds, a sign-in): what to do, the way there, and Stop,
  // as a one-off task's recovery row and Stop say it.
  const rec = agent.recovery
  if (rec && rec.action !== 'wait' && rec.action !== 'retry' && row.task_id && row.status !== 'needs_reconciliation' && !sourcePaused(row)) {
    return (
      <OccurrenceStop
        // Stop, then the way forward at the edge: the same order as a one-off task's footer.
        after={
          rec.control === 'billing' ? (
            <Button onClick={() => (onClose?.(), host.navigate(BILLING_ROUTE))} size="xs" variant="secondary">
              Open billing
            </Button>
          ) : rec.control === 'repair' ? (
            <Button onClick={() => (onClose?.(), host.navigate(REPAIR_ROUTE))} size="xs" variant="secondary">
              Repair sign-in
            </Button>
          ) : null
        }
        card={card}
        editor={editor}
        recurring={recurring}
      >
        {rec.line?.text && <span className="rk-agent-why">{rec.line.text}</span>}
      </OccurrenceStop>
    )
  }
  // The link write failed and Hermes won't write it twice: Stop is the way out on the board.
  if (agent.status === 'preparation_attention' && row.task_id) {
    return (
      <OccurrenceStop card={card} editor={editor} recurring={recurring}>
        <span className="rk-agent-why">Hermes couldn't add its link to this reminder. Stop it to take it back.</span>
      </OccurrenceStop>
    )
  }
  // The board's effective state: a queued occurrence held by admission reads paused on its row.
  if (agent.status === 'paused' && row.status !== 'needs_reconciliation' && !sourcePaused(row)) {
    return (
      <div className="rk-agent-actions">
        <span className="rk-agent-why">Hermes is checking the last run before it resumes</span>
      </div>
    )
  }
  // Queued or running: Stop. A question gets the conversation's reply box, as a one-off task does.
  if (occurrenceStoppable(agent, row)) {
    return <OccurrenceStop card={card} editor={editor} recurring={recurring} />
  }
  if (row.status !== 'needs_reconciliation' && !sourcePaused(row)) return null
  // A Stop whose termination is uncertain: ticket 13's words; Reminders didn't change.
  if (row.stop_intent) {
    return (
      <div className="rk-agent-actions">
        <span className="rk-agent-why" data-tone="danger" role="status">
          Hermes couldn't confirm it stopped. It stays here until that's checked.
        </span>
      </div>
    )
  }
  // Accepted, but Hermes couldn't confirm the check-off: nothing changed in Reminders, so say what to do.
  if (acceptUnsure(row)) {
    return (
      <OccurrenceStop card={card} editor={editor} recurring={recurring}>
        <span className="rk-agent-why">Hermes couldn't confirm it checked this off. Check the reminder in Reminders, or stop it to take it back.</span>
        <OpenReminders />
      </OccurrenceStop>
    )
  }
  // The thread says what paused it (its live line). Run again is the main way forward when it can
  // work; Stop ends this occurrence and leaves the reminder open with its new date.
  return (
    <OccurrenceStop card={card} editor={editor} primary={!again} recurring={recurring} after={again}>
      <OpenReminders />
    </OccurrenceStop>
  )
}

/** A held Every occurrence series: Keep going (asked first, naming what held it, like Run again's
 *  ask) or Stop repeating with Hermes. Open Reminders to look first. A refusal says why beside them. */
function SeriesDecision({ card, editor, recurring }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(null)
  const [problem, setProblem] = useState(null)
  const inFlight = useRef(false)
  const decide = async decision => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(decision)
    setProblem(null)
    const outcome = await recurring.resolveSeries(card, decision)
    inFlight.current = false
    setBusy(null)
    if (outcome.superseded) return
    setAsking(false)
    if (!outcome.ok) setProblem(outcome.message)
    else editor?.announce?.(outcome.message)
  }
  if (asking) {
    return (
      <RerunAsk
        busyLabel="Starting…"
        id={card.id}
        label="Keep going"
        onCancel={() => setAsking(false)}
        onConfirm={() => void decide('reauthorize')}
        sending={busy === 'reauthorize'}
        text={`${seriesHeldText(card.agent.row)}. Keep going anyway, using the reminder as it is in Reminders now?`}
      />
    )
  }
  return (
    <div className="rk-agent-actions">
      {problem && (
        <span className="rk-agent-why" data-tone="danger" role="alert">
          {problem}
        </span>
      )}
      <OpenReminders />
      <Button disabled={Boolean(busy)} onClick={() => void decide('end')} size="xs" variant="secondary">
        <span>{busy === 'end' ? 'Stopping…' : 'Stop repeating with Hermes'}</span>
      </Button>
      <Button disabled={Boolean(busy)} onClick={() => setAsking(true)} size="xs">
        <Codicon name="debug-continue" size="0.75rem" />
        <span>Keep going</span>
      </Button>
    </div>
  )
}

/** Open Reminders: the reminder is where a change or a held series gets settled. */
function OpenReminders() {
  return (
    <Button onClick={openRemindersApp} size="xs" variant="ghost">
      <Codicon name="link-external" size="0.75rem" />
      <span>Open Reminders</span>
    </Button>
  )
}

/** Retry for an occurrence's failed run (recurring-contract.md `retry`): its occurrence key and
 *  that run, through /recurring/actions. A refusal says so beside it. */
function OccurrenceRetry({ card, editor, recurring }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState(null)
  const retry = async () => {
    setBusy(true)
    setProblem(null)
    const outcome = await recurring.act('retry', card)
    setBusy(false)
    if (outcome.superseded) return
    if (outcome.result?.status !== 'ok') setProblem(outcome.message ?? outcome.shown?.message)
    else editor?.announce?.(outcome.message ?? 'Retry started.')
  }
  return (
    <>
      {problem && (
        <span className="rk-agent-why" data-tone="danger" role="alert">
          {problem}
        </span>
      )}
      <Button disabled={busy} onClick={() => void retry()} size="xs">
        <Codicon name="debug-restart" size="0.75rem" />
        <span>{busy ? 'Retrying…' : 'Retry'}</span>
      </Button>
    </>
  )
}

/** "Did you check it off in Reminders?" when the date moved while a result waited. Yes accepts the
 *  saved result (the next date waits in To do, with no run); No records a moved date, then asks
 *  before running again (RerunAsk: confirm, rerun). Stop stays, unless it already stopped. */
function AdvanceQuestion({ card, editor, onMoved, recurring }) {
  const [busy, setBusy] = useState(null)
  // Guards a second click that lands before the re-render disables the buttons.
  const inFlight = useRef(false)
  const row = card.agent.row
  const moved = dueInfo(row.new_due ?? card.source?.due)
  const date = moved?.label
  // Before that date, running it starts Hermes at once (as on Run again): say now, not the date.
  const early = Boolean(moved && moved.date.getTime() > Date.now())
  const answer = async which => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(which)
    const outcome = await recurring.resolve(card, which)
    inFlight.current = false
    setBusy(null)
    if (outcome.superseded || outcome.result?.status !== 'ok') return
    if (which === 'date_moved') onMoved()
    else editor?.announce?.('Done. The next date waits in To do.')
  }
  const ask = `rk-advance-ask-${card.id}`
  // The question and its answers stay one group, so a narrow dialog wraps them together.
  const answers = (
    <div aria-labelledby={ask} className="rk-occ-ask" role="group">
      <span className="rk-agent-ask" id={ask}>
        Did you check it off in Reminders?
      </span>
      <span className="rk-occ-answers">
        <Button disabled={Boolean(busy)} onClick={() => void answer('date_moved')} size="xs" variant="secondary">
          <Codicon name="debug-restart" size="0.75rem" />
          <span>{busy === 'date_moved' ? 'Saving…' : early ? 'No, run it now' : date ? `No, run again for ${date}` : 'No, run again'}</span>
        </Button>
        <Button disabled={Boolean(busy)} onClick={() => void answer('checked_off')} size="xs">
          <Codicon name="check" size="0.75rem" />
          <span>{busy === 'checked_off' ? 'Saving…' : "Yes, it's done"}</span>
        </Button>
      </span>
    </div>
  )
  if (row.status === 'stopped') return <div className="rk-agent-actions">{answers}</div>
  return <OccurrenceStop after={answers} card={card} editor={editor} recurring={recurring} />
}

/** Ticket 13's Stop for an occurrence: no confirm step (like core chat's Stop), busy while it runs.
 *  primary: the dialog's main action (a paused occurrence). children: actions shown before it. */
function OccurrenceStop({ after = null, card, children = null, editor, primary = false, recurring }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState(null)
  const stop = async () => {
    setBusy(true)
    setProblem(null)
    const outcome = await recurring.act('stop', card)
    setBusy(false)
    if (outcome.superseded) return
    if (outcome.result?.status !== 'ok') setProblem(outcome.message ?? outcome.shown?.message)
    else editor?.announce?.(outcome.shown?.message ?? 'Stopped. The reminder stays open.')
  }
  return (
    <div className="rk-agent-actions">
      {problem && (
        <span className="rk-agent-why" data-tone="danger" role="alert">
          {problem}
        </span>
      )}
      {children}
      <Tip label="Stop Hermes · the reminder stays open">
        <Button disabled={busy} onClick={() => void stop()} size="xs" variant={primary ? 'default' : 'secondary'}>
          <span aria-hidden className="rk-stop-glyph" />
          <span>{busy ? 'Stopping…' : 'Stop'}</span>
        </Button>
      </Tip>
      {after}
    </div>
  )
}

/** Run again for the reminder's date: a new run of this occurrence; the old one stays as history.
 *  onAsk: Hermes already did work, so pressing it asks first (ConfirmRerun). A refusal shows as
 *  the dialog's pause line (useRecurring keeps it), not here. */
function RunAgain({ card, editor, onAsk = null, recurring }) {
  const [busy, setBusy] = useState(false)
  const due = dueInfo(card.source?.due)
  const date = due?.label
  // Before its date, running it starts Hermes at once, not on that date: the button says so.
  const early = Boolean(due && due.date.getTime() > Date.now())
  const run = async () => {
    if (onAsk) return onAsk()
    setBusy(true)
    const outcome = await recurring.act('rerun', card)
    setBusy(false)
    if (outcome.superseded) return
    editor?.announce?.(outcome.message ?? outcome.shown?.message ?? '')
  }
  return (
    <Button disabled={busy} onClick={() => void run()} size="xs">
      <Codicon name="debug-restart" size="0.75rem" />
      <span>{busy ? 'Starting…' : early ? 'Run now' : date ? `Run again for ${date}` : 'Run again'}</span>
    </Button>
  )
}

/** Run again after Hermes did work, asked first with ticket 13's prompt: confirming stops a
 *  paused occurrence, records the consent on its latest finished run (confirm_rerun) and reruns it. */
function ConfirmRerun({ card, editor, onCancel, recurring }) {
  const [busy, setBusy] = useState(false)
  // Guards a second click that lands before the re-render disables the buttons.
  const inFlight = useRef(false)
  const go = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    const outcome = await recurring.act('rerun-confirmed', card)
    inFlight.current = false
    setBusy(false)
    if (outcome.superseded) return
    editor?.announce?.(outcome.message ?? outcome.shown?.message ?? '')
    onCancel()
  }
  return <RerunAsk id={card.id} onCancel={onCancel} onConfirm={() => void go()} sending={busy} />
}
