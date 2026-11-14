// First-run setup: check access, choose existing lists, review what the board
// will show. Nothing here writes to Reminders; agent work starts only from the review step's
// Agent pickup switch (ticket 13's `pickup` rows, from ui/src/delegation/).
import { Button, Checkbox, Codicon } from '@hermes/plugin-sdk'
import { cloneElement, useEffect, useRef, useState } from 'react'

import { openPrivacySettings } from '../api/client.js'
import { importedReady, splitTitle } from '../lib/cards.js'
import { allState, offersAll, toggleAll } from '../lib/selection.js'
import { classifyError, PROBLEMS } from '../lib/state.js'
import { LinkSetup } from '../link-setup/LinkSetup.jsx'
import { defineStyles } from '../styles.js'
import { ConnectStep } from './Connect.jsx'
import css from './onboarding.css'

defineStyles(css)

const STEPS = [
  { id: 'connect', label: 'Connect' },
  { id: 'lists', label: 'Choose lists' },
  { id: 'review', label: 'Review' }
]

export function Setup({ busyLists = null, listDraft, onListDraft, scope, onCancel, onChangeLists, onOpenBoard, onRetry, onSave, pending, pickup, saving, view }) {
  return (
    <section aria-labelledby="rk-setup-title" className="rk-setup rk-enter" key={view.step}>
      {/* No steps while the first read is out: a returning user goes straight to their board. */}
      {!view.revising && !view.checking && <Steps current={view.step} />}
      {view.step === 'connect' && <ConnectStep onRetry={onRetry} pending={pending} scope={scope} view={view} />}
      {view.step === 'lists' && <ListsStep busyLists={busyLists} listDraft={listDraft} onListDraft={onListDraft} onCancel={onCancel} onRetry={onRetry} onSave={onSave} pending={pending} saving={saving} view={view} />}
      {view.step === 'review' && <ReviewStep envelope={view.envelope} onChangeLists={onChangeLists} onOpenBoard={onOpenBoard} pickup={pickup} />}
    </section>
  )
}

function Steps({ current }) {
  const index = STEPS.findIndex(step => step.id === current)
  return (
    <ol aria-label="Setup progress" className="rk-steps">
      {STEPS.map((step, i) => {
        const state = i < index ? 'done' : i === index ? 'current' : 'next'
        return (
          <li aria-current={state === 'current' ? 'step' : undefined} data-state={state} key={step.id}>
            <span aria-hidden className="rk-step-mark">
              {state === 'done' && <Codicon name="check" size="0.6rem" />}
            </span>
            {step.label}
          </li>
        )
      })}
    </ol>
  )
}

function Head({ children, title }) {
  return (
    <div className="rk-setup-head">
      <h2 id="rk-setup-title">{title}</h2>
      {children && <p>{children}</p>}
    </div>
  )
}

function ListsStep({ busyLists, listDraft, onListDraft, onCancel, onRetry, onSave, pending, saving, view }) {
  const { envelope, revising } = view
  const lists = envelope.lists ?? []
  const selected = new Set(listDraft ?? envelope.setup?.selected_list_ids ?? [])
  const setSelected = update => onListDraft(current => [...update(new Set(current ?? envelope.setup?.selected_list_ids ?? []))])
  const first = useRef(null)

  useEffect(() => {
    saving.reset()
    first.current?.focus()
  }, [])

  const toggle = id =>
    setSelected(current => {
      const next = new Set(current)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  // Keep the user's order stable: lists appear as Reminders returns them.
  const ids = lists.filter(list => selected.has(list.id)).map(list => list.id)
  const error = saveProblem(saving)
  const all = allState(lists, selected)
  // Hermes can't keep working on a reminder whose list is off the board: stop that work first.
  const held = lists.filter(list => busyLists?.[list.id] && !selected.has(list.id))
  const heldText = held.length
    ? `Hermes has ${held.map(list => `${busyLists[list.id] === 1 ? '1 task' : `${busyLists[list.id]} tasks`} from ${list.title}`).join(' and ')}. Finish or stop ${held.length === 1 && busyLists[held[0].id] === 1 ? 'it' : 'them'} first, or keep the ${held.length === 1 ? 'list' : 'lists'}.`
    : null

  return (
    <>
      <Head title="Choose lists">Pick the lists to show on the board. Nothing in Reminders changes and no agent work starts.</Head>
      {lists.length === 0 ? (
        <p className="rk-list-none">No lists in Reminders yet. Make one in Reminders, then check again.</p>
      ) : (
        <div className="rk-list-picker">
          {offersAll(lists) && (
            <label className="rk-list-row rk-list-all">
              <Checkbox aria-controls="rk-lists" checked={all} className={all === false ? 'rk-list-checkbox-unchecked' : undefined} onCheckedChange={() => setSelected(current => toggleAll(lists, current))} ref={first} />
              <span>All lists</span>
            </label>
          )}
          <ul aria-label="Reminder lists" className="rk-lists" id="rk-lists">
            {lists.map((list, index) => (
              <li key={list.id}>
                <label className="rk-list-row">
                  <Checkbox
                    checked={selected.has(list.id)}
                    className={!selected.has(list.id) ? 'rk-list-checkbox-unchecked' : undefined}
                    onCheckedChange={() => toggle(list.id)}
                    ref={index === 0 && !offersAll(lists) ? first : undefined}
                  />
                  <span>{list.title}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
      {heldText && (
        <p className="rk-setup-error" role="alert">
          {heldText}
        </p>
      )}
      {error && (
        <p className="rk-setup-error" role="alert">
          {error.title}
        </p>
      )}
      <div className="rk-setup-footer">
        {error?.kind === 'access_denied' && (
          <Button onClick={openPrivacySettings} size="sm" variant="secondary">
            Open Privacy Settings
          </Button>
        )}
        {lists.length > 0 && (
          <span className="rk-setup-hint">{ids.length === 1 ? '1 list' : `${ids.length} lists`}</span>
        )}
        {revising && (
          <Button onClick={onCancel} size="sm" variant="text">
            Cancel
          </Button>
        )}
        {lists.length === 0 ? (
          <Button disabled={pending} onClick={onRetry} size="sm">
            {pending ? 'Checking…' : 'Check again'}
          </Button>
        ) : (
          <Button
            disabled={(ids.length === 0 && !revising) || saving.isPending || held.length > 0}
            onClick={() => onSave(ids, { revising })}
            size="sm"
          >
            {saving.isPending ? 'Reading reminders…' : revising ? 'Show these lists' : 'Preview board'}
          </Button>
        )}
      </div>
    </>
  )
}

/** A failed save keeps the picker open with the reason; the saved choice is unchanged. */
function saveProblem(saving) {
  if (saving.isPending) return null
  if (saving.isError) {
    const kind = classifyError(saving.error).kind
    return kind === 'superseded' ? null : { kind, title: (PROBLEMS[kind] ?? PROBLEMS.unavailable_host).title }
  }
  const next = saving.data
  if (!next || next.status === 'ready' || next.status === 'empty_list') return null
  const code = next.error?.code
  const kind = code === 'list_unavailable' ? 'list_unavailable' : next.status === 'stale' ? 'read_failure' : next.status
  return { kind, title: (PROBLEMS[kind] ?? PROBLEMS.read_failure).title }
}

function ReviewStep({ envelope, onChangeLists, onOpenBoard, pickup }) {
  const cards = envelope.cards ?? []
  const ready = importedReady(cards)
  const open = cards.filter(card => card.column !== 'Done').length
  const names = (envelope.lists ?? [])
    .filter(list => envelope.setup.selected_list_ids.includes(list.id))
    .map(list => list.title)
  const openButton = useRef(null)
  // Task links (link-setup): Set up swaps the review for the link panel, as Change lists swaps in
  // the picker. Done, Set up later or Use this Mac only come back here.
  const [linking, setLinking] = useState(false)

  useEffect(() => {
    if (!linking) openButton.current?.focus()
  }, [linking])

  if (linking) return <LinkSetup onDone={() => setLinking(false)} />

  return (
    <>
      <Head title="Your board is ready">Ready for Agent tasks stay put until you turn on agent pickup.</Head>
      <dl className="rk-facts">
        <div>
          <dt>Lists</dt>
          <dd>{names.join(', ')}</dd>
        </div>
        <div>
          <dt>Reminders</dt>
          <dd>{cards.length ? `${cards.length} · ${open} open` : 'None yet'}</dd>
        </div>
        {pickup ? cloneElement(pickup, { onSetUpLinks: () => setLinking(true) }) : (
          <>
            <div>
              <dt>Ready for Agent</dt>
              <dd>{ready.length}</dd>
            </div>
            <div>
              <dt>Agent pickup</dt>
              <dd>Off</dd>
            </div>
            <div>
              <dt>Tasks at once</dt>
              <dd>{envelope.effective_concurrency}</dd>
            </div>
          </>
        )}
      </dl>
      {ready.length > 0 && (
        <div className="rk-ready">
          <h3>Ready for Agent</h3>
          <ul>
            {ready.slice(0, 5).map(card => (
              <li key={card.id}>
                <span aria-hidden className="rk-dot" style={{ '--rk-tone': 'var(--rk-agent)' }} />
                <span>{splitTitle(card.source.title).text}</span>
              </li>
            ))}
            {ready.length > 5 && <li>+{ready.length - 5} more</li>}
          </ul>
        </div>
      )}
      <div className="rk-setup-footer">
        <Button onClick={onChangeLists} size="sm" variant="secondary">
          Change lists
        </Button>
        <Button onClick={onOpenBoard} ref={openButton} size="sm">
          Open board
        </Button>
      </div>
    </>
  )
}
