// Recovery states (ticket 17) for a delegated task, through the task conversation's own slots: the
// status pill, the one live line under the thread (core chat's scaffold row), and the footer row
// beside ticket 13's Resume and Stop. The backend decides the column and the one permitted action
// (recovery-contract.md); this only names them. Plain elements plus SDK Button, so the browser task
// page renders them through its SDK shim too.
import { Button } from '@hermes/plugin-sdk'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { currentRecovery, recoveryView, retryOutcome } from '../lib/recovery.js'
import { defineStyles } from '../styles.js'
import { StatusPill } from '../task/shell.jsx'
import css from './recovery.css'

defineStyles(css)

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const DAY_CLOCK = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const clock = date => (date.toDateString() === new Date().toDateString() ? CLOCK : DAY_CLOCK).format(date)

// Hermes settings, Providers, Accounts: where a provider sign-in is repaired.
export const REPAIR_ROUTE = '/settings?tab=providers&pview=accounts'
// Hermes settings, Billing: where Hermes sends a billing wall (store/billing-block.ts
// runBillingRecovery, without a provider URL). Opening it buys nothing.
export const BILLING_ROUTE = '/settings?tab=billing'
const ACTIONS_PATH = '/recovery/actions'

/**
 * The recovery to show for the task in the conversation, or null. `recovery` is the host's
 * { row, refresh?, onRepair? }: the task's delegation row (Desktop: the board card's; browser: the
 * row for this stable link). `view` is the resolved task (ticket 08's taskView), whose live state
 * keeps a stale row from covering a new attempt. Returns recoveryView plus `notice`, the live line.
 */
export function useTaskRecovery(recovery, view) {
  // Re-evaluate "due" now and then, so a passed next-check time reads as checking now.
  const [now, setNow] = useState(() => new Date())
  const row = recovery?.row && view && recovery.row.task_id === view.taskId ? recovery.row : null
  const current = view && !view.historical ? currentRecovery(row, view.state) : null
  const waiting = current?.action === 'wait'
  useEffect(() => {
    if (!waiting) return undefined
    const timer = setInterval(() => setNow(new Date()), 15_000)
    return () => clearInterval(timer)
  }, [waiting])
  const shown = recoveryView(current, { now, canRepair: Boolean(recovery?.onRepair) })
  if (!shown) return null
  const meta = shown.nextCheck ? (shown.due ? 'Checking now' : `Next check ${clock(shown.nextCheck)}`) : null
  return { ...shown, row, notice: { kind: waiting ? 'queued' : 'notice', label: shown.line.text, meta, since: null, recovery: true } }
}

/** The dialog's status pill for a recovering task. */
export const RecoveryPill = ({ rec }) => <StatusPill label={rec.label} tone={rec.tone} />

/**
 * The footer row for a recovering task: Retry (an ordinary failure), Repair sign-in or Open billing
 * (an empty balance), nothing for the rest (ticket 13's Stop covers a task that needs a check). api: the conversation's transport. onDone(): reread the task after a retry was sent.
 * While a retry is on its way the button stays focusable (aria-disabled), and once it starts a
 * confirmation takes its place. If this row goes away while it holds focus (the new attempt asks
 * or delivers), focus moves to the composer, never to the page.
 */
export function RecoveryActions({ api, onBilling, onDone, onRepair, rec, state }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState(null)
  // The attempt a Retry was sent for; its confirmation stays while the new attempt queues or runs.
  const [started, setStarted] = useState(null)
  const root = useRef(null)
  const confirmation = useRef(null)
  const attempt = rec ? `${rec.runId}:${rec.action}` : null
  // A new failure is a new row: no old refusal or confirmation carries over.
  useEffect(() => {
    if (!attempt) return
    setProblem(null)
    setStarted(current => (current && current !== attempt ? null : current))
  }, [attempt])
  useEffect(() => {
    if (started) confirmation.current?.focus({ preventScroll: true })
  }, [started])
  useLayoutEffect(
    () => () => {
      const node = root.current
      if (!node || !node.contains(document.activeElement)) return
      const page = node.closest('.rk-task') ?? document
      setTimeout(() => page.querySelector('.rk-composer-field, .rk-tl-board-foot button')?.focus({ preventScroll: true }), 0)
    },
    []
  )

  const running = !rec && ['active', 'ready', 'paused', 'failed'].includes(state)
  if (started && (running || attempt === started)) {
    return (
      <div className="rk-agent-actions rk-recovery-actions" ref={root}>
        <span className="rk-agent-why" ref={confirmation} role="status" tabIndex={-1}>
          Retry started.
        </span>
      </div>
    )
  }
  if (!rec?.control) return null

  const retry = async () => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    const sourceId = rec.row?.expected?.id
    try {
      const response = await api.post(ACTIONS_PATH, { action: 'retry', source_id: sourceId, run_id: rec.runId })
      const outcome = retryOutcome(response, sourceId)
      if (outcome.kind === 'started') setStarted(attempt)
      else setProblem(outcome.message)
    } catch (error) {
      if (String(error?.name) === 'SupersededError') return
      setProblem("Couldn't reach Hermes. Try again.")
    } finally {
      setBusy(false)
      // A slow owner can finish the retry after the request gives up: reread either way.
      onDone?.()
    }
  }

  return (
    <div className="rk-agent-actions rk-recovery-actions" ref={root}>
      {problem && (
        <span className="rk-agent-why" data-tone="danger" role="alert">
          {problem}
        </span>
      )}
      {rec.control === 'retry' ? (
        // Busy keeps the button focusable (aria-disabled, presses ignored): disabling the focused
        // button would drop keyboard focus to the page while the owner works.
        <Button aria-disabled={busy || undefined} disabled={rec.occupied} onClick={() => void retry()} size="xs">
          {busy ? 'Retrying…' : 'Retry'}
        </Button>
      ) : rec.control === 'billing' ? (
        <Button onClick={onBilling} size="xs" variant="secondary">
          Open billing
        </Button>
      ) : (
        <Button onClick={onRepair} size="xs" variant="secondary">
          Repair sign-in
        </Button>
      )}
    </div>
  )
}
