// Task-link setup (link-setup BUILD.md and design/PROPOSAL.md): how a phone opens a delegated
// task. Shown in place of onboarding's review content, and in a dialog from the Pickup popover.
// Layout reuses the setup step's head, check rows and footer (ui/src/onboarding/onboarding.css)
// so it reads as the same flow. Nothing writes until a click: Set up, Save address, or Use this
// Mac only. "Set up later" leaves pickup off.
import { Button, Codicon, Input, SegmentedControl, Tip } from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'

import { pluginContext } from '../api/client.js'
import { useTaskLinks } from '../api/task-link-setup.js'
import { blockedBy, continueBody, draftAddress, hostOf, invalidText, linksFact, MODES, problemFor, savedAddress, SIGNIN, TAILSCALE_STATE } from '../lib/link-setup.js'
import { defineStyles } from '../styles.js'
import css from './link-setup.css'
import { useLinkSetup } from './useLinkSetup.js'

defineStyles(css)

const openExternal = target => void pluginContext()?.os.openExternal(target).catch(() => false)

function Row({ label, state, tone, spinning, mono }) {
  return (
    <li>
      <span className="rk-check-label">{label}</span>
      <span className="rk-check-state" data-mono={mono || undefined} data-tone={tone}>
        {(tone || spinning) && (
          <Codicon
            name={spinning ? 'loading' : tone === 'ok' ? 'pass-filled' : tone === 'bad' ? 'error' : 'warning'}
            size="0.85rem"
            spinning={spinning}
          />
        )}
        <span className="rk-check-text">{state}</span>
      </span>
    </li>
  )
}

/** The Task links row for a facts list (review step, Pickup popover). Null on an older backend.
 *  inline: the Set up button sits in the row; the narrow popover puts it in its footer instead
 *  (TaskLinksButton). */
export function TaskLinksFact({ delegation, onSetUp, inline = true }) {
  const links = useTaskLinks(delegation)
  const ready = links?.status === 'ready'
  // The delegation read has no address; one setup read names the host once links are ready.
  const { setup } = useLinkSetup({ enabled: ready })
  const fact = linksFact(links, ready ? setup?.address : null)
  if (!fact) return null
  return (
    <div>
      <dt>Task links</dt>
      <dd>
        {fact.host ? (
          <Tip label={fact.host}>
            <span className="rk-link-host">{fact.host}</span>
          </Tip>
        ) : (
          <span>{fact.text}</span>
        )}
        {inline && fact.action && (
          <Button onClick={onSetUp} size="xs" variant="secondary">
            {fact.action}
          </Button>
        )}
      </dd>
    </div>
  )
}

/** The Task links row's button on its own (the Pickup popover's footer), or null. */
export function TaskLinksButton({ delegation, onSetUp }) {
  const fact = linksFact(useTaskLinks(delegation))
  if (!fact?.action) return null
  return (
    <Button onClick={onSetUp} size="sm" variant="secondary">
      {fact.action === 'Change' ? 'Change task links' : fact.action}
    </Button>
  )
}

/**
 * The panel. onDone: back to where it opened (review, or closes the dialog). Title: the heading
 * element (a DialogTitle inside a dialog).
 */
export function LinkSetup({ onDone, Title = 'h2' }) {
  const links = useLinkSetup()
  const { setup, busy } = links
  const [mode, setMode] = useState('tailscale')
  const [draft, setDraft] = useState('')
  // The last Check, for the exact address it checked; typing again clears it.
  const [checked, setChecked] = useState(null)
  // The last Set up / Save address answer when it didn't finish (a refusal to show).
  const [problem, setProblem] = useState(null)
  // An apply that saved the address but the dashboard hasn't picked it up yet. In local mode the
  // setup read keeps saying `local` until links are ready, so the answer is what says so.
  const [saved, setSaved] = useState(null)
  // A tab chosen after opening: the person is setting up a new address, not waiting on the saved one.
  const [editing, setEditing] = useState(false)
  // Links are ready and the person asked to change how they work: the choices show again.
  const [changing, setChanging] = useState(false)
  const root = useRef(null)

  // On opening, and again when the screen swaps under the pressed button: Change, Cancel, or a
  // first Set up reaching the ready screen.
  useEffect(() => {
    ;(root.current?.querySelector('button[aria-pressed="true"]') ?? root.current?.querySelector('.rk-setup-footer button:last-of-type'))?.focus()
  }, [changing, setup?.status === 'ready'])

  const loading = !setup
  const unavailable = setup?.status === 'unavailable'
  const done = setup?.status === 'ready' && !changing
  const pending = savedAddress(setup, saved, { mode, editing })
  const restart = Boolean(pending)
  const blocked = mode === 'local' ? null : blockedBy(setup)

  const choose = next => {
    setMode(next)
    setEditing(true)
    setProblem(null)
  }

  const apply = async body => {
    setProblem(null)
    const answer = await links.apply(body)
    if (!answer) return
    // Ready shows from the reread setup; Restart needed from the answer; anything else is a refusal.
    if (answer.status === 'restart_needed') {
      setSaved(answer.address ?? body.expected ?? body.address ?? null)
      setEditing(false)
    }
    else if (answer.status !== 'ready') setProblem(problemFor(answer.status))
    else setChanging(false)
  }

  const check = async () => {
    const address = draftAddress(draft)
    setProblem(null)
    setChecked({ address, pending: true })
    const answer = await links.check(address)
    setChecked(answer ? { address, result: answer } : null)
  }

  const local = async () => {
    setProblem(null)
    const answer = await links.local()
    if (answer?.status === 'local') onDone()
    else setProblem(problemFor(answer?.status ?? 'unavailable'))
  }

  const checkAgain = () => {
    setProblem(null)
    const body = restart ? continueBody({ ...setup, address: pending }) : null
    return body ? apply(body) : links.reread()
  }

  const later = (
    <Button onClick={changing ? () => setChanging(false) : onDone} size="sm" variant="text">
      {changing ? 'Cancel' : 'Set up later'}
    </Button>
  )

  let body
  let footer
  if (done) {
    body = <Ready setup={setup} />
    footer = (
      <>
        <Button onClick={() => (setChanging(true), setProblem(null), setMode(current => (current === 'local' ? 'tailscale' : current)))} size="sm" variant="text">
          Change
        </Button>
        <Button onClick={onDone} size="sm">
          Done
        </Button>
      </>
    )
  } else if (mode === 'local') {
    // Before the loading and failed states: this choice needs nothing from the setup read.
    body = (
      <ul className="rk-checks">
        <Row label="Open tasks" state="On this Mac" tone="ok" />
        <Row label="From your phone" state="Off" />
      </ul>
    )
    footer = (
      <>
        {later}
        <Button disabled={Boolean(busy)} onClick={() => void local()} size="sm">
          {busy === 'local' ? 'Saving…' : 'Use this Mac only'}
        </Button>
      </>
    )
  } else if (loading || unavailable) {
    body = loading ? (
      <ul className="rk-checks">
        <Row label="Task links" spinning state="Checking…" />
      </ul>
    ) : null
    footer = (
      <>
        {later}
        <Button disabled={loading || links.fetching} onClick={() => void links.reread()} size="sm">
          {links.fetching ? 'Checking…' : 'Check again'}
        </Button>
      </>
    )
  } else if (restart) {
    body = <Saved address={pending} reason={setup?.status === 'restart_needed' ? setup.reason : null} />
    footer = (
      <>
        {later}
        <Button disabled={Boolean(busy) || links.fetching} onClick={() => void checkAgain()} size="sm">
          {busy === 'apply' || links.fetching ? 'Checking…' : 'Check again'}
        </Button>
      </>
    )
  } else if (blocked) {
    body = <Blocked blocked={blocked} />
    footer = (
      <>
        {later}
        <Button disabled={links.fetching} onClick={() => void links.reread()} size="sm">
          {links.fetching ? 'Checking…' : 'Check again'}
        </Button>
      </>
    )
  } else if (mode === 'tailscale') {
    const t = TAILSCALE_STATE[setup.tailscale?.state] ?? TAILSCALE_STATE.unknown
    const ready = setup.tailscale?.state === 'ready'
    body = <TailscalePane setup={setup} state={t} />
    footer = (
      <>
        {later}
        {t.fix && (
          <Button onClick={() => openExternal(t.fix.open)} size="sm" variant="secondary">
            {t.fix.label}
          </Button>
        )}
        {ready ? (
          <Button disabled={Boolean(busy)} onClick={() => void apply({ mode: 'tailscale', expected: setup.tailscale.address })} size="sm">
            {busy === 'apply' ? 'Setting up…' : 'Set up'}
          </Button>
        ) : (
          <Button disabled={links.fetching} onClick={() => void links.reread()} size="sm">
            {links.fetching ? 'Checking…' : 'Check again'}
          </Button>
        )}
      </>
    )
  } else {
    const address = draftAddress(draft)
    const result = checked && !checked.pending && checked.address === address ? checked.result : null
    const ok = result?.status === 'ok' || result?.status === 'restart_needed'
    body = (
      <OwnPane
        checking={busy === 'check'}
        draft={draft}
        onChange={text => {
          setDraft(text)
          setProblem(null)
        }}
        onSubmit={() => (ok ? void apply({ mode: 'own', address }) : address && void check())}
        result={result}
        setup={setup}
      />
    )
    footer = (
      <>
        {later}
        {ok ? (
          <Button disabled={Boolean(busy)} onClick={() => void apply({ mode: 'own', address })} size="sm">
            {busy === 'apply' ? 'Saving…' : 'Save address'}
          </Button>
        ) : (
          <Button disabled={!address || Boolean(busy)} onClick={() => void check()} size="sm">
            {busy === 'check' ? 'Checking…' : 'Check'}
          </Button>
        )}
      </>
    )
  }

  return (
    <div className="rk-link-setup" ref={root}>
      <div className="rk-setup-head">
        <Title className="rk-link-title" id="rk-setup-title">
          {done ? 'Task links are ready' : 'Open tasks from your phone'}
        </Title>
      </div>
      {/* Changing a working address: This Mac only can't switch it off from here (the address stays
          in Hermes' own settings), so it isn't offered as if it could. */}
      {!done && <SegmentedControl onChange={choose} options={changing ? MODES.filter(option => option.id !== 'local') : MODES} value={mode} />}
      {setup?.status === 'invalid' && mode === 'own' && !problem && (
        <p className="rk-setup-error" role="alert">
          {invalidText(setup.reason)}
        </p>
      )}
      {body}
      {(problem || (unavailable && mode !== 'local')) && (
        <p className="rk-setup-error" role="alert">
          {problem ?? problemFor('unavailable')}
        </p>
      )}
      <div className="rk-setup-footer">{footer}</div>
    </div>
  )
}

function TailscalePane({ setup, state }) {
  const t = setup.tailscale ?? {}
  return (
    <ul className="rk-checks">
      <Row label="Tailscale" state={state.text} tone={state.tone} />
      {t.state === 'ready' && (
        <>
          <Row label="Address" mono state={hostOf(t.address)} />
          <Row label="Who can open it" state="Your devices with Tailscale on" />
          <Row label="Sign-in" state={SIGNIN[setup.dashboard?.signin] ?? 'On'} />
        </>
      )}
    </ul>
  )
}

function OwnPane({ checking, draft, onChange, onSubmit, result, setup }) {
  const problem = result && result.status !== 'ok' && result.status !== 'restart_needed' ? problemFor(result.status) : null
  const input = useRef(null)
  useEffect(() => input.current?.focus(), [])
  return (
    <>
      <form
        className="rk-link-field"
        onSubmit={event => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <Input
          aria-describedby="rk-link-detail"
          aria-invalid={problem ? true : undefined}
          aria-label="HTTPS address"
          autoCapitalize="off"
          autoComplete="off"
          className="rk-link-input"
          onChange={event => onChange(event.target.value)}
          // Read-only, not disabled, while it checks: focus stays, so Enter can then save.
          readOnly={checking}
          placeholder="https://hermes.example.com"
          ref={input}
          spellCheck={false}
          type="url"
          value={draft}
        />
        <p className="rk-link-detail" id="rk-link-detail">
          An HTTPS address you already run, such as a tunnel, forwarding to {setup.dashboard?.local ?? 'the Hermes dashboard'}.
        </p>
      </form>
      {result && !problem && (
        <ul className="rk-checks">
          <Row label="Reaches Hermes" state="Yes" tone="ok" />
          <Row label="Sign-in" state={SIGNIN[result.signin ?? setup.dashboard?.signin] ?? 'On'} tone="ok" />
        </ul>
      )}
      {problem && (
        <p className="rk-setup-error" role="alert">
          {problem}
        </p>
      )}
    </>
  )
}

function Blocked({ blocked }) {
  return (
    <>
      <ul className="rk-checks">
        {blocked === 'dashboard' && <Row label="Hermes dashboard" state="Not running" tone="bad" />}
        {blocked === 'signin' && (
          <>
            <Row label="Hermes dashboard" state="Running" tone="ok" />
            <Row label="Sign-in" state="Not set up" tone="bad" />
          </>
        )}
        {blocked === 'env' && <Row label="Address" state="Set outside Hermes" tone="bad" />}
      </ul>
      <p className="rk-setup-error" role="alert">
        {problemFor(blocked === 'dashboard' ? 'no_dashboard' : blocked === 'signin' ? 'no_signin' : 'env_override')}
      </p>
    </>
  )
}

function Saved({ address, reason }) {
  return (
    <>
      <ul className="rk-checks">
        <Row label="Address" mono state={hostOf(address)} />
        <Row label="Hermes dashboard" state="Restart needed" tone="warn" />
      </ul>
      <p className="rk-link-note">Saved. Restart the Hermes dashboard, then press Check again.</p>
      {reason && reason !== 'restart_needed' && (
        <p className="rk-setup-error" role="alert">
          {problemFor(reason)}
        </p>
      )}
    </>
  )
}

function Ready({ setup }) {
  const conflicts = setup.backfill?.conflicts ?? 0
  return (
    <ul className="rk-checks">
      <Row label="Address" mono state={hostOf(setup.address)} />
      <Row label="Hermes dashboard" state="Reachable" tone="ok" />
      {/* "Reachable" is this Mac's own check. A Tailscale address opens only where Tailscale is on. */}
      {/\.ts\.net(:\d+)?$/.test(hostOf(setup.address) ?? '') && <Row label="On your phone" state="Needs Tailscale on" />}
      {/* The link opens Hermes' sign-in page first: say which sign-in it will ask for. */}
      {SIGNIN[setup.dashboard?.signin] && <Row label="Sign-in" state={SIGNIN[setup.dashboard.signin]} />}
      {conflicts > 0 && <Row label="Links not added" state={conflicts === 1 ? '1 reminder changed' : `${conflicts} reminders changed`} tone="warn" />}
    </ul>
  )
}
