// The board header's Needs you count and the open-task path. The chip reads the unfiltered
// attention subscription (feed.js); useTaskOpener turns a notification click, a toast's Open or the
// header menu into the exact task's dialog. Cards show what they wait on through ticket 13's agent
// state (ui/src/delegation/). Mounted with one line each by the board page.
import {
  Button,
  Codicon,
  Dialog,
  DialogContent,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  StatusDot,
  Tip,
  host,
  useQueryClient
} from '@hermes/plugin-sdk'
import { useEffect, useMemo, useRef, useState } from 'react'

import { queryKey, useScope } from '../api/client.js'
import { needsYouCount, openKind, openRequestOf, openTarget, waitingTasks } from '../lib/attention.js'
import { cardDest } from '../lib/task-link.js'
import { defineStyles } from '../styles.js'
import { TaskSection } from '../task-link/TaskSection.jsx'
import { MetaPills } from '../task/shell.jsx'
import css from './questions.css'
import { openTask, setVisibleTask, useAttentionFeed, useOpenRequest } from './feed.js'

defineStyles(css)

/** In the board header: how many tasks need you, across every list and view. One opens directly;
 *  several open a menu of them. */
export function AttentionChip({ held = [], onOpenCard }) {
  const feed = useAttentionFeed()
  // held: board cards that need a decision with no task waiting (a held repeating reminder), which
  // the feed doesn't count. They are counted and listed here, and open their card.
  const count = needsYouCount(feed) + held.length
  const waiting = [...waitingTasks(feed), ...held.map(card => ({ taskId: `card:${card.id}`, cardId: card.id, title: card.title, label: 'Needs a decision', short: 'Decide' }))]
  const open = task => (task.cardId ? onOpenCard?.(task.cardId) : openTask(task.taskId, task.occurrenceId))
  if (!count) return null
  const label = `${count} need${count === 1 ? 's' : ''} you`
  const face = (
    <>
      <StatusDot className="rk-attn-dot" tone="warn" />
      <span>{label}</span>
    </>
  )
  if (!waiting.length) {
    return (
      <span className="rk-attn-chip" data-static="true" role="status">
        {face}
      </span>
    )
  }
  if (waiting.length === 1) {
    return (
      <Tip label={`${waiting[0].label}: ${waiting[0].title}`}>
        <Button className="rk-attn-chip" onClick={() => open(waiting[0])} size="xs" variant="ghost">
          {face}
        </Button>
      </Tip>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label={`${label}. Choose a task`} className="rk-attn-chip" size="xs" variant="ghost">
          {face}
          <Codicon name="chevron-down" size="0.7rem" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="rk-attn-menu">
        {waiting.map(task => (
          <DropdownMenuItem className="rk-attn-item" key={task.taskId} onSelect={() => open(task)}>
            <span className="rk-attn-item-title">{task.title}</span>
            <span className="rk-attn-item-kind">{task.short}</span>
            <Codicon aria-hidden className="rk-attn-item-go" name="chevron-right" size="0.75rem" />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const handled = new Set()
// Board rereads a click waits through for a task that has neither a card nor a link yet.
const PENDING_REREADS = 3

/**
 * Opens the task a notification, toast or the header menu asked for (openTask).
 * Its board card's dialog when the card is on the board with its link, else the task itself in the
 * same dialog (a filtered, hidden or not-yet-reread card must not hide a question). Returns that
 * fallback dialog, or null.
 * It never lands on another occurrence of a repeating reminder (openTarget): the card showing that
 * exact occurrence, or else the task's own dialog at that occurrence. occurrences: the board's GET
 * /occurrences read (useRecurring); occurrencesFailed: that read failed, so stop waiting for it.
 * Also tells the subscription which task is on screen.
 */
export function useTaskOpener({ cards, occurrences, occurrencesFailed = false, openId, refresh, setOpenId }) {
  const feed = useAttentionFeed()
  const asked = useOpenRequest()
  const [loose, setLoose] = useState(null)
  // A native notification clicked after a window reload has no callback left; its activate path
  // carries the task instead. Core's router changes the route without hashchange, popstate or
  // (when Hermes is already in front) focus, so the open board reads the address once a second.
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const read = () => setHash(window.location.hash)
    const timer = setInterval(read, 1000)
    window.addEventListener('focus', read)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', read)
    }
  }, [])
  const fromHash = useMemo(() => openRequestOf(hash), [hash])
  const wanted = asked && !handled.has(asked.nonce) ? asked : fromHash

  // A new question or result: reread the board, so its card carries the task link, and ticket 13's
  // live attention read (placement), so the card moves to Needs you with the notification.
  const client = useQueryClient()
  const scope = useScope()
  useEffect(() => {
    const onEvent = () => {
      refresh?.()
      void client.invalidateQueries({ queryKey: queryKey(scope, 'attention-live') })
    }
    window.addEventListener('rk:attention-event', onEvent)
    return () => window.removeEventListener('rk:attention-event', onEvent)
  }, [client, refresh, scope])

  const tasks = feed?.status === 'ok' ? feed.tasks : null
  // An occurrence's notification waits for the occurrences read, so it never opens as a one-off.
  const waitOccurrences = Boolean(wanted?.occurrenceId) && !occurrences && !occurrencesFailed
  // A request with neither a card nor a link yet stays pending through a few board rereads, so a
  // click always ends in a dialog, never in nothing. One reread at a time, awaited, and counted only
  // when it finishes: live polls that land meanwhile neither use up the budget nor restart the read.
  const pending = useRef({ nonce: null, tries: 0, busy: false })
  const [reread, setReread] = useState(0)
  useEffect(() => {
    if (!wanted || handled.has(wanted.nonce) || !tasks || !cards || waitOccurrences) return
    const task = tasks.find(entry => entry.task_id === wanted.taskId)
    const dest = entry => cardDest(entry, scope[1])
    const { card, occurrence } = openTarget(task, wanted.occurrenceId, cards, dest, occurrences)
    const kind = openKind(task, card, Boolean(card && dest(card)))
    if (kind === 'pending') {
      // A fresh state per request: a reread still finishing for an earlier click updates only its own.
      if (pending.current.nonce !== wanted.nonce) pending.current = { nonce: wanted.nonce, tries: 0, busy: false }
      const wait = pending.current
      if (wait.busy) return
      if (wait.tries >= PENDING_REREADS) {
        handled.add(wanted.nonce)
        // Answered somewhere else meanwhile (the phone, another window): say so, not nothing.
        Promise.resolve(host.notify?.({ kind: 'info', message: 'That task no longer needs you.', durationMs: 4000, placement: 'bottom-right' })).catch(() => {})
        return
      }
      wait.busy = true
      Promise.resolve(refresh?.())
        .catch(() => {})
        .finally(() => {
          wait.tries += 1
          wait.busy = false
          if (pending.current === wait) setReread(n => n + 1)
        })
      return
    }
    handled.add(wanted.nonce)
    if (kind === 'card') {
      setLoose(null)
      setOpenId(card.id)
    } else {
      // Not on the board, or the board hasn't reread the notes the task link was written to yet:
      // open the task itself now (at its occurrence), and reread the board.
      if (card) refresh?.()
      setOpenId(null)
      setLoose({ taskId: task.task_id, occurrence, destination: task.destination, title: task.history?.task?.title ?? '', offBoard: task.guard?.reason === 'source_ineligible' })
    }
  }, [wanted, tasks, cards, occurrences, waitOccurrences, setOpenId, reread, scope[1]])

  const openCard = openId && cards ? cards.find(card => card.id === openId) : null
  // What's on screen, not a task id resolved from an earlier read: the notifier matches each
  // event against its own read (Run again adds a new task under the same reminder).
  const visible = useMemo(
    () => (loose ? { taskId: loose.taskId } : openCard ? { card: openCard, dest: cardDest(openCard, scope[1]) } : null),
    [loose?.taskId, openCard, scope[1]]
  )
  useEffect(() => {
    setVisibleTask('opener', visible)
  }, [visible])
  useEffect(() => () => setVisibleTask('opener', null), [])

  // Radix returns focus only to a DialogTrigger: back to the chip that lists what needs you.
  const restore = event => {
    event.preventDefault()
    ;(document.querySelector('button.rk-attn-chip') ?? document.querySelector('.rk-card'))?.focus()
  }
  return loose ? <LooseTaskDialog onClose={() => setLoose(null)} onCloseAutoFocus={restore} task={loose} /> : null
}

// TaskDialog's linked-task frame, for a task whose card is not on the board.
const BODY = 'flex max-h-[min(84vh,54rem)] flex-col gap-0 overflow-hidden p-0 rk-task-dialog-body'

/** The task itself through its stored binding, for a task with no card: { taskId, occurrence,
 *  destination: { owner_id, link_id, url }, title }. Also the board's view of a task whose reminder
 *  was deleted (ticket 25). A task with no written link opens the same way. */
export function LooseTaskDialog({ onClose, onCloseAutoFocus, task }) {
  const source = useMemo(() => ({ url: task.destination?.url ?? null, notes: '' }), [task.destination?.url])
  return (
    <Dialog onOpenChange={open => !open && onClose()} open>
      <DialogContent
        aria-describedby={undefined}
        bodyClassName={BODY}
        className="rk-task-dialog rk-task-dialog-tall max-w-none"
        onCloseAutoFocus={onCloseAutoFocus}
        onOpenAutoFocus={event => (event.preventDefault(), event.currentTarget?.focus?.())}
        showCloseButton={false}
      >
        <div className="rk-task">
          <TaskSection
            binding={task.destination ?? null}
            details={null}
            meta={<MetaPills items={[{ label: 'Agent', tone: 'agent' }]} />}
            // Its reminder's list was taken off the board (or the reminder moved to one that isn't):
            // Hermes paused it and can't continue it, even once the list is back. Say what does work.
            footer={
              task.offBoard ? (
                <div className="rk-agent-actions">
                  <span className="rk-agent-why">This reminder's list isn't on the board, so Hermes paused it. Add the list back, then stop it and delegate it again.</span>
                </div>
              ) : undefined
            }
            occurrence={task.occurrence}
            onClose={onClose}
            source={source}
            title={
              <DialogTitle className="rk-task-title" data-selectable-text="true">
                {task.title || 'Task'}
              </DialogTitle>
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
