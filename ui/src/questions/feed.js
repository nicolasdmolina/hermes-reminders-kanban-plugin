// The Needs-you subscription: polls GET /attention for the routed connection and profile whether or
// not the board is open, publishes the read for the board's indicators, and turns new questions and
// results into one Hermes notification. Contract: reminders_kanban/api/attention-contract.md.
//
// No duplicates: the consumed cursor and event tokens are saved per connection and profile in
// plugin storage before anything is shown, and a Web Lock makes reading, saving and notifying one
// step across Hermes windows. A reconnect, a reload or a replayed journal therefore stays quiet.
import { atom, host, useValue } from '@hermes/plugin-sdk'

import { currentScope, isRouted, request, useScope } from '../api/client.js'
import { consumeFeed, notificationFor } from '../lib/attention.js'
import { toastKeeper } from '../lib/toasts.js'

const POLL_MS = 15_000
const STORE_KEY = scope => `attention:${scope.join(':')}`

/** { scope, feed } of the newest read. */
const $attention = atom({ scope: null, feed: null })

/** The newest attention read for the routed scope, or null. Unfiltered by any board view. */
export function useAttentionFeed() {
  const scope = useScope()
  const { scope: readFor, feed } = useValue($attention)
  return readFor && readFor[0] === scope[0] && readFor[1] === scope[1] ? feed : null
}

/** Asks the subscription to read now (after a reply, or when the board refreshes). */
export const refreshAttention = () => window.dispatchEvent(new CustomEvent('rk:attention-refresh'))

// What open task dialogs show, by who opened them ({ taskId } or { card, dest }; lib/attention.js
// showsTask), so that task's own notification doesn't also pop a toast.
const visibleTasks = new Map()
export const setVisibleTask = (owner, target) => {
  if (target) visibleTasks.set(owner, target)
  else visibleTasks.delete(owner)
}

let boardRoute = null

/** The task a notification, toast or the header menu asked to open: { taskId, occurrenceId, nonce } or null. */
const $openRequest = atom(null)
export const useOpenRequest = () => useValue($openRequest)

/** Opens the exact task's dialog on the board (the path every notification click takes).
 *  occurrenceId: a repeating reminder's occurrence, so that exact occurrence opens. The request
 *  lives in memory, not the address: core's router moves without a hashchange. */
export function openTask(taskId, occurrenceId = null) {
  $openRequest.set({ taskId, occurrenceId, nonce: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` })
  if (boardRoute) host.navigate(boardRoute)
}

/** Desktop is "away" the way core decides it for native notifications. */
const away = () => document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus())

const withLock = (name, work) =>
  typeof navigator !== 'undefined' && navigator.locks?.request ? navigator.locks.request(name, work) : work()

/**
 * Starts the subscription from register(). route: the board page's path; a click goes there and
 * asks the board to open that task's dialog.
 */
export function startAttention(ctx, route) {
  let stopped = false
  let running = null
  let again = false

  boardRoute = route

  const toasts = toastKeeper({
    notify: input => host.notify(input),
    open: note => openTask(note.taskId, note.occurrenceId),
    dialogOpen: () => visibleTasks.size > 0,
    visible: () => [...visibleTasks.values()],
    feed: () => $attention.get().feed
  })

  const show = note => {
    if (!note) return
    if (away()) {
      // Native OS notification; core shows it only while the user is away and the
      // "Plugin notifications" setting is on. A click focuses Hermes and lands on the task.
      // onActivate (this window's callback) opens the task. activate carries it too, so a click
      // after the window reloaded (callbacks gone) still lands on the task, not just the board.
      const params = { task: note.taskId, ...(note.occurrenceId ? { occurrence: note.occurrenceId } : {}), n: Date.now().toString(36) }
      const activate = { path: route, params }
      ctx.os.notify({ title: note.title, body: note.body, activate, onActivate: () => openTask(note.taskId, note.occurrenceId) })
      return
    }
    // Already looking at that task: its conversation updates in place instead. Another task's
    // toast never sits over an open dialog's actions: it waits until the dialog closes.
    toasts.offer(note)
  }

  const poll = async () => {
    const scope = currentScope()
    const key = STORE_KEY(scope)
    await withLock(`reminders-kanban:${key}`, async () => {
      const stored = ctx.storage.get(key, null)
      const after = Number.isInteger(stored?.cursor) ? stored.cursor : 0
      let feed
      try {
        feed = await request(scope, `/attention?after=${after}`)
      } catch {
        return // Offline, signed out, superseded or plugin off: the next tick tries again.
      }
      if (stopped || !isRouted(scope)) return
      $attention.set({ scope, feed })
      const { state, notify } = consumeFeed(stored, feed)
      if (state !== stored) ctx.storage.set(key, state)
      if (notify.length) {
        // An open conversation for one of these tasks rereads at once instead of on its next poll.
        window.dispatchEvent(new CustomEvent('rk:attention-event', { detail: { taskIds: notify.map(event => event.task_id) } }))
      }
      show(notificationFor(notify, feed))
    })
  }

  // One read at a time; a request while one runs schedules exactly one more.
  const tick = () => {
    if (stopped) return
    if (running) {
      again = true
      return
    }
    running = poll()
      .catch(() => {})
      .finally(() => {
        running = null
        if (again && !stopped) {
          again = false
          tick()
        }
      })
  }

  const timer = setInterval(tick, POLL_MS)
  window.addEventListener('focus', tick)
  window.addEventListener('rk:attention-refresh', tick)
  const unsubscribe = [host.state.profile, host.state.connectionId].map(store => store?.listen?.(() => tick()))
  tick()
  return () => {
    stopped = true
    clearInterval(timer)
    toasts.stop()
    window.removeEventListener('focus', tick)
    window.removeEventListener('rk:attention-refresh', tick)
    for (const stop of unsubscribe) stop?.()
  }
}
