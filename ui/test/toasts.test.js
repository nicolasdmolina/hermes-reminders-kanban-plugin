import assert from 'node:assert/strict'
import test from 'node:test'

import { toastKeeper } from '../src/lib/toasts.js'

const flush = () => new Promise(resolve => setImmediate(resolve))

/** A fake host and screen: toasts on screen by id, one interval at a time, ticked by hand. */
function screen() {
  const state = { dialog: false, visible: null, feed: { tasks: [] }, shown: new Map(), intervals: new Map(), next: 1 }
  const notify = input => {
    const id = input.id ?? `t${state.next++}`
    if (input.durationMs === 1) state.shown.delete(id)
    else state.shown.set(id, input.title)
    return id
  }
  const timers = {
    every: fn => {
      const handle = state.next++
      state.intervals.set(handle, fn)
      return handle
    },
    stopEvery: handle => state.intervals.delete(handle),
    later: () => {}
  }
  const keeper = toastKeeper({ notify, open: () => {}, dialogOpen: () => state.dialog, visible: () => state.visible, feed: () => state.feed, timers })
  const tick = async () => {
    for (const fn of [...state.intervals.values()]) fn()
    await flush()
  }
  return { state, keeper, tick, titles: () => [...state.shown.values()] }
}

const card = id => ({ card: { id, source: { id: `rem-${id}` } }, dest: null })
const note = id => ({ title: `Result ready · ${id}`, body: '', taskId: `t_${id}`, count: 1 })
const task = (id, action = 'review') => ({ task_id: `t_${id}`, guard: { source_id: `rem-${id}` }, required_action: action })

test('a toast up on the board is retired when its own task’s dialog opens, and not shown again', async () => {
  const s = screen()
  s.state.feed = { tasks: [task('a')] }
  s.keeper.offer(note('a'))
  await flush()
  assert.deepEqual(s.titles(), ['Result ready · a'])
  s.state.dialog = true
  s.state.visible = card('a')
  await s.tick()
  assert.deepEqual(s.titles(), [])
  s.state.dialog = false
  s.state.visible = null
  await s.tick()
  assert.deepEqual(s.titles(), [])
})

test('another task’s toast waits while a dialog is open, then shows if still needed (Sol S1: and keeps being watched)', async () => {
  const s = screen()
  s.state.feed = { tasks: [task('a'), task('b')] }
  s.state.dialog = true
  s.state.visible = card('a')
  s.keeper.offer(note('b'))
  await flush()
  assert.deepEqual(s.titles(), [])
  s.state.dialog = false
  s.state.visible = null
  await s.tick()
  assert.deepEqual(s.titles(), ['Result ready · b'])
  // A dialog opens again while the released toast is up: it must be retired, not left over it.
  s.state.dialog = true
  s.state.visible = card('c')
  await s.tick()
  assert.deepEqual(s.titles(), [])
})

test('a waiting toast whose task’s dialog opens meanwhile is dropped for good (Sol S2)', async () => {
  const s = screen()
  s.state.feed = { tasks: [task('a'), task('b')] }
  s.state.dialog = true
  s.state.visible = card('a')
  s.keeper.offer(note('b'))
  await flush()
  s.state.visible = card('b')
  await s.tick()
  s.state.dialog = false
  s.state.visible = null
  await s.tick()
  assert.deepEqual(s.titles(), [])
})

test('a waiting toast is not shown if its task no longer needs you, and the watcher stops', async () => {
  const s = screen()
  s.state.feed = { tasks: [task('b')] }
  s.state.dialog = true
  s.keeper.offer(note('b'))
  s.state.feed = { tasks: [task('b', null)] }
  s.state.dialog = false
  await s.tick()
  assert.deepEqual(s.titles(), [])
  assert.equal(s.state.intervals.size, 0)
})

test('with the real timers it is given by default, an open dialog retires its own task’s toast', async () => {
  const shown = new Map()
  let dialog = false
  let visible = null
  const notify = input => {
    const id = input.id ?? 'x1'
    if (input.durationMs === 1) shown.delete(id)
    else shown.set(id, input.title)
    return id
  }
  const keeper = toastKeeper({ notify, open: () => {}, dialogOpen: () => dialog, visible: () => visible, feed: () => ({ tasks: [task('a')] }), ms: { toast: 200, watch: 5 } })
  keeper.offer(note('a'))
  await flush()
  assert.equal(shown.size, 1)
  dialog = true
  visible = card('a')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(shown.size, 0)
  keeper.stop()
})
