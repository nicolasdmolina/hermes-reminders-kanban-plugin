// Shared by the Desktop feed (feed.js) and the browser page's (poll.js): merging owner answers
// and the one owner tick a usage wait needs when its native next-check time passes.
import { useEffect, useRef } from 'react'

import { nextCheckDue } from '../lib/recovery.js'

// A tick that found the wait still on (admission rechecks the native cooldown) tries again after this.
const TICK_RETRY_MS = 20_000
// Fire just after the native time, so admission's own cooldown check has passed too.
const TICK_SLACK_MS = 1_500

export const FEED_POLL_MS = 60_000
export const RECOVERY_PATH = '/recovery'
export const ACTIONS_PATH = '/recovery/actions'

/** A tick or retry answer carries the whole task list; anything else keeps what is on screen. */
export const merged = (previous, response) => {
  if (Array.isArray(response?.tasks)) return { ...(previous ?? {}), ...response }
  if (response?.status === 'attention' && response.task && Array.isArray(previous?.tasks)) {
    const tasks = previous.tasks.map(row => (row.key === response.task.key ? response.task : row))
    return { ...previous, tasks }
  }
  return previous
}

/**
 * Calls `tick()` once when the earliest usage wait in `feed` comes due, and again every
 * TICK_RETRY_MS while one stays due. `tick` resolves with the owner's answer.
 */
export function useWaitTicks(feed, tick, enabled) {
  const due = enabled ? nextCheckDue(feed) : null
  const at = due ? due.getTime() : null
  const latest = useRef(tick)
  latest.current = tick
  useEffect(() => {
    if (at == null) return undefined
    let timer = null
    let stopped = false
    const run = async () => {
      if (stopped) return
      try {
        await latest.current()
      } catch {
        // The next poll or retry tries again; a failed tick changes nothing on screen.
      }
      if (!stopped) timer = setTimeout(run, TICK_RETRY_MS)
    }
    timer = setTimeout(run, Math.max(0, at - Date.now()) + TICK_SLACK_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [at])
}
