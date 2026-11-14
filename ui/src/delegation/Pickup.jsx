// Agent pickup controls: the header's Pickup control (a popover with running work, the board
// maximum, the model for new tasks and the on/off switch) and the same facts in onboarding's review step.
// Agent pickup is a host Switch, as core Settings renders every on/off row (ToggleRow).
// State comes from useDelegation (GET /delegation), never from the board envelope.
import { Button, Codicon, Dialog, DialogContent, DialogTitle, Popover, PopoverContent, PopoverTrigger, Switch, Tip } from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'

import { useTaskLinks } from '../api/task-link-setup.js'
import { problemText } from '../lib/delegation-outcomes.js'
import { linksFact, linksGate } from '../lib/link-setup.js'
import { readyCount } from '../lib/reconciliation.js'
import { LinkSetup, TaskLinksButton, TaskLinksFact } from '../link-setup/LinkSetup.jsx'
import { ModelPicker } from './ModelChoice.jsx'
import './styles.js'

const LOCAL = 'Phone access off'

const MAX = 10

/** 'on' | 'off' | 'loading' | 'unavailable', and why it is unavailable. */
export function pickupPhase(delegation) {
  if (delegation.error) return { phase: 'unavailable', why: problemText(null, delegation.error) }
  const data = delegation.data
  if (!data) return { phase: 'loading' }
  if (data.status !== 'ok') return { phase: 'unavailable', why: problemText(data) }
  return { phase: data.pickup_enabled ? 'on' : 'off' }
}

/** Board header: "Pickup off" / "Pickup on · 1/3", opening the pickup popover. */
export function PickupControl({ delegation, fallbackReady = 0 }) {
  const { phase, why } = pickupPhase(delegation)
  const limits = delegation.limits
  const gate = linksGate(useTaskLinks(delegation))
  const [open, setOpen] = useState(false)
  // Set up opens the link panel in its own dialog; the popover closes first so focus isn't fought over.
  const [linking, setLinking] = useState(false)
  const label = { on: 'Pickup on', off: 'Pickup off', loading: 'Pickup', unavailable: 'Pickup unavailable' }[phase]
  const local = phase === 'on' && gate.local
  return (
    <>
      <Popover
        onOpenChange={next => {
          setOpen(next)
          if (next) void delegation.reread()
        }}
        open={open}
      >
        <PopoverTrigger asChild>
          <Button aria-label={`Agent pickup: ${label.replace('Pickup ', '')}${phase === 'on' && limits ? `, ${limits.running} of ${limits.effective_limit} running` : ''}${local ? `, ${LOCAL.toLowerCase()}` : ''}`} className="rk-pickup-trigger" data-phase={phase} size="xs" variant="ghost">
            <span aria-hidden className="rk-pickup-dot" data-phase={phase} />
            <span>{label}</span>
            {phase === 'on' && limits && (
              <span className="rk-pickup-count">
                {limits.running}/{limits.effective_limit}
              </span>
            )}
            {local && <span className="rk-pickup-local">· {LOCAL}</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" aria-labelledby="rk-pickup-title" className="rk-pickup-pop">
          <PickupPanel
            delegation={delegation}
            gate={gate}
            onSetUp={() => {
              setOpen(false)
              setLinking(true)
            }}
            phase={phase}
            ready={readyCount(delegation, fallbackReady)}
            why={why}
          />
        </PopoverContent>
      </Popover>
      {linking && (
        <Dialog onOpenChange={next => !next && setLinking(false)} open>
          <DialogContent
            aria-describedby={undefined}
            className="rk-link-dialog max-w-none"
            // Radix returns focus only to a DialogTrigger: back to the pickup button it came from.
            onCloseAutoFocus={event => (event.preventDefault(), document.querySelector('.rk-pickup-trigger')?.focus())}
            showCloseButton={false}
          >
            <LinkSetup onDone={() => setLinking(false)} Title={DialogTitle} />
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

function PickupPanel({ delegation, gate, onSetUp, phase, ready, why }) {
  const limits = delegation.limits
  // Set up stays reachable whenever links need it, pickup on or off.
  const setUpLinks = Boolean(linksFact(useTaskLinks(delegation))?.action)
  const on = phase === 'on'
  return (
    <div className="rk-pickup">
      <div className="rk-pickup-head">
        <h2 id="rk-pickup-title">Agent pickup</h2>
        {phase === 'on' || phase === 'off' ? (
          <PickupSwitch delegation={delegation} gate={gate} on={on} ready={ready} />
        ) : (
          <span className="rk-pickup-state" data-phase={phase}>
            {phase === 'loading' ? 'Checking…' : 'Unavailable'}
          </span>
        )}
      </div>
      {phase === 'unavailable' ? (
        <p className="rk-pickup-problem" role="alert">
          {why}
        </p>
      ) : (
        <dl className="rk-pickup-facts">
          {on ? (
            <div>
              <dt>Running</dt>
              <dd>{limits ? `${limits.running} of ${limits.effective_limit}` : '—'}</dd>
            </div>
          ) : (
            <div>
              <dt>Ready to start</dt>
              <dd>{ready}</dd>
            </div>
          )}
          <div>
            <dt>Tasks at once</dt>
            <dd>
              <MaximumStepper delegation={delegation} />
            </dd>
          </div>
          {limits?.effective_limit != null && limits.effective_limit < limits.board_maximum && (
            <div>
              <dt>Hermes allows</dt>
              <dd>{limits.effective_limit}</dd>
            </div>
          )}
          {on && limits?.other_boards_running > 0 && (
            <div>
              <dt>Other boards running</dt>
              <dd>{limits.other_boards_running}</dd>
            </div>
          )}
          <div>
            <dt>Model</dt>
            <dd>
              <ModelPicker delegation={delegation} />
            </dd>
          </div>
          <TaskLinksFact delegation={delegation} inline={false} onSetUp={onSetUp} />
        </dl>
      )}
      {delegation.problem && phase !== 'unavailable' && (
        <p className="rk-pickup-problem" role="alert">
          {delegation.problem}
        </p>
      )}
      {setUpLinks && phase !== 'unavailable' && (
        <div className="rk-pickup-foot">
          <TaskLinksButton delegation={delegation} onSetUp={onSetUp} />
        </div>
      )}
    </div>
  )
}

/** Agent pickup as a Switch. Off → on runs activate, on → off runs deactivate (nothing new
 *  starts; running tasks finish). It shows the new state while that runs and drops back if it is
 *  refused (the row shows why). gate (linksGate): turning on waits for task links, or Only on
 *  this Mac, instead of failing after a click. A disabled switch gets no pointer or focus events,
 *  so its reason sits on a focusable wrapper. */
export function PickupSwitch({ delegation, gate = null, on, ready = null }) {
  const { activating, deactivating } = delegation
  const busy = activating || deactivating
  const waiting = !on && !busy && gate && !gate.ready
  const count = ready ?? delegation.eligible.length
  const control = (
    <Switch
      aria-label="Agent pickup"
      checked={on ? !deactivating : activating}
      disabled={busy || waiting}
      onCheckedChange={next => void (next ? delegation.activate() : delegation.deactivate())}
    />
  )
  if (waiting) {
    const reason = 'Set up task links first'
    return (
      <Tip label={reason}>
        <span aria-label={`Agent pickup, off. ${reason}`} className="rk-switch-hold" role="group" tabIndex={0}>
          {control}
        </span>
      </Tip>
    )
  }
  if (on || busy || count <= 0) return control
  // The enabled switch is the Tip's trigger itself, so the tip opens on keyboard focus too.
  return <Tip label={count === 1 ? 'Starts 1 Ready task' : `Starts ${count} Ready tasks`}>{control}</Tip>
}

/** Board maximum: − n +. Saves each step; a failed save puts the number back and says why. */
export function MaximumStepper({ delegation }) {
  const saved = delegation.limits?.board_maximum ?? null
  const [value, setValue] = useState(saved)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState(null)
  useEffect(() => {
    if (!saving) setValue(saved)
  }, [saved, saving])
  if (value == null) return <span>—</span>
  const change = async next => {
    if (next < 1 || next > MAX || saving) return
    setValue(next)
    setSaving(true)
    setProblem(null)
    const outcome = await delegation.setMaximum(next)
    setSaving(false)
    if (!outcome.ok) {
      setValue(saved)
      setProblem(outcome.problem)
    }
  }
  return (
    <span className="rk-stepper" data-busy={saving || undefined}>
      <Button aria-label="Fewer tasks at once" disabled={value <= 1 || saving} onClick={() => void change(value - 1)} size="icon-xs" variant="ghost">
        <Codicon name="remove" size="0.75rem" />
      </Button>
      <output aria-live="polite" className="rk-stepper-value">
        {value}
      </output>
      <Button aria-label="More tasks at once" disabled={value >= MAX || saving} onClick={() => void change(value + 1)} size="icon-xs" variant="ghost">
        <Codicon name="add" size="0.75rem" />
      </Button>
      {problem && (
        <Tip label={problem}>
          <span aria-label={problem} className="rk-stepper-problem" role="img" tabIndex={0}>
            <Codicon name="warning" size="0.75rem" />
          </span>
        </Tip>
      )}
    </span>
  )
}

/** Onboarding review step: Task links, Ready for Agent, Agent pickup (a switch), Tasks at once
 *  and Model rows. onSetUpLinks: opens the link panel in place of the review (Setup.jsx passes it). */
export function PickupReview({ delegation, fallbackReady, fallbackStart = fallbackReady, onSetUpLinks }) {
  const { phase, why } = pickupPhase(delegation)
  const gate = linksGate(useTaskLinks(delegation))
  return (
    <>
      {onSetUpLinks && <TaskLinksFact delegation={delegation} onSetUp={onSetUpLinks} />}
      <div>
        <dt>Ready for Agent</dt>
        <dd>{readyCount(delegation, fallbackReady)}</dd>
      </div>
      <div>
        <dt>Agent pickup</dt>
        <dd data-phase={phase}>
          {phase === 'on' || phase === 'off' ? (
            <>
              {phase === 'on' && gate.local && <span className="rk-pickup-local">{LOCAL}</span>}
              {delegation.problem && (
                <span className="rk-pickup-problem" role="alert">
                  {delegation.problem}
                </span>
              )}
              <PickupSwitch delegation={delegation} gate={gate} on={phase === 'on'} ready={readyCount(delegation, fallbackStart)} />
            </>
          ) : phase === 'unavailable' ? (
            // The reason is on the page, not behind a hover.
            <span className="rk-pickup-problem" role="status">
              {why}
            </span>
          ) : (
            <span>Checking…</span>
          )}
        </dd>
      </div>
      {phase !== 'unavailable' && (
        <div>
          <dt>Tasks at once</dt>
          <dd>
            <MaximumStepper delegation={delegation} />
          </dd>
        </div>
      )}
      {(phase === 'on' || phase === 'off') && (
        <div>
          <dt>Model</dt>
          <dd>
            <ModelPicker delegation={delegation} />
          </dd>
        </div>
      )}
    </>
  )
}
