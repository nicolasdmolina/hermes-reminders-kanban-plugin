import { useCallback, useEffect, useRef, useState } from 'react'

import { attentionFor, classifyLinkError, inputMode, replyAttention, resolverPath, taskView } from '../lib/task-link.js'
import { occurrenceAttention } from '../lib/occurrences.js'

const POLL_MS = 15_000
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

/** Reads and polls one destination. Late answers (a newer read started) are dropped. */
export function useTaskLink(dest, api, onTitle, knownTask) {
  const [occurrence, setOccurrence] = useState(dest.occurrence ?? null)
  const [load, setLoad] = useState({ phase: 'loading', view: null, problem: null })
  // Until GET /attention answers, the reply controls are loading, not unavailable.
  const [attention, setAttention] = useState({ available: false, token: null, loading: true })
  const generation = useRef(0)
  // A background poll waits for the read in flight instead of superseding it, so a slow or
  // failing /attention call still reaches the screen. Deliberate refreshes still take over.
  const inFlight = useRef(false)
  const taskId = useRef(null)

  const refresh = useCallback(
    async ({ quiet = false } = {}) => {
      if (quiet && inFlight.current) return
      const mine = ++generation.current
      inFlight.current = true
      if (!quiet) setLoad(current => ({ ...current, phase: current.view ? 'refreshing' : 'loading' }))
      try {
        const response = await api.get(resolverPath(dest, occurrence))
        if (mine !== generation.current) return
        const view = taskView(response)
        if (view.kind !== 'resolved') {
          setLoad({ phase: 'problem', view: null, problem: view.kind })
          return
        }
        onTitle?.(response.title ?? null)
        taskId.current = view.taskId
        setLoad({ phase: 'ready', view, problem: null, readAt: CLOCK.format(new Date()) })
        if (inputMode(view)) {
          // The /attention feed holds every task's reply token, one-off or a repeating reminder's
          // occurrence (ticket 35); an occurrence's /occurrences row says whether it can be reviewed.
          const [feed, occ] = await Promise.allSettled([api.get('/attention'), api.get('/occurrences')])
          if (mine === generation.current) {
            const own = occ.status === 'fulfilled' ? occurrenceAttention(occ.value, view.taskId) : undefined
            setAttention(replyAttention(feed.status === 'fulfilled' ? attentionFor(feed.value, view.taskId) : null, own))
          }
        }
      } catch (error) {
        if (mine !== generation.current) return
        const kind = classifyLinkError(error)
        if (kind === 'superseded') return
        // Keep what was on screen (and the draft under it) when a refresh fails; say so instead.
        setLoad(current =>
          current.view ? { ...current, phase: 'stale', problem: kind } : { phase: 'problem', view: null, problem: kind }
        )
      } finally {
        if (mine === generation.current) inFlight.current = false
      }
    },
    [api, dest, occurrence, onTitle]
  )

  // Action receipts change the board row before the conversation poll is due.
  // A deliberate read supersedes any older poll still in flight.
  useEffect(() => {
    void refresh()
    return () => {
      generation.current++
    }
  }, [refresh, knownTask?.task_id, knownTask?.status, knownTask?.accepted])

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void refresh({ quiet: true })
    }
    const timer = setInterval(tick, POLL_MS)
    window.addEventListener('focus', tick)
    // Desktop's attention subscription (ui/src/questions/) saw a new question or result: reread now.
    const onEvent = event => {
      if (!taskId.current || event.detail?.taskIds?.includes(taskId.current)) void refresh({ quiet: true })
    }
    window.addEventListener('rk:attention-event', onEvent)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', tick)
      window.removeEventListener('rk:attention-event', onEvent)
    }
  }, [refresh])

  return { load, attention, refresh, setOccurrence }
}
