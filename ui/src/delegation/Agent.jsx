// Agent work on a card and in its task dialog: the state line in the tile's meta row, the
// dialog's Delegate action (the keyboard path for dragging into Ready for Agent), and the
// dialog's agent actions (Resume after changed instructions; stopping goes through Reminders).
import { Button, Codicon, Tip } from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'

import { openRemindersApp, pluginContext } from '../api/client.js'
import { rerunToConfirm } from '../lib/delegation-outcomes.js'
import { confirmArmed, elsewhereDialog, theirTaskLink } from '../lib/elsewhere.js'
import { moveVerdict } from '../lib/moves.js'
import { isRecurring, SCOPES } from '../lib/occurrences.js'
import { HELD, heldReason, SOURCE_WAIT } from '../lib/reconciliation.js'
import './styles.js'

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

/** "● Working", "● Waiting for a free slot", "● Answer Hermes" in the tile's meta row. */
export function AgentStatus({ agent }) {
  if (!agent) return null
  const next = agent.nextCheckAt ? CLOCK.format(new Date(agent.nextCheckAt)) : null
  return (
    <span className="rk-agent-state" data-action={agent.action ?? undefined} data-tone={agent.tone}>
      <span aria-hidden className="rk-agent-dot" data-tone={agent.tone} />
      {agent.label}
      {next && <span className="rk-agent-next">Next check {next}</span>}
    </span>
  )
}

/** Task dialog footer for a reminder that isn't delegated: Delegate (same as dragging it into
 *  Ready for Agent). Disabled with the reason when the move isn't allowed. A reminder whose title
 *  already carries the Ready label sits in Ready for Agent without a task when it arrived after
 *  activation; Delegate is its one way in, so it sends the same `ready` action directly. */
/** askFirst: opened by dragging a stopped task Hermes had started to Ready: start on the Run again ask. */
export function DelegateAction({ askFirst = false, card, delegation, editor }) {
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState(null)
  // A stopped task Hermes was partway through: the run it would repeat, while asking.
  const [asking, setAsking] = useState(() => (askFirst && card?.agent?.status === 'stopped' ? rerunToConfirm(card.agent.row) : null))
  // Guards a second click that lands before the re-render disables the buttons.
  const inFlight = useRef(false)
  // A stopped task is yours again and can be delegated afresh.
  if (!card || (card.agent && card.agent.status !== 'stopped') || card.finishedBefore || !editor || card.column === 'Done') return null
  // Repeating reminders ask which occurrence goes to Hermes, and a stopped occurrence offers Run
  // again: ticket 21's (ui/src/recurring/).
  if (isRecurring(card)) return null
  // Sent directly (not as a move) when there is no drag to mirror: a Ready-marked card already in
  // Ready for Agent, or a stopped task, whose refusal (an owner check first) shows right here.
  const marked = card.column === 'Ready for Agent' || card.agent?.status === 'stopped'
  const busy = Boolean(editor.pending[card.id]) || sending
  // While this sends, the button says so; a reason shows only for a real refusal or an answer.
  const verdict = marked
    ? moveVerdict({ ...card, column: 'To do' }, 'Ready for Agent', { pending: Boolean(editor.unsure), pickup: delegation.pickup })
    : moveVerdict(card, 'Ready for Agent', { pending: Boolean(editor.unsure), pickup: delegation.pickup })
  // Pickup that can't be turned on (Hermes dispatches by itself, or its state didn't load) says that,
  // not "turn it on first".
  const unavailable = Boolean(delegation.error) || Boolean(delegation.data && delegation.data.status !== 'ok')
  const refused = busy ? null : verdict?.refused ? (verdict.refused === 'pickup_off' && unavailable ? "Agent pickup isn't available" : verdict.refused === 'pending' && editor.unsure ? 'Check the last save first' : verdict.reason) : problem
  const finish = () => {
    inFlight.current = false
    setSending(false)
  }
  const send = async () => {
    // One submission at a time: no second Run again, and no Cancel once it is on its way.
    if (sending || inFlight.current) return
    if (!marked) return void editor.move(card, 'Ready for Agent')
    setProblem(null)
    // Hermes had started: say what running again means, inline, before anything is sent.
    const runId = card.agent?.status === 'stopped' ? rerunToConfirm(card.agent.row) : null
    if (runId != null && asking == null) return setAsking(runId)
    inFlight.current = true
    setSending(true)
    if (asking != null) {
      const confirmed = await delegation.confirmRerun(card, asking)
      setAsking(null)
      if (confirmed.superseded) return finish()
      if (!confirmed.ok) {
        finish()
        return setProblem(confirmed.message)
      }
    }
    const outcome = await delegation.act('ready', card)
    finish()
    if (outcome.superseded) return
    if (outcome.result?.status === 'ok') editor.announce?.('Delegated. Hermes picks it up when a slot is free.')
    else setProblem(outcome.message ?? outcome.shown?.short ?? "Couldn't hand it to Hermes")
  }
  if (asking != null) return <RerunAsk id={card.id} onCancel={() => setAsking(null)} onConfirm={() => void send()} sending={sending} />
  const button = (
    <Button
      aria-describedby={refused ? `rk-delegate-why-${card.id}` : undefined}
      disabled={Boolean(verdict?.refused) || busy}
      onClick={() => void send()}
      size="xs"
      variant="secondary"
    >
      <Codicon name="hubot" size="0.75rem" />
      <span>{busy ? 'Delegating…' : 'Delegate'}</span>
    </Button>
  )
  return (
    <div className="rk-agent-actions">
      {refused ? (
        <>
          <span className="rk-agent-why" id={`rk-delegate-why-${card.id}`} role={problem ? 'status' : undefined}>
            {refused}
          </span>
          {button}
        </>
      ) : (
        <Tip label="Send to Hermes · same as dragging to Ready for Agent">{button}</Tip>
      )}
    </div>
  )
}

/** Task dialog footer for a reminder another Mac's Hermes is working on (lib/elsewhere.js): a way
 *  to its task there when that Mac wrote a link, and Take over here. The pill already says whose
 *  it is. Take over asks once, then delegates here like any other reminder; a repeating one asks
 *  which occurrence. It stays busy until the board shows this Mac's task. */
export function ElsewhereActions({ card, delegation, editor, recurring }) {
  const [phase, setPhase] = useState('idle')
  // What is being sent: true for a one-off, else the occurrence choice pressed.
  const [sending, setSending] = useState(null)
  const [problem, setProblem] = useState(null)
  const inFlight = useRef(false)
  const backToButton = useRef(false)
  // When the ask (or the occurrence choice) appeared: it sits where the pressed button was, so a
  // double-click's second click is not taken as the answer.
  const shownAt = useRef(0)
  const show = next => {
    shownAt.current = Date.now()
    setPhase(next)
  }
  // Cancel puts focus back on Take over here, not on the page.
  useEffect(() => {
    if (phase !== 'idle' || !backToButton.current) return
    backToButton.current = false
    document.getElementById(`rk-take-over-${card?.id}`)?.focus()
  }, [phase])
  const unavailable = Boolean(delegation?.error) || Boolean(delegation?.data && delegation.data.status !== 'ok')
  const model = elsewhereDialog(card, { pickup: delegation?.pickup, unavailable, unsure: Boolean(editor?.unsure) })
  if (!model || !editor) return null
  const cancel = () => {
    backToButton.current = true
    setPhase('idle')
  }
  const send = async choice => {
    if (inFlight.current || !confirmArmed(shownAt.current)) return
    inFlight.current = true
    setSending(choice ?? true)
    setProblem(null)
    const settle = message => {
      inFlight.current = false
      setSending(null)
      // A failed take over puts focus back on Take over here, with why beside it.
      if (message) backToButton.current = true
      setPhase('idle')
      if (message) setProblem(message)
    }
    // This Mac had started it before the other one took it: taking it back may repeat that work.
    if (model.rerun != null) {
      const confirmed = await delegation.confirmRerun({ agent: { row: card.agent.prior } }, model.rerun)
      if (confirmed.superseded) return settle(null)
      if (!confirmed.ok) return settle(confirmed.message)
    }
    // Both wait for the board's own read, so this footer is busy until the card is this Mac's.
    const outcome = await (choice ? recurring.takeOver(card, choice) : delegation.takeOver(card))
    if (outcome.superseded) return settle(null)
    if (outcome.result?.status !== 'ok') return settle(outcome.message ?? outcome.shown?.short ?? "Couldn't hand it to Hermes")
    settle(null)
    editor.announce?.('Taken over. Hermes picks it up when a slot is free.')
  }
  if (phase === 'ask') {
    return (
      <RerunAsk
        busyLabel={model.takeOver.busy}
        id={card.id}
        label={model.ask.confirm}
        onCancel={cancel}
        onConfirm={() => (model.choices ? confirmArmed(shownAt.current) && show('choose') : void send(null))}
        sending={Boolean(sending)}
        text={model.ask.text}
      />
    )
  }
  if (phase === 'choose') {
    return (
      <div aria-label={model.takeOver.label} className="rk-agent-actions" role="group">
        <Button disabled={Boolean(sending)} onClick={cancel} size="xs" variant="text">
          {model.ask.cancel}
        </Button>
        <Button autoFocus disabled={Boolean(sending)} onClick={() => void send('ready')} size="xs" variant="secondary">
          {sending === 'ready' ? model.takeOver.busy : SCOPES.this_occurrence}
        </Button>
        <Button disabled={Boolean(sending)} onClick={() => void send('every')} size="xs" variant="secondary">
          {sending === 'every' ? model.takeOver.busy : SCOPES.every_occurrence}
        </Button>
      </div>
    )
  }
  const why = problem ?? model.takeOver.refused
  // Described by the dialog's pill ("On <Mac>"), and by why it can't be taken over right now.
  const describedBy = `rk-elsewhere-pill-${card.id}${why ? ` rk-elsewhere-why-${card.id}` : ''}`
  return (
    <div className="rk-agent-actions">
      {why && (
        <span className="rk-agent-why" data-tone={problem ? 'danger' : undefined} id={`rk-elsewhere-why-${card.id}`} role={problem ? 'alert' : undefined}>
          {why}
        </span>
      )}
      {model.open && (
        <Button onClick={() => void pluginContext()?.os.openExternal(model.open.url)} size="xs" variant="ghost">
          <Codicon name="link-external" size="0.75rem" />
          <span>{model.open.label}</span>
        </Button>
      )}
      <Button aria-describedby={describedBy} disabled={Boolean(model.takeOver.refused) || Boolean(sending)} id={`rk-take-over-${card.id}`} onClick={() => show('ask')} size="xs" variant="secondary">
        <Codicon name="hubot" size="0.75rem" />
        <span>{sending ? model.takeOver.busy : model.takeOver.label}</span>
      </Button>
    </div>
  )
}

/** Task dialog footer for a finished reminder that carries the other Mac's task link: a way to
 *  that task (lib/elsewhere.js theirTaskLink). */
export function TheirTaskAction({ card }) {
  const link = theirTaskLink(card)
  if (!link) return null
  return (
    <div className="rk-agent-actions">
      <Button onClick={() => void pluginContext()?.os.openExternal(link.url)} size="xs" variant="ghost">
        <Codicon name="link-external" size="0.75rem" />
        <span>{link.label}</span>
      </Button>
    </div>
  )
}

/** The inline ask before running again work Hermes had started (Run again / Cancel). Shared with
 *  ticket 21's Run again for a repeating reminder's occurrence, so both read and look the same. */
export function RerunAsk({ id, onCancel, onConfirm, sending, text = 'Hermes was partway through. Running again may repeat what it already did.', label = 'Run again', busyLabel = 'Starting…' }) {
  return (
    <div className="rk-agent-actions" role="group" aria-label={`${label}?`}>
      <span className="rk-agent-ask" id={`rk-rerun-ask-${id}`}>
        {text}
      </span>
      <Button disabled={sending} onClick={onCancel} size="xs" variant="text">
        Cancel
      </Button>
      <Button aria-describedby={`rk-rerun-ask-${id}`} autoFocus disabled={sending} onClick={onConfirm} size="xs">
        {sending ? busyLabel : label}
      </Button>
    </div>
  )
}

/** Task dialog footer for delegated work that the conversation doesn't already act on:
 *  Resume (ticket 11's explicit resume for the current instruction version), the owner check
 *  that Resume waits for, and Stop for queued or running work. */
export function AgentActions({ card, delegation, editor }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState(null)
  const agent = card?.agent
  // A repeating reminder's occurrence has its own footer (ticket 21, recurring/Occurrence.jsx).
  if (!agent || agent.row?.scope) return null
  const resume = async () => {
    setBusy(true)
    setProblem(null)
    const outcome = await delegation.act('resume', card)
    setBusy(false)
    if (outcome.superseded) return
    if (outcome.result?.status !== 'ok') setProblem(outcome.message ?? outcome.shown?.message)
    else {
      editor?.announce?.('Resumed. Hermes picks it up again.')
      void editor?.refreshBoard?.()
    }
  }
  if (agent.action === 'resume') {
    return (
      <div className="rk-agent-actions">
        {problem && (
          <span className="rk-agent-why" data-tone="danger" role="alert">
            {problem}
          </span>
        )}
        <Button disabled={busy} onClick={() => void resume()} size="xs">
          <Codicon name="debug-continue" size="0.75rem" />
          <span>{busy ? 'Resuming…' : 'Resume'}</span>
        </Button>
      </div>
    )
  }
  // A Stop whose termination is uncertain lands here: say so, with no success state and no Stop.
  if (agent.status === 'needs_reconciliation' && agent.row?.stop_intent) {
    return (
      <div className="rk-agent-actions">
        <span className="rk-agent-why" data-tone="danger" role="status">
          Hermes couldn't confirm it stopped. It stays here until that's checked.
        </span>
      </div>
    )
  }
  // The card says "Check what happened": the footer says how, and Stop gives the reminder back.
  const unsure = agent.status === 'needs_reconciliation'
  // The link write failed and Hermes won't write it twice: Stop is the way out on the board.
  const unlinked = agent.status === 'preparation_attention'
  // Resume waits for an owner check the board can't give (ticket 11). Stop still gives the
  // reminder back (ticket 25: after a Reminders outage this is the one way out from here).
  const waiting = agent.action === 'reconcile' && agent.status === 'paused'
  // Nothing resumes these from the board: say what happened and the way forward (Stop, then delegate again).
  const guardReason = agent.row?.guard?.reason
  const waitingWhy = !waiting
    ? null
    : agent.stopUnverified
      ? "Hermes couldn't confirm the last run stopped"
      : guardReason === 'instructions_changed'
        ? 'The title or notes changed in Reminders. Stop it, then delegate again to use the new text.'
        : guardReason === 'source_ineligible'
          ? "This reminder changed in Reminders, so Hermes can't continue it. Stop it to take it back."
          : "Hermes can't pick this back up by itself. Stop it, then delegate again."
  if ((waiting || unsure) && !agent.row?.task_id) {
    return (
      <div className="rk-agent-actions">
        <span className="rk-agent-why">{waiting ? waitingWhy : "Hermes couldn't confirm how this ended. Check the reminder in Reminders."}</span>
      </div>
    )
  }
  // Stop needs the Hermes task id; a reminder still linking (no task yet) has none. A task whose last
  // attempt needs a check (ticket 17) can be stopped too: it comes back to you, and running it again
  // asks first (RerunAsk).
  // A task held on its reminder (ticket 25: replaced, missing, copied link, several matches, a
  // moved date) stays held whatever Hermes reads next: the ways out are the reminder (check it off)
  // and Stop, which gives it back to you. Never Resume, never a pick of another reminder.
  const held = agent.action === 'held' ? HELD[heldReason(agent.row)] : agent.action === 'source_wait' ? SOURCE_WAIT : null
  if ((agent.column === 'Ready for Agent' || agent.column === 'In progress' || agent.status === 'failed' || (agent.recovery && agent.recovery.action !== 'wait') || held || waiting || unsure || unlinked) && agent.row?.task_id) {
    // Stop ends Hermes' work at once and leaves the reminder open, like core chat's Stop (no
    // confirm step). Checking the reminder off in Reminders still stops it too.
    const stop = async () => {
      setBusy(true)
      setProblem(null)
      const outcome = await delegation.act('stop', card)
      setBusy(false)
      if (outcome.superseded) return
      if (outcome.result?.status !== 'ok') setProblem(outcome.message ?? outcome.shown?.message)
      else {
        editor?.announce?.(outcome.shown?.message ?? 'Stopped. The reminder stays open.')
        void editor?.refreshBoard?.()
      }
    }
    return (
      <div className="rk-agent-actions">
        {problem ? (
          <span className="rk-agent-why" data-tone="danger" role="alert">
            {problem}
          </span>
        ) : (
          (held || waiting || unsure || unlinked) && <span className="rk-agent-why">{held ? held.line : waiting ? waitingWhy : unlinked ? "Hermes couldn't add its link to this reminder. Stop it to take it back." : "Hermes couldn't confirm how this ended. Check the reminder in Reminders, or stop it to take it back."}</span>
        )}
        {held && held !== SOURCE_WAIT && (
          <Button onClick={openRemindersApp} size="xs" variant="ghost">
            Open Reminders
          </Button>
        )}
        <Tip label="Stop Hermes · the reminder stays open">
          <Button disabled={busy} onClick={() => void stop()} size="xs" variant="secondary">
            <span aria-hidden className="rk-stop-glyph" />
            <span>{busy ? 'Stopping…' : 'Stop'}</span>
          </Button>
        </Tip>
      </div>
    )
  }
  return null
}
