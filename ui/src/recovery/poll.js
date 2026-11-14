// The browser task page's recovery feed: the same GET /recovery as Desktop (feed.js), polled
// through the page's own transport, with its own wait ticks. No host query cache on the dashboard.
import { useCallback, useEffect, useRef, useState } from 'react'

import { ACTIONS_PATH, FEED_POLL_MS, merged, RECOVERY_PATH, useWaitTicks } from './ticks.js'

/** Browser page: the same feed polled through the page's own transport. It sends its own wait ticks. */
export function usePolledRecovery(api) {
  const [feed, setFeed] = useState(null)
  // Repeating reminders' occurrence rows (GET /occurrences, no native reads): the browser page's
  // only source for an occurrence's hold or Reminders wait (ticket 25).
  const [occurrences, setOccurrences] = useState(null)
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    if (!api) return
    const mine = ++generation.current
    try {
      const [response, occurring] = await Promise.all([api.get(RECOVERY_PATH), api.get('/occurrences').catch(() => null)])
      if (mine !== generation.current) return
      setFeed(previous => (Array.isArray(response?.tasks) ? response : previous))
      if (Array.isArray(occurring?.tasks)) setOccurrences(occurring.tasks)
    } catch {
      // Keep the last answer; the conversation shows connection problems itself.
    }
  }, [api])
  const update = useCallback(response => setFeed(previous => merged(previous, response)), [])
  const tick = useCallback(async () => {
    const response = await api.post(ACTIONS_PATH, { action: 'tick' })
    update(response)
    return response
  }, [api, update])
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => document.visibilityState === 'visible' && void refresh(), FEED_POLL_MS)
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      generation.current++
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])
  useWaitTicks(feed, tick, Boolean(api))
  return { feed, occurrences, update, refresh }
}
