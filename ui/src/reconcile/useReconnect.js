// The board's reconnect check (ticket 25). While the board can't read Reminders (or reach Hermes)
// it keeps the delegated rows it last saw. Once a read succeeds again, Hermes rereads every
// delegated reminder before anything runs, and the board reports what changed meanwhile: deleted,
// checked off, new instructions, a held identity.
// - Pickup on: the board's owner ticks (ticket 13 one-off, ticket 21 occurrences, every 12 s)
//   already reread every delegated reminder before admission, so the board adds no request and says
//   "checking" until a tick of each workflow with queued work has answered. One more full reread
//   under the owner's lock only queues the board's own reads behind it on a long list.
// - Pickup off: nothing ticks, so the board asks once (POST /reconciliation/actions recheck,
//   one-off then recurring; no work starts) and says "checking" until both answer.
// Findings come from the board's live rows (GET /delegation and /occurrences), so they show as soon
// as a change is observed. The board screen is keyed by connection and profile, so scope is fixed
// for this hook's life.
import { useQueryClient } from '@hermes/plugin-sdk'
import { useEffect, useMemo, useRef, useState } from 'react'

import { isRouted, queryKey } from '../api/client.js'
import { getReconciliation, postRecheck } from '../api/reconciliation.js'
import { reconnectFindings } from '../lib/reconciliation.js'

// A failed recheck is tried again after this (pickup off; nothing else rereads Reminders).
const RETRY_MS = 30_000

const rowsOf = data => (Array.isArray(data?.tasks) ? data.tasks : [])

/**
 * stale: the board's last read is not current (lib/reconciliation.js isStale). rows: the board's
 * live delegated rows, one-off and occurrence. owner: { ticking, oneOffTick, recurringTick,
 * recurringQueued }: whether pickup ticks run, the time of each workflow's last tick answer, and
 * whether queued occurrence work waits on the recurring tick. Returns { checking, findings, dismiss }.
 */
export function useReconnect(scope, stale, rows, owner = {}) {
  const client = useQueryClient()
  const before = useRef(null)
  const running = useRef(false)
  const mounted = useRef(true)
  const [checking, setChecking] = useState(false)
  // The rows held before the outage, kept after reconnecting until the person dismisses what changed.
  const [baseline, setBaseline] = useState(null)
  // Pickup on: the tick times when Hermes answered again; checking ends once each has moved on.
  const [waitingFor, setWaitingFor] = useState(null)
  // Bumped to run the check again: after a recheck failed, or when a reconnect came while one ran.
  const [attempt, setAttempt] = useState(0)
  const rerun = useRef(false)
  const latest = useRef({ rows, owner, scope, client })
  latest.current = { rows, owner, scope, client }
  useEffect(
    () => () => {
      mounted.current = false
    },
    []
  )

  // Keep what the board knew when it lost Reminders (useDelegation keeps its last good read).
  useEffect(() => {
    if (!stale || before.current) return
    const cached = latest.current.rows ?? []
    before.current = { rows: cached.length ? cached : null }
  }, [stale])

  useEffect(() => {
    if (stale || !before.current) return
    if (running.current) {
      rerun.current = true
      return
    }
    const snapshot = before.current
    const { scope, client } = latest.current
    running.current = true
    setChecking(true)
    let cancelled = false
    let ticked = false
    let failed = false
    ;(async () => {
      try {
        // Opened while Hermes was unreachable: the owner's durable view is the "before".
        let earlier = snapshot.rows
        if (!earlier) {
          const durable = await getReconciliation(scope).catch(() => null)
          earlier = [...rowsOf(durable?.one_off), ...rowsOf(durable?.recurring)]
        }
        if (cancelled || !isRouted(scope)) return
        setBaseline(earlier)
        const owner = latest.current.owner
        if (owner.ticking) {
          ticked = true
          setWaitingFor({ oneOff: owner.oneOffTick ?? 0, recurring: owner.recurringTick ?? 0 })
          return
        }
        for (const workflow of ['one_off', 'recurring']) {
          const answer = await postRecheck(scope, workflow).catch(() => null)
          if (!Array.isArray(answer?.tasks)) failed = true
          if (!cancelled) void client.invalidateQueries({ queryKey: queryKey(scope, workflow === 'one_off' ? 'delegation' : 'occurrences') })
        }
      } finally {
        // Lost again mid-check, or the recheck failed: keep the earliest snapshot for the next try.
        before.current = cancelled || failed ? snapshot : null
        running.current = false
        // A failed recheck is not a fresh read: keep saying so, and try again shortly.
        if (mounted.current && !failed) setChecking(false)
        if (mounted.current && (rerun.current || (failed && !cancelled))) {
          const again = rerun.current
          rerun.current = false
          setTimeout(() => mounted.current && setAttempt(n => n + 1), again ? 0 : RETRY_MS)
        }
        if (!cancelled && !ticked) {
          for (const name of ['delegation', 'occurrences', 'attention-live', 'preview']) {
            void client.invalidateQueries({ queryKey: queryKey(scope, name) })
          }
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [stale, attempt])

  // Pickup on: checking until the owner's next tick of each workflow with queued work answered.
  const { oneOffTick = 0, recurringTick = 0, recurringQueued = false } = owner
  useEffect(() => {
    if (!waitingFor) return
    if (oneOffTick > waitingFor.oneOff && (!recurringQueued || recurringTick > waitingFor.recurring)) setWaitingFor(null)
  }, [oneOffTick, recurringTick, recurringQueued, waitingFor])

  const findings = useMemo(() => (baseline && !stale ? reconnectFindings(baseline, rows) : []), [baseline, rows, stale])
  return { checking: checking || Boolean(waitingFor), findings, dismiss: () => setBaseline(null) }
}
