// The exact task behind a stable link, as a conversation (design option A): status pill and header,
// then the thread (system lines, Hermes messages, your replies), the reminder's notes and details in
// a disclosure, and a chat composer in the footer. The Desktop task dialog and the browser page both
// render it; each passes its own `api` transport (get/post JSON) and sign-in handler.
// Contracts: reminders_kanban/api/task-links-contract.md, attention-contract.md.
import { Button, Codicon, GlyphSpinner, Loader, MessageTextContent, Tip } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import {
  classifyLinkError,
  draftKey,
  inputMode,
  LINK_PROBLEMS,
  liveActivity,
  NO_TASK,
  formatElapsed,
  nextSubmission,
  occurrenceHolds,
  pendingReply,
  settledSubmission,
  threadArrival,
  resolverPath,
  scrollKey,
  scrollPlan,
  FOLLOW_PX,
  sentReply,
  submissionOutcome,
  taskView,
  threadOf
} from '../lib/task-link.js'
import { earlierLabel, pickerLabels, pickerTexts } from '../lib/occurrences.js'
import { useTaskLink } from './useTaskLink.js'
import { useAcceptance } from './useAcceptance.js'
import { useOccurrenceLabels } from '../recurring/labels.js'
import { TaskViewContext } from '../recurring/taskView.js'
import { agentState } from '../lib/placement.js'
import { browserQueuedLabel, conversationHold } from '../lib/reconciliation.js'
import { historyFor } from '../lib/recovery.js'
import { RecoveryActions, RecoveryPill, useTaskRecovery } from '../recovery/Recovery.jsx'
import { defineStyles } from '../styles.js'
import { DialogHead, StatusPill } from '../task/shell.jsx'
import css from './task-link.css'

defineStyles(css)

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const DAY_CLOCK = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' })
const stamp = seconds => {
  if (!seconds) return null
  const date = new Date(seconds * 1000)
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === new Date().toDateString()) return CLOCK.format(date)
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${CLOCK.format(date)}`
  return DAY_CLOCK.format(date)
}

const store = {
  read(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || 'null')
    } catch {
      return null
    }
  },
  write(key, value) {
    try {
      if (value) localStorage.setItem(key, JSON.stringify(value))
      else localStorage.removeItem(key)
    } catch {
      // Private window or blocked storage: the draft still lives in component state.
    }
  }
}

const newKey = () =>
  globalThis.crypto?.randomUUID?.() ?? `rk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

/**
 * The thread's scroller: the nearest element from the body up that scrolls (the Desktop dialog
 * body, or the web dashboard's page container), else the document. After each render it applies
 * scrollPlan; it remembers the position per task for the session and reports whether new messages
 * arrived below the view (for "Jump to latest").
 */
function useThreadScroll(body, key, count, sent, finished) {
  const state = useRef({ opened: false, count: 0, sent: null, atBottom: true })
  const [behind, setBehind] = useState(false)
  const scroller = useCallback(() => {
    for (let node = body.current; node && node !== document.body; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowY
      if (overflow === 'auto' || overflow === 'scroll') return node
    }
    return document.scrollingElement
  }, [body])
  const toBottom = useCallback(() => {
    const el = scroller()
    if (el) el.scrollTop = el.scrollHeight
    state.current.atBottom = true
    setBehind(false)
  }, [scroller])

  useEffect(() => {
    if (!body.current) return undefined
    const el = scroller()
    const target = el === document.scrollingElement ? window : el
    const onScroll = () => {
      const now = scroller()
      if (!now) return
      state.current.atBottom = now.scrollHeight - now.scrollTop - now.clientHeight <= FOLLOW_PX
      if (state.current.atBottom) setBehind(false)
      session.write(key, now.scrollTop)
      session.write(`${key}:rows`, state.current.count)
    }
    target.addEventListener('scroll', onScroll, { passive: true })
    return () => target.removeEventListener('scroll', onScroll)
  }, [body, key, scroller])

  useLayoutEffect(() => {
    const el = scroller()
    const current = state.current
    if (!el || !count) return
    const plan = scrollPlan({
      opened: current.opened,
      // A place saved earlier holds only while the thread is the one you left: with a new question
      // or result since, the task opens at the newest message instead.
      saved: current.opened || session.read(`${key}:rows`) !== count ? null : session.read(key),
      sent: Boolean(sent) && sent !== current.sent,
      grew: count > current.count,
      atBottom: current.atBottom,
      finished
    })
    current.opened = true
    current.count = count
    current.sent = sent
    if (plan === 'bottom') toBottom()
    else if (plan === 'top') el.scrollTop = 0
    else if (plan === 'restore') {
      el.scrollTop = session.read(key)
      current.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_PX
    } else if (plan === 'behind') setBehind(true)
  })

  return { behind, jump: toBottom }
}

const session = {
  read(key) {
    try {
      const value = sessionStorage.getItem(key)
      return value == null ? null : Number(value)
    } catch {
      return null
    }
  },
  write(key, value) {
    try {
      sessionStorage.setItem(key, String(Math.round(value)))
    } catch {
      // Private window or blocked storage: the position just isn't remembered.
    }
  }
}

const PROBLEM_PILLS = {
  sign_in: ['Sign in needed', 'muted'],
  wrong_owner: ['Different Hermes', 'muted'],
  wrong_profile: ['Different profile', 'muted'],
  not_found: ['Not found', 'muted'],
  unavailable: ["Can't reach Hermes", 'danger'],
  backend_missing: ['Plugin off', 'danger']
}

function pillFor(load) {
  if (load.view) return <StatusPill label={load.view.info.label} tone={load.view.info.tone} />
  if (load.phase === 'problem') {
    const [label, tone] = PROBLEM_PILLS[load.problem] ?? PROBLEM_PILLS.unavailable
    return <StatusPill label={label} tone={tone} />
  }
  return null
}

/**
 * dest: { owner, link, profile, occurrence, url } from parseTaskLink.
 * api: { get(path), post(path, body) } resolving JSON, rejecting like ctx.rest ("<status>: <body>").
 * title: the host's heading element. meta: meta pills or null. details: the reminder's notes and
 * properties, shown in a disclosure, or null. onOpen(occurrence|null): opens the task's stable link at the occurrence shown (Desktop only).
 * onSignIn: sends the user to sign in, keeping this destination. onClose: shows a close button.
 * footer: extra actions shown in the footer while there is no composer (Desktop board actions).
 * queuedLabel: the board's wait reason for queued work ("Waiting for a free slot"), when it knows one.
 * onOccurrence(id|null): lets the page keep the chosen occurrence in its address.
 * pill: replaces the task's status pill (a repeating reminder's next occurrence is not this task).
 * earlier: the task is an earlier occurrence of the reminder shown, so it reads as history (true,
 * or that occurrence's date when the page already knows it). upcoming: the line after that
 * history for the occurrence shown ("Nov 8 · Not started"). paused: what paused the task, as its
 * live line. knownLabels: occurrence names the page already knows, until its own read answers.
 * previous: { key, date } of the run a Run again replaced, shown as history above this one.
 * repeating: false for a one-off reminder, whose picker entries are runs, not occurrences.
 * recovery: { row, refresh?, onRepair?, onBilling? } — the task's delegation row, for ticket 17's recovery
 * states: they take the pill, the live line and a footer action (ui/src/recovery/).
 */
export function TaskConversation({ api, autoFocus, dest, details, earlier = false, footer, hold = null, knownLabels = null, occurrenceRows = null, meta, onClose, onOccurrence, onOpen, onSignIn, onTitle, paused = null, pill, previous = null, queuedLabel, recovery = null, repeating = true, title, upcoming = null }) {
  const { load, attention, refresh, setOccurrence } = useTaskLink(dest, api, onTitle, recovery?.row)
  const view = load.view
  const acceptance = useAcceptance(api, refresh)
  const receipt = acceptance.forTask(view?.taskId)
  const fetchedLabels = useOccurrenceLabels(api, view, earlier)
  const labels = pickerLabels(knownLabels ? { ...knownLabels, ...fetchedLabels } : fetchedLabels, view)
  // A repeating reminder's occurrence whose own row isn't at this question or review (paused, or
  // asking whether it was checked off) keeps the board's occurrence footer instead of a composer.
  const heldOnBoard = occurrenceHolds(inputMode(view), attention.occurrence)
  const held = conversationHold(view, { hold, recoveryRow: recovery?.row ?? null, occurrenceRows }, agentState)
  // Hermes refuses a reply while the reminder is held or Reminders can't be read: the footer (its
  // reason and Stop) shows instead of a reply box that can't send. A result keeps its Accept.
  const mode = heldOnBoard || (held?.blocks && inputMode(view) === 'reply') ? null : inputMode(view)
  // The board knows a queued task waits for a slot; Hermes only sees it parked (scheduled), which it
  // reports as paused. When the board says queued, the pill and the live line say what the card says.
  // A recovering task (a usage wait, an empty balance, a failed attempt) says why, not "queued".
  const rec = useTaskRecovery(recovery, view)
  // The browser page has no card: it reads the same wait from its own row, so a task that is only
  // waiting its turn never reads "Paused" there.
  const queuedText = queuedLabel ?? (!footer && !onClose ? (browserQueuedLabel(view, { recoveryRow: recovery?.row ?? null, occurrenceRows }) ?? undefined) : undefined)
  const boardQueued = !rec && Boolean(queuedText) && (view?.state === 'ready' || view?.state === 'paused')
  // The live line; a stopped task whose Run again was refused says why there instead.
  const live = view ? liveActivity(view, { queued: boardQueued, queuedLabel: queuedText, pausedLabel: paused }) : null
  // A task held on its reminder or waiting for Reminders says so, never "Working" or "Paused"
  // (ticket 25), on the current occurrence only, never under an earlier one's history. Desktop
  // passes it from the card; the browser page derives it from its one-off row or, for a repeating
  // reminder, the row of the occurrence on screen (GET /occurrences).
  // The browser page has no board footer and no card: a hold that blocks replies names itself in
  // the pill and says what happens next under the thread, as the Desktop footer does.
  const browserHold = Boolean(held?.blocks) && !footer && !onClose
  const liveLine = held ?? (rec ? rec.notice : paused && view?.state === 'stopped' ? { kind: 'notice', label: paused, since: null } : live)
  // Replies appear immediately until the task's own copy arrives on the next read.
  const [sent, setSent] = useState(null)
  const thread = view ? historyFor(threadOf(view), rec) : []
  const pending = pendingReply(sent, thread)
  const body = useRef(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  // Like a chat (the council's spec, scrollPlan): scrolls the view only, focus stays where it is.
  const rows = thread.length + (pending ? 1 : 0) + (receipt ? 1 : 0)
  // Accept is your action like a send: its saving line, and a failure's reason, come into view.
  const scroll = useThreadScroll(body, scrollKey(dest, view?.selectedOccurrence ?? null), view ? rows : 0, receipt ? `receipt:${receipt.phase}` : sent, !mode)

  // Right under the thread it answers (before any next-occurrence line), where the view is pinned:
  // a failed Accept explains itself in full, in sight.
  const receiptLine =
    receipt &&
    (receipt.phase === 'failed' ? (
      <div className="rk-tl-notice" role="alert">
        <span>{receipt.message}</span>
      </div>
    ) : (
      <div role="status">
        <ActivityLine glyph={receipt.phase === 'confirmed' ? 'check' : undefined} label={receipt.message} />
      </div>
    ))

  const choose = id => {
    const next = id === view?.currentOccurrence ? null : id
    // A reply just sent belongs to the occurrence it answered, not the one now shown.
    setSent(null)
    setOccurrence(next)
    onOccurrence?.(next)
  }

  const end = onOpen ? (
    <Button onClick={() => onOpen(view?.selectedOccurrence ?? null)} size="xs" variant="ghost">
      Open in Hermes
    </Button>
  ) : null

  return (
    <>
      <DialogHead
        end={end}
        meta={
          meta || details ? (
            <div className="rk-tl-meta-row">
              {meta}
              {details && (
                <Button
                  aria-controls="rk-tl-details"
                  aria-expanded={detailsOpen}
                  className="rk-tl-details-toggle"
                  onClick={() => {
                    setDetailsOpen(open => !open)
                    if (body.current) body.current.scrollTop = 0
                  }}
                  size="xs"
                  variant="text"
                >
                  Notes and details
                  <Codicon className="rk-tl-details-caret" name="chevron-down" size="0.75rem" />
                </Button>
              )}
            </div>
          ) : null
        }
        onClose={onClose}
        // Confirmed holds the pill only until the reread: after it the task's own state (Done, or the next occurrence's) shows.
        pill={(receipt?.phase === 'saving' || (receipt?.phase === 'confirmed' && mode)) ? <StatusPill label="Accepted" tone="done" /> : rec ? <RecoveryPill rec={rec} /> : (pill ?? (browserHold ? <StatusPill label={held.pill} tone={held.kind === 'held' ? 'attention' : 'muted'} /> : boardQueued ? <StatusPill label={queuedText} tone="agent" /> : pillFor(load)))}
        title={title}
      />
      <div className="rk-task-body rk-tl-body" data-selectable-text="true" ref={body}>
        {details && detailsOpen && (
          <section aria-label="Notes and details" className="rk-tl-details-body" id="rk-tl-details">
            {details}
          </section>
        )}
        {view && view.occurrences.length > 1 && (
          <div className="rk-tl-occurrences">
            <OccurrencePicker labels={labels} onChoose={choose} repeating={repeating} view={view} />
          </div>
        )}
        {load.phase === 'stale' && (
          <div className="rk-tl-notice" role="status">
            <span>
              {load.problem === 'sign_in'
                ? `Signed out. Showing the task as of ${load.readAt}.`
                : `Lost connection to this task. Showing it as of ${load.readAt}.`}
            </span>
            {load.problem === 'sign_in' && onSignIn ? (
              <Button onClick={onSignIn} size="xs" variant="secondary">
                Sign in
              </Button>
            ) : (
              <Button onClick={() => void refresh()} size="xs" variant="secondary">
                Try again
              </Button>
            )}
          </div>
        )}
        {load.phase === 'loading' && (
          <div className="rk-tl-loading">
            <Loader className="rk-tl-loader" label="Loading task" />
          </div>
        )}
        {load.phase === 'problem' && <LinkProblem kind={load.problem} onRetry={() => void refresh()} onSignIn={onSignIn} />}
        {view && previous && <EarlierRun api={api} dest={dest} previous={previous} />}
        {view &&
          (view.historical || earlier ? (
            // An earlier occurrence's run, grouped under its date by one hairline, then the one shown.
            <>
              <section aria-label={earlierLabel(labels[view.selectedOccurrence]?.date ?? (typeof earlier === 'string' ? earlier : null), repeating)} className="rk-tl-history">
                <ActivityLine glyph="calendar" label={earlierLabel(labels[view.selectedOccurrence]?.date ?? (typeof earlier === 'string' ? earlier : null), repeating)} />
                <Thread items={thread} live={liveLine} pending={pending} />
                {receiptLine}
              </section>
              {upcoming && <ActivityLine glyph="circle-large-outline" label={upcoming} />}
            </>
          ) : (
            <>
              <Thread items={thread} live={liveLine} pending={pending} />
              <Arrival items={thread} scope={view ? scrollKey(dest, view.selectedOccurrence ?? null) : null} />
              {receiptLine}
              {upcoming && <ActivityLine glyph="circle-large-outline" label={upcoming} />}
            </>
          ))}
      </div>
      {scroll.behind && !mode && (
        <div className="rk-task-foot rk-tl-jump-foot">
          <JumpToLatest onJump={scroll.jump} />
        </div>
      )}
      {/* The browser page has no board footer: a question it can't take says where it can be answered. */}
      {browserHold && held.line && (
        <div className="rk-task-foot">
          <p className="rk-composer-note" role="note">
            {held.line}
            {held.kind === 'held' ? ' Stop it in Hermes on your Mac.' : inputMode(view) === 'reply' ? " You can reply once it's back." : ''}
          </p>
        </div>
      )}
      {heldOnBoard && !browserHold && !footer && !onClose && (
        <div className="rk-task-foot">
          <p className="rk-composer-note" role="note">
            This one needs an answer on the board in Hermes on your Mac.
          </p>
        </div>
      )}
      {!mode && (footer || recovery) && (
        <div className="rk-task-foot rk-tl-board-foot">
          <TaskViewContext.Provider value={view}>{footer}</TaskViewContext.Provider>
          {recovery && !mode && (
            <RecoveryActions
              api={api}
              onDone={() => {
                void refresh({ quiet: true })
                void recovery.refresh?.()
              }}
              onBilling={recovery.onBilling}
              onRepair={recovery.onRepair}
              rec={rec}
              state={view?.state}
            />
          )}
        </div>
      )}
      {mode && (
        <div className="rk-task-foot">
          {scroll.behind && <JumpToLatest onJump={scroll.jump} />}
          <Composer
            api={api}
            attention={attention}
            autoFocus={autoFocus}
            dest={dest}
            key={`${view.selectedOccurrence}:${mode}`}
            mode={mode}
            onRefresh={refresh}
            accepting={(receipt?.phase === 'saving' || receipt?.phase === 'confirmed')}
            onAccept={() => acceptance.accept(view.taskId, {
              task: recovery?.row,
              occurrence: attention.occurrence,
              occurrenceTaskId: attention.entry?.task_id
            })}
            onSent={(what, text) => {
              // Asking for changes moves on from a failed Accept: its notice goes with it.
              acceptance.clear(view.taskId)
              setSent(sentReply(text, thread))
            }}
            onSignIn={onSignIn}
            view={view}
          />
        </div>
      )}
    </>
  )
}

// Core chat's anatomy (apps/desktop/src/components/assistant-ui/thread): Hermes replies are
// full-width prose in the assistant-message content slot (its indent, line height and paragraph
// rhythm), your turns are a bordered bubble on the right, and what Hermes did is a quiet
// left-aligned scaffold line in the Hermes column (components/chat/scaffold-row.tsx), starting on
// the same edge as Hermes' messages: an optional glyph, the label, and tabular meta. A finished run
// reads like core's finished turn ("Thought for 12s"), with no glyph. The run going now is one live
// line: core's breathing GlyphSpinner, a shimmering "Working" and its elapsed time in the meta ink. Every body goes through the host's
// MessageTextContent, so markdown, links and media match chat. Times show on hover or focus.
function Thread({ items, live, pending }) {
  if (!items.length && !live && !pending) return <ActivityLine label="Nothing here yet" />
  return (
    <ol className="rk-thread">
      {items.map((item, index) =>
        item.type === 'activity' ? (
          <li key={index}>
            <ActivityLine at={item.at} glyph={item.glyph} label={item.label} meta={item.meta} />
          </li>
        ) : item.type === 'you' ? (
          <li className="rk-msg rk-msg-you" key={index} tabIndex={-1}>
            <TurnLabel at={item.at} who={item.asks === 'changes' ? 'You · Asked for changes' : 'You'} />
            <div className="rk-user-bubble">
              <MessageTextContent media={false} text={item.text} />
            </div>
          </li>
        ) : (
          <li className="rk-msg rk-msg-hermes" data-current={item.current || undefined} data-from={item.type} key={index}>
            <TurnLabel at={item.at} who={item.type === 'comment' ? 'Comment' : ROUND[item.round] ?? 'Hermes'} />
            <div className="rk-msg-prose" data-slot="aui_assistant-message-content">
              <MessageTextContent text={item.text} />
            </div>
          </li>
        )
      )}
      {pending && (
        <li className="rk-msg rk-msg-you" data-pending="true">
          <div className="rk-msg-label">You · Sending</div>
          <div className="rk-user-bubble">
            <MessageTextContent media={false} text={pending} />
          </div>
        </li>
      )}
      {live && (
        <li>
          <LiveActivity live={live} />
        </li>
      )}
    </ol>
  )
}

/** The run a Run again replaced, read once from its own occurrence and grouped like an earlier
 *  occurrence: its date line, then its thread, behind one hairline. Nothing while it loads. */
function EarlierRun({ api, dest, previous }) {
  const [view, setView] = useState(null)
  useEffect(() => {
    let live = true
    api
      .get(resolverPath(dest, previous.key))
      .then(response => {
        const read = taskView(response)
        if (live && read.kind === 'resolved') setView(read)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [api, dest, previous.key])
  if (!view) return null
  return (
    <section aria-label={`Earlier run · ${previous.date}`} className="rk-tl-history">
      <ActivityLine glyph="calendar" label={`Earlier run · ${previous.date}`} />
      <Thread items={threadOf(view)} live={liveActivity(view)} />
    </section>
  )
}

/** One settled scaffold line: glyph cell, label, meta (a duration), and the time on hover. */
function ActivityLine({ at, glyph, label, live = false, meta }) {
  return (
    <div className="rk-activity" data-conversation-scaffold="" role={live ? 'status' : undefined}>
      {glyph && (
        <span aria-hidden className="rk-activity-glyph">
          <Codicon name={glyph === 'stop' ? 'debug-stop' : glyph} size="0.75rem" />
        </span>
      )}
      <span className="rk-activity-label">{label}</span>
      {meta && <span className="rk-activity-meta">{meta}</span>}
      {at && (
        <Tip label={FULL.format(new Date(at * 1000))}>
          <time className="rk-activity-meta rk-activity-time" dateTime={new Date(at * 1000).toISOString()}>
            {stamp(at)}
          </time>
        </Tip>
      )}
    </div>
  )
}

/** Says, to a screen reader only, that Hermes added to the thread while it was open. Nothing on
 *  first load or when the task or occurrence on screen changes (scope). */
function Arrival({ items, scope }) {
  const seen = useRef({ scope: null, count: 0 })
  const [said, setSaid] = useState('')
  useEffect(() => {
    const was = seen.current
    seen.current = { scope, count: items.length }
    if (scope == null || was.scope !== scope) return setSaid('')
    // Cleared when the thread grows with your own words, so the same line is heard again next time.
    if (items.length > was.count) setSaid(threadArrival(was.count, items) ?? '')
  }, [scope, items.length])
  return (
    <span className="rk-sr" role="status">
      {said}
    </span>
  )
}

/** The run going now (or waiting): working shimmers with a ticking timer, the rest are quiet. */
function LiveActivity({ live }) {
  const working = live.kind === 'working'
  const elapsed = useElapsed(working, live.since)
  return (
    <div aria-label={live.label} aria-live="polite" className="rk-activity" data-conversation-scaffold="" data-live={live.kind} data-recovery={live.recovery || undefined} role="status">
      <span aria-hidden className="rk-activity-glyph">
        {working ? (
          // Core's running glyph (app/agents/index.tsx statusGlyph), with its exact classes.
          <GlyphSpinner ariaLabel="Working" className="size-3.5 shrink-0 text-[0.95rem] text-muted-foreground/80" spinner="breathe" />
        ) : (
          <Codicon name={live.kind === 'queued' || live.kind === 'waiting' ? 'clock' : live.kind === 'held' ? 'circle-slash' : live.kind === 'paused' ? 'debug-pause' : live.kind === 'notice' ? 'warning' : 'debug-stop'} size="0.75rem" />
        )}
      </span>
      <span className={working ? 'rk-activity-label shimmer' : 'rk-activity-label'}>{live.label}</span>
      {working && (
        <span aria-hidden className="rk-activity-meta">
          {formatElapsed(elapsed)}
        </span>
      )}
      {!working && live.meta && <span className="rk-activity-meta">{live.meta}</span>}
    </div>
  )
}

/** Whole seconds since `since` (epoch seconds), else since mount, ticking once a second while `active`. */
function useElapsed(active, since) {
  const origin = useRef(Number.isFinite(since) ? since * 1000 : Date.now())
  if (Number.isFinite(since) && origin.current !== since * 1000) origin.current = since * 1000
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return Math.max(0, Math.floor((now - origin.current) / 1000))
}

/** A small flat control above the composer when new messages arrived below what you're reading. */
function JumpToLatest({ onJump }) {
  return (
    <div className="rk-tl-jump">
      <Button onClick={onJump} size="xs" variant="ghost">
        <Codicon name="arrow-down" size="0.75rem" />
        Jump to latest
      </Button>
    </div>
  )
}

// When a task delivered more than once, each result says which one Accept takes.
const ROUND = { latest: 'Hermes · Revised result', earlier: 'Hermes · Earlier result' }

/** "You · 3:27 PM" above a turn ("Yesterday, 3:27 PM", "Sep 28, 3:27 PM"), full date in a tip. */
function TurnLabel({ at, who }) {
  return (
    <div className="rk-msg-label">
      {who}
      {at && (
        <>
          {' · '}
          <Tip label={FULL.format(new Date(at * 1000))}>
            <time className="rk-msg-time" dateTime={new Date(at * 1000).toISOString()}>
              {stamp(at)}
            </time>
          </Tip>
        </>
      )}
    </div>
  )
}

const PROBLEM_ICONS = {
  sign_in: 'lock',
  wrong_owner: 'remote',
  wrong_profile: 'account',
  not_found: 'search',
  unavailable: 'debug-disconnect',
  backend_missing: 'extensions'
}

export function LinkProblem({ kind, onRetry, onSignIn, profile }) {
  const copy = LINK_PROBLEMS[kind] ?? LINK_PROBLEMS.unavailable
  const signIn = kind === 'sign_in' && onSignIn
  return (
    <div className="rk-tl-problem" data-kind={kind} role="alert">
      <Codicon className="rk-tl-problem-icon" name={PROBLEM_ICONS[kind] ?? 'warning'} size="1.1rem" />
      <h2>{copy.title}</h2>
      <p>{copy.body.replace('{profile}', profile ?? 'right')}</p>
      {copy.action && (
        <div className="rk-tl-problem-actions">
          {signIn ? (
            <>
              <Button onClick={onRetry} size="sm" variant="ghost">
                Try again
              </Button>
              <Button onClick={onSignIn} size="sm">
                Sign in
              </Button>
            </>
          ) : (
            <Button onClick={onRetry} size="sm" variant="secondary">
              {copy.action === 'Sign in' ? 'Try again' : copy.action}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** The browser page opened without a task: how to open one, with no error styling. */
export function LinkEmpty() {
  return (
    <div className="rk-tl-problem" data-kind="no_task">
      <Codicon className="rk-tl-problem-icon" name="link" size="1.1rem" />
      <h2>{NO_TASK.title}</h2>
      <p>{NO_TASK.body}</p>
    </div>
  )
}

function OccurrencePicker({ labels, onChoose, repeating, view }) {
  const ordered = [...view.occurrences].reverse()
  const texts = pickerTexts(labels, ordered, repeating)
  return (
    <label className="rk-tl-occurrence">
      <span className="rk-tl-visually-hidden">{repeating ? 'Occurrence' : 'Run'}</span>
      <select onChange={event => onChoose(event.target.value)} value={view.selectedOccurrence ?? ''}>
        {ordered.map((entry, index) => (
          <option key={entry.id} value={entry.id}>
            {texts[index]}
          </option>
        ))}
      </select>
      <Codicon name="chevron-down" size="0.7rem" />
    </label>
  )
}

/** Chat composer. Enter sends, Shift+Enter adds a line. A result adds Accept above it. */
function Composer({ api, attention, autoFocus, dest, mode, onRefresh, onSent, onSignIn, view, accepting, onAccept }) {
  const storageKey = draftKey(dest, view.selectedOccurrence, mode)
  const [text, setText] = useState(() => store.read(storageKey)?.text ?? '')
  // { key, token, text }: a submission whose answer never arrived. Until it resolves, Send replays
  // exactly that key and text (the backend rejects one key with different text), so the box locks.
  const [submission, setSubmission] = useState(() => {
    const saved = store.read(storageKey)
    return saved?.key ? { key: saved.key, token: saved.token, text: saved.sent ?? saved.text, seen: saved.seen ?? 0 } : null
  })
  const [sending, setSending] = useState(null)
  const [notice, setNotice] = useState(null)
  const field = useRef(null)
  const ready = attention.available && attention.token
  // A repeating reminder's occurrence may be held back (occurrenceHolds) until GET /occurrences
  // answers, so its Accept waits for that read instead of showing and then vanishing.
  const canAccept = mode === 'review' && view.actions.includes('accept') && !(dest.occurrence && attention.loading)
  const replaying = Boolean(submission?.key && submission.token === attention.token)
  const reply = mode === 'reply'
  const action = reply ? 'reply' : 'request_changes'
  const shown = replaying ? submission.text : text
  const empty = !shown.trim()

  // A reply whose answer was lost, then settled by Hermes: don't offer it again for the next question.
  useEffect(() => {
    const settled = settledSubmission(submission, attention.token, text, threadOf(view))
    if (!settled) return
    setSubmission(null)
    if (settled.clear) setText('')
  }, [submission, attention.token, text, view])

  // Desktop puts the caret in the reply box when the task opens, as core chat does for its composer.
  useEffect(() => {
    if (autoFocus) field.current?.focus({ preventScroll: true })
  }, [autoFocus])

  useEffect(() => {
    const saved = submission ? { key: submission.key, token: submission.token, sent: submission.text, seen: submission.seen ?? 0 } : {}
    store.write(storageKey, text || submission ? { text, ...saved } : null)
  }, [storageKey, text, submission])

  const send = async what => {
    if (sending || accepting) return
    if (what === 'accept') return onAccept()
    setNotice(null)
    setSending(what)
    // Persist the key and exact text before the request, so a lost response retries the same submission.
    const made = nextSubmission(submission, attention.token, text, newKey)
    // How many of your messages already say this, so a later copy in the thread is known to be this one.
    const payload = { ...made, seen: made.seen ?? sentReply(made.text, threadOf(view)).seen }
    setSubmission(payload)
    store.write(storageKey, { text, key: payload.key, token: payload.token, sent: payload.text, seen: payload.seen })
    try {
      const response = await api.post('/attention/submissions', {
        key: payload.key,
        task_id: view.taskId,
        token: payload.token,
        action: what,
        text: payload.text
      })
      const outcome = submissionOutcome(response, what, view.taskId)
      if (!outcome.keepDraft) {
        setText('')
        setSubmission(null)
        store.write(storageKey, null)
      } else if (!outcome.sameKey) {
        setSubmission(null)
      }
      if (outcome.kind === 'sent') onSent(what, payload?.text ?? '')
      // The board's Needs you indicators read the same subscription; let it catch up now.
      if (outcome.reread) {
        window.dispatchEvent(new CustomEvent('rk:attention-refresh'))
        window.dispatchEvent(new CustomEvent('rk:task-changed'))
      }
      setNotice(outcome.kind === 'sent' ? null : { text: outcome.message, tone: outcome.kind === 'pending' ? undefined : 'danger' })
      if (outcome.reread) void onRefresh()
    } catch (error) {
      const kind = classifyLinkError(error)
      if (kind === 'superseded') return
      setNotice({
        tone: 'danger',
        text:
          kind === 'sign_in'
            ? 'You were signed out. Your reply is saved here.'
            : "Couldn't reach Hermes. Your draft is kept; send again to retry.",
        signIn: kind === 'sign_in'
      })
    } finally {
      setSending(null)
    }
  }

  const submit = () => {
    if (!empty && ready && !sending && !accepting) void send(action)
  }
  // Enter pressed while the reply controls are still loading (opened straight from a
  // notification) sends once they're ready, instead of being dropped. Editing cancels it.
  const [queued, setQueued] = useState(false)
  useEffect(() => {
    if (!queued || !ready || sending || accepting) return
    setQueued(false)
    if (!empty) void send(action)
  }, [queued, ready]) // eslint-disable-line react-hooks/exhaustive-deps
  const onKeyDown = event => {
    // Enter sends; Shift+Enter is a new line; Enter that confirms an IME composition is not a send.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent?.isComposing || event.keyCode === 229) return
    // On a touch keyboard Return adds a line (there is no Shift+Return); the send button sends.
    if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) return
    event.preventDefault()
    if (!ready && attention.loading && !empty) setQueued(true)
    else submit()
  }
  const signInFirst = Boolean(notice?.signIn && onSignIn)

  return (
    <section aria-label={reply ? 'Reply' : 'Review'} className="rk-composer-wrap">
      {/* A result has one button, Accept. Asking for changes is the box below it: typing there and
          sending is the request, so it needs no button of its own. */}
      {canAccept && (
        <div className="rk-review-actions">
          <Button disabled={Boolean(sending || accepting)} onClick={() => void send('accept')} size="sm">
            {accepting ? 'Accepted' : 'Accept'}
          </Button>
        </div>
      )}
      {notice && (
        <p className="rk-composer-note" data-tone={notice.tone} role={notice.tone === 'danger' ? 'alert' : 'status'}>
          {notice.tone === 'danger' && <Codicon name="warning" size="0.75rem" />}
          {notice.text}
        </p>
      )}
      {!notice && replaying && !sending && (
        <p className="rk-composer-note">This reply may not have gone through. Send it again; it won't be sent twice.</p>
      )}
      {!notice && !ready && !attention.loading && (
        <p className="rk-composer-note">
          {attention.available
            ? 'Hermes is still saving this. You can reply in a moment.'
            : attention.failed
              ? "Couldn't load the reply controls. Trying again shortly."
              : "Replies aren't set up on this Hermes yet."}
        </p>
      )}
      <div className="rk-composer" data-busy={sending ? 'true' : undefined}>
        <textarea
          aria-label={reply ? 'Your reply' : 'What should change'}
          className="rk-composer-field"
          disabled={Boolean(accepting)}
          onChange={event => {
            setQueued(false)
            setText(event.target.value)
          }}
          onKeyDown={onKeyDown}
          placeholder={reply ? 'Reply to Hermes' : 'Ask for changes'}
          // Read-only, not disabled, while it sends: the caret stays put for a retry.
          readOnly={replaying || Boolean(sending)}
          ref={field}
          rows={1}
          value={shown}
        />
        {signInFirst ? (
          <Button onClick={onSignIn} size="sm">
            Sign in to send
          </Button>
        ) : (
          <button
            aria-label={reply ? 'Send reply' : 'Send changes'}
            className="rk-send"
            disabled={empty || !ready || Boolean(sending || accepting)}
            onClick={submit}
            type="button"
          >
            <Codicon name={sending || queued ? 'loading' : 'arrow-up'} size="0.875rem" spinning={Boolean(sending || queued)} />
          </button>
        )}
      </div>
    </section>
  )
}
