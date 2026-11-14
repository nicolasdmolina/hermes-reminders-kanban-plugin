// Keeps this plugin's in-app toasts off open dialogs (questions/README.md, "Notifications").
// Pure apart from what it is given, so the lifecycle is testable without the host.
//
// A toast for the task whose dialog is open is dropped (you're looking at it). While any dialog is
// open, other toasts wait, and ones already up are retired and wait too; once no dialog is open,
// each is shown if its task still needs you. A watcher runs only while a toast is up or waiting.
// The host exports no dismiss: re-posting a toast's id with a 1 ms duration retires it.
import { stillNeedsYou, toastFate } from './attention.js'

const taskOf = (note, feed) => (feed?.tasks ?? []).find(task => task.task_id === note.taskId) ?? { task_id: note.taskId }

/**
 * notify(input) → id (or a promise of it): the host's toast door. open(note): its Open action.
 * dialogOpen(), visible(), feed(): what is on screen now and the newest attention read.
 * timers: { every, stopEvery, later } (setInterval, clearInterval, setTimeout). ms: { toast, watch }.
 * Returns { offer(note), stop() }.
 */
const REAL_TIMERS = {
  every: (fn, ms) => setInterval(fn, ms),
  stopEvery: handle => clearInterval(handle),
  later: (fn, ms) => setTimeout(fn, ms)
}

export function toastKeeper({ notify, open, dialogOpen, visible, feed, timers = REAL_TIMERS, ms = { toast: 10_000, watch: 250 } }) {
  const showing = new Map()
  let held = []
  let watcher = null
  let stopped = false
  const fateOf = (note, dialog) => toastFate(note, visible(), taskOf(note, feed()), dialog)

  const retire = id => {
    showing.delete(id)
    Promise.resolve(notify({ id, kind: 'info', message: '', durationMs: 1, placement: 'bottom-right' })).catch(() => {})
  }
  const watch = () => {
    const dialog = dialogOpen()
    // A waiting toast whose task's dialog opened meanwhile has been seen: dropped for good.
    held = held.filter(note => fateOf(note, dialog) !== 'drop')
    for (const [id, note] of showing) {
      const fate = fateOf(note, dialog)
      if (fate !== 'show') retire(id)
      if (fate === 'hold') held.push(note)
    }
    if (!dialog && held.length) {
      const waiting = held
      held = []
      for (const note of waiting) if (stillNeedsYou(note, feed()) && fateOf(note, false) === 'show') show(note)
    }
    if (!showing.size && !held.length) {
      timers.stopEvery(watcher)
      watcher = null
    }
  }
  const start = () => {
    watcher ??= timers.every(watch, ms.watch)
  }
  const show = note => {
    Promise.resolve(
      notify({
        kind: 'info',
        icon: 'comment-discussion',
        title: note.title,
        message: note.body,
        // Several tasks at once: the button opens the first, and says so.
        action: { label: note.count > 1 ? 'Open first' : 'Open', onClick: () => open(note) },
        durationMs: ms.toast,
        placement: 'bottom-right'
      })
    )
      .then(id => {
        if (!id || stopped) return
        showing.set(id, note)
        // Started once the toast is tracked: showing a released toast happens inside watch(),
        // which may have just stopped the watcher.
        start()
        timers.later(() => showing.delete(id), ms.toast)
      })
      .catch(() => {})
  }
  return {
    /** A new notification while Hermes is in front. */
    offer(note) {
      const fate = fateOf(note, dialogOpen())
      if (fate === 'show') show(note)
      if (fate === 'hold') {
        held.push(note)
        start()
      }
    },
    stop() {
      stopped = true
      timers.stopEvery(watcher)
      watcher = null
    }
  }
}
