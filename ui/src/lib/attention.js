// Needs-you attention from GET /attention, as data the board and notifications use.
// Pure: no host imports. Contract: reminders_kanban/api/attention-contract.md.

import { currentRecovery, recoveryView } from './recovery.js'
import { HELD, heldReason, SOURCE_WAIT } from './reconciliation.js'
import { taskLinkOf } from './task-link.js'

/** Event kinds that may notify. Progress, failures and pauses never do (story 47). */
export const NOTIFY_KINDS = new Set(['question', 'result'])

/** How many consumed event tokens a client remembers, newest kept. */
export const SEEN_LIMIT = 200

const ok = feed => feed?.status === 'ok' && Number.isInteger(feed.cursor)

/**
 * Consumes one feed read against the stored client state { cursor, seen: [token] } (null for a
 * client that has never read this owner). Returns { state, notify }:
 * - first read, or a journal that went backwards (reset store): start at the feed's cursor and
 *   notify nothing (the contract's "start a new client at the returned cursor");
 * - otherwise each event past the cursor whose token was never consumed, of a notifying kind,
 *   that is still the task's current attention (an answered or superseded question stays quiet).
 * Every token in the read is remembered, so a replay, a reconnect or a second window reading the
 * same journal never notifies twice. The caller saves `state` before it notifies.
 */
export function consumeFeed(stored, feed) {
  if (!ok(feed)) return { state: stored, notify: [] }
  const events = Array.isArray(feed.events) ? feed.events : []
  const fresh = !stored || !Number.isInteger(stored.cursor) || feed.cursor < stored.cursor
  const seen = new Set(fresh ? [] : (stored.seen ?? []))
  const current = new Map((feed.tasks ?? []).map(task => [task.task_id, task.attention?.token ?? null]))
  const notify = []
  for (const event of events) {
    if (!event?.token) continue
    const isNew = !fresh && event.id > stored.cursor && !seen.has(event.token)
    seen.add(event.token)
    if (isNew && NOTIFY_KINDS.has(event.kind) && current.get(event.task_id) === event.token) notify.push(event)
  }
  return { state: { cursor: feed.cursor, seen: [...seen].slice(-SEEN_LIMIT) }, notify }
}

// label matches the task dialog's status pill; short matches the card's agent state (ticket 13).
// Only questions and results notify; every action here is listed under the header count.
const ACTIONS = {
  reply: { kind: 'question', label: 'Needs your reply', short: 'Answer Hermes' },
  review: { kind: 'result', label: 'Result ready', short: 'Review result' },
  retry: { kind: 'failed', label: 'Stopped before finishing', short: 'Failed' },
  resume: { kind: 'paused', label: 'Paused', short: 'Paused' },
  reconcile: { kind: 'reconcile', label: 'Check what happened', short: 'Check what happened' }
}

/** The task's title as Hermes holds it (the reminder title the task was created from). */
export const taskTitle = task => String(task?.history?.task?.title ?? '').trim() || 'Untitled task'

/** What the current question or result says, for a notification body. */
export function attentionText(task, event = task?.attention) {
  const payload = event?.payload ?? {}
  const text = event?.kind === 'question' ? payload.reason : payload.summary
  return String(text ?? task?.history?.summary ?? '').trim()
}

/**
 * Tasks that need you (any required action), questions and results first by their request, then
 * the rest, as { taskId, occurrenceId, sourceId, linkId, ownerId, url, kind, label, short, title, eventId }.
 */
export function waitingTasks(feed) {
  if (!ok(feed)) return []
  return (feed.tasks ?? [])
    .map(task => {
      // A recovering task (ticket 17) is named as its card and pill name it, including the repair and
      // funding needs this table has no row for, so every counted task is listed.
      const rec = recoveryView(currentRecovery({ ...task, status: task.state }, task.state))
      // A usage wait needs nothing from you: it sits in In progress and isn't counted, so not listed.
      if (task.waiting || rec?.action === 'wait') return null
      const base = ACTIONS[task.required_action] ?? (rec ? { kind: 'recovery' } : null)
      if (!base) return null
      // A task held on its reminder (ticket 25) is named for what changed, as its card names it.
      const held = heldReason(task)
      const sourceWait = task.guard?.status === 'paused' && task.guard.reason === 'source_unavailable'
      const named = held ? HELD[held].label : sourceWait ? SOURCE_WAIT.label : null
      const action = rec ? { ...base, label: rec.label, short: rec.card } : named ? { ...base, kind: held ? 'held' : 'waiting', label: named, short: named } : base
      const destination = task.destination ?? {}
      return {
        taskId: task.task_id,
        occurrenceId: task.occurrence_id ?? null,
        sourceId: sourceIdOf(task),
        linkId: destination.link_id ?? null,
        ownerId: destination.owner_id ?? null,
        url: destination.url ?? null,
        ...action,
        title: taskTitle(task),
        // The token ends in the host's own event id, which orders requests across the board.
        eventId: Number(/:(\d+)$/.exec(task.attention?.token ?? '')?.[1] ?? Number.MAX_SAFE_INTEGER)
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.eventId - b.eventId)
}

/** The reminder a feed task was delegated from (its persisted source guard). */
export const sourceIdOf = task => task?.guard?.source_id ?? task?.guard?.source?.id ?? null

/**
 * Whether a board card shows this feed task: the same reminder, or the same task link. The
 * reminder id matches even before the board has reread the notes the link was just written to.
 * card: { source }, dest: taskLinkOf(card.source) or null.
 */
export function cardShows(task, source, dest) {
  const sourceId = task.sourceId !== undefined ? task.sourceId : sourceIdOf(task)
  const linkId = task.linkId !== undefined ? task.linkId : (task.destination?.link_id ?? null)
  const ownerId = task.ownerId !== undefined ? task.ownerId : (task.destination?.owner_id ?? null)
  // Both reminder ids known: they decide. A copied link or a replacement reminder carrying the
  // task's link never shows (or opens) that task (story 60).
  if (sourceId && source?.id) return sourceId === source.id
  return Boolean(dest && linkId === dest.link && (!ownerId || ownerId === dest.owner))
}


/**
 * Where opening a feed task lands, never on another occurrence: { card, occurrence }, where card is
 * the board card to open (or null) and occurrence the task's own occurrence key, for its own
 * dialog when there is no card. key: the requested occurrence (an event's occurrence_id; for a
 * repeating reminder, its GET /occurrences row key). occurrences: the board's /occurrences read.
 * - An occurrence the current read confirms: the card showing that exact occurrence.
 * - A one-off task (its guard names its reminder): its card, by reminder id or task link.
 * - Anything else (the occurrences read failed, or hasn't seen this occurrence yet): no card. Every
 *   occurrence of a reminder shares one task link, so the link alone could pick another occurrence.
 * dest(card): taskLinkOf(card.source).
 */
export function openTarget(task, key, cards, dest, occurrences) {
  const occurrence = key ?? task?.occurrence_id ?? null
  if (!task || !cards) return { card: null, occurrence }
  if (isOccurrenceTask(occurrences, task.task_id, occurrence)) return { card: cards.find(card => card.occurrence?.key === occurrence) ?? null, occurrence }
  if (sourceIdOf(task)) return { card: cards.find(card => !card.occurrence && cardShows(task, card.source, dest(card))) ?? null, occurrence }
  return { card: null, occurrence }
}

/** Whether a feed task is a repeating reminder's occurrence: GET /occurrences has a row with its key and task. */
export const isOccurrenceTask = (occurrences, taskId, occurrenceId) =>
  Boolean(occurrenceId && (occurrences?.tasks ?? []).some(row => row.key === occurrenceId && row.task_id === taskId))

/**
 * What opening a feed task does, given openTarget's card and whether that card can show the task
 * (its reminder carries the task link, or its row the stored binding) (the header menu, a
 * notification, a toast):
 * - 'card': its board card's dialog, whenever the card is on the board, with or without a
 *   destination; the dialog shows what the task needs.
 * - 'task': the task's own dialog through its stored binding, when no card shows it yet (filtered,
 *   hidden, or the board hasn't reread the link). A task with no written link ("Only on this Mac")
 *   opens the same way: the binding names it, not the URL.
 * - 'pending': neither a card nor a binding yet; reread the board and try again, never nothing.
 */
export function openKind(task, card, cardLinked) {
  if (!task) return 'pending'
  const bound = Boolean(task.destination?.owner_id && task.destination?.link_id)
  if (card && (cardLinked || !bound)) return 'card'
  if (bound) return 'task'
  return 'pending'
}

const SAFE_ID = /^[A-Za-z0-9._~-]{1,200}$/

/** The open-task request carried by a page hash such as
 *  "#/reminders-kanban?task=t_1&occurrence=<key>&n=abc" (a native notification's activate path,
 *  which survives a window reload). occurrence names a repeating reminder's exact occurrence. */
export function openRequestOf(hash) {
  const query = String(hash ?? '').split('?')[1]
  if (!query) return null
  const params = new URLSearchParams(query)
  const task = params.get('task')
  if (!task || !SAFE_ID.test(task)) return null
  const occurrence = params.get('occurrence')
  return { taskId: task, occurrenceId: occurrence && SAFE_ID.test(occurrence) ? occurrence : null, nonce: `hash:${params.get('n') ?? ''}` }
}

/** The unfiltered Needs you count the backend reports (questions, results, and anything else that
 *  needs a person), never narrowed by board filters. */
export const needsYouCount = feed => (ok(feed) && Number.isInteger(feed.needs_you_count) ? feed.needs_you_count : 0)

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

/**
 * One notification for the events a read surfaced (the host throttles a plugin to one per second,
 * so several become one). { title, body, taskId, occurrenceId, count } where taskId is the task a click
 * opens (the only one, or the oldest of several) and occurrenceId its occurrence.
 */
export function notificationFor(events, feed) {
  if (!events.length) return null
  const tasks = new Map((feed?.tasks ?? []).map(task => [task.task_id, task]))
  const first = events[0]
  if (events.length === 1) {
    const task = tasks.get(first.task_id)
    const title = taskTitle(task)
    return {
      title: first.kind === 'question' ? `Hermes has a question · ${clip(title, 60)}` : `Result ready · ${clip(title, 60)}`,
      body: clip(attentionText(task, first) || (first.kind === 'question' ? 'Hermes is waiting for your reply.' : 'Review it to accept or ask for changes.'), 180),
      taskId: first.task_id,
      occurrenceId: first.occurrence_id ?? null,
      count: 1
    }
  }
  const names = [...new Set(events.map(event => taskTitle(tasks.get(event.task_id))))]
  return {
    title: `${events.length} tasks need you`,
    body: clip(names.join(', '), 180),
    taskId: first.task_id,
    occurrenceId: first.occurrence_id ?? null,
    count: events.length
  }
}

/** Which delegated cards the board places in Needs you, as one comparable key ("" when none, or
 *  before anything is placed). A change means the header count's feed should be read again. */
export const needsYouKey = cards =>
  (cards ?? [])
    .filter(card => card?.agent && card.column === 'Needs you')
    .map(card => card.id)
    .sort()
    .join('|')

/**
 * Whether an attention event's task is the one on screen, judged against this read's task rather
 * than a task id resolved from an earlier read: Run again adds a new Hermes task under the same
 * reminder and link (the stopped one stays in the feed), and the new task's first appearance can
 * be the very read that carries its result.
 * visible: { taskId } for a task's own dialog, or { card, dest } for a board card's dialog (or a
 * list of them: any match counts)
 * (dest: taskLinkOf(card.source)). task: the feed entry for the event's task_id. A repeating
 * reminder's card shows one occurrence (every occurrence shares the task link), so it matches only
 * its own occurrence's task.
 */
export function showsTask(visible, task) {
  if (Array.isArray(visible)) return visible.some(target => showsTask(target, task))
  if (!visible || !task) return false
  if (visible.taskId) return task.task_id === visible.taskId
  const card = visible.card
  if (!card) return false
  const key = card.occurrence?.key
  if (key) return task.occurrence_id === key
  return cardShows(task, card.source, visible.dest)
}

/** An in-app notification held while a dialog was open, still worth showing once it closes:
 *  several tasks, or its one task still needs you in the newest read. */
export function stillNeedsYou(note, feed) {
  if (!note) return false
  if (note.count !== 1) return true
  return Boolean((feed?.tasks ?? []).find(task => task.task_id === note.taskId)?.required_action)
}

/** What happens to an in-app toast now (one being shown, or about to be):
 *  'drop' when it's for the task whose dialog is open (you're looking at it), 'hold' while any
 *  other dialog is open (the toast would sit over that dialog's actions), else 'show'. */
export function toastFate(note, visible, task, dialogOpen) {
  if (note.count === 1 && showsTask(visible, task)) return 'drop'
  return dialogOpen ? 'hold' : 'show'
}
