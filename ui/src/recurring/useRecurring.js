// Repeating reminders on the board for one connection and profile (tickets 21 and 23): the
// /occurrences read, its owner tick while delegated occurrences are open, This occurrence and Every
// occurrence actions, and the agent door ticket 13's editor uses, routed per card. Contracts:
// api/occurrence-contract.md, api/recurring-contract.md.
// Placement and history are pure, in lib/occurrences.js; this file only fetches and routes.
import { useQuery, useQueryClient } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { isRouted, queryKey } from '../api/client.js'
import { getOccurrences, postOccurrences } from '../api/occurrences.js'
import { postRecurring } from '../api/recurring.js'
import { resolveSeriesProblem, resolveSeriesRequest, retryRequest, confirmableRun, currentSnapshot, FRESH_MS, newKeys, queuedWhileHeld, resolveProblem, resolveRequest, stillHeld, withViews, hasOutstanding, occurrenceProblem, isRecurring, occurrenceOutcome, withOccurrences, withOccurrenceTasks } from '../lib/occurrences.js'
import { stopOutcome } from '../lib/delegation-outcomes.js'
import { takeOverRequest } from '../lib/elsewhere.js'
import { placeCards } from '../lib/placement.js'
import { classifyError } from '../lib/state.js'

// Same cadence as ticket 13's one-off tick: one at a time, only while the board is visible.
const TICK_MS = 20_000
// Rereads: soon after a failure, otherwise as gently as the board's own read (it launches the helper).
const RETRY_MS = 5_000
const READ_MS = 60_000

// Set localStorage 'rk-debug-ticks' to log every owner tick's rows (captures read the console).
const debugTicks = () => {
  try {
    return Boolean(globalThis.localStorage?.getItem('rk-debug-ticks'))
  } catch {
    return false
  }
}

const statusKey = data => (data?.tasks ?? []).map(row => `${row.key}:${row.status}`).join('|')

/** delegation: ticket 13's useDelegation. onChoose(cardId): open that card's task dialog. */
export function useRecurring(scope, delegation, { onChoose } = {}) {
  const client = useQueryClient()
  const key = queryKey(scope, 'occurrences')
  const query = useQuery({
    queryKey: key,
    queryFn: () => getOccurrences(scope),
    enabled: () => isRouted(scope),
    // Without this read a delegated occurrence would look like a plain reminder, so a failed read
    // (a profile backend still starting, a slow helper) is tried again soon, and kept fresh after.
    retry: (count, error) => count < 2 && classifyError(error).kind !== 'superseded',
    retryDelay: 1500,
    refetchInterval: current => (current.state.status === 'error' ? RETRY_MS : READ_MS),
    staleTime: 10_000,
    refetchOnWindowFocus: true
  })
  // Occurrences this board just created, read as Queued while Hermes holds them (queuedWhileHeld).
  const [fresh, setFresh] = useState(() => new Map())
  const data = useMemo(() => queuedWhileHeld(query.data, fresh), [query.data, fresh])
  // Drop keys Hermes moved on, and check again once the oldest would expire.
  useEffect(() => {
    if (!fresh.size) return undefined
    const prune = () => setFresh(current => {
      const next = stillHeld(query.data, current)
      return next.size === current.size ? current : next
    })
    prune()
    const oldest = Math.min(...fresh.values())
    const timer = setTimeout(prune, Math.max(0, oldest + FRESH_MS - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [query.data, fresh])
  const created = keys => {
    const list = keys.filter(Boolean)
    // A key keeps its first time: a later answer never renews it.
    if (list.length) setFresh(current => new Map([...list.map(key => [key, Date.now()]), ...current]))
  }
  // Every occurrence's next occurrence is made by the owner tick, not by this board: it too reads
  // Queued while Hermes holds it, the first time it's seen.
  const seen = useRef(new Set())
  useEffect(() => {
    const next = (query.data?.tasks ?? []).filter(row => row.predecessor && !seen.current.has(row.key))
    next.forEach(row => seen.current.add(row.key))
    if (next.length) created(next.map(row => row.key))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data])
  // The card whose Delegate menu should open by itself (a repeating reminder dropped on Ready for Agent).
  const [asking, setAsking] = useState(null)
  const ticking = useRef(false)
  // When the owner last answered an occurrence tick (a full reread; ticket 25's reconnect waits on it).
  const [tickedAt, setTickedAt] = useState(0)
  const last = useRef(null)

  const reread = () => client.refetchQueries({ queryKey: key, exact: true })

  // Actions and ticks answer with bare rows; GET adds each task's view (work_before_stop,
  // stopped_at, ...), which Run again needs. Keep those by row key (withViews) and reread GET
  // when a status changed so the views are current again.
  const absorb = answer => {
    if (answer?.status !== 'ok' || !isRouted(scope)) return
    const before = statusKey(client.getQueryData(key))
    client.setQueryData(key, current => (current ? { ...current, ...answer, tasks: withViews(current.tasks, answer.tasks) } : answer))
    if (statusKey(answer) !== before) void client.invalidateQueries({ queryKey: key, exact: true })
  }
  const refreshBoard = () => client.invalidateQueries({ queryKey: queryKey(scope, 'preview') })

  // One at a time; a caller gets the tick in flight (`after`: one that starts after now).
  const inFlight = useRef(null)
  const tick = ({ after = false } = {}) => {
    if (inFlight.current) return after ? inFlight.current.then(() => tick()) : inFlight.current
    if (!isRouted(scope)) return Promise.resolve()
    const run = tickOnce().finally(() => {
      inFlight.current = null
    })
    inFlight.current = run
    return run
  }
  const tickOnce = async () => {
    ticking.current = true
    try {
      const answer = await postOccurrences(scope, { action: 'tick' })
      if (answer?.status === 'ok') setTickedAt(Date.now())
      if (answer?.status !== 'ok') console.warn('reminders-kanban: occurrence tick', answer?.status, answer?.reason ?? '')
      else if (debugTicks()) console.debug('reminders-kanban: occurrence tick ok', (answer.tasks ?? []).map(row => `${String(row.key).slice(0, 8)}:${row.status}`).join(' '))
      absorb(answer)
    } catch (error) {
      // The next read or tick shows what happened; ticks are safe to repeat.
      if (classifyError(error).kind !== 'superseded') console.warn('reminders-kanban: occurrence tick failed', String(error?.message ?? error))
    } finally {
      ticking.current = false
    }
  }

  // Only delegated occurrences that aren't accepted yet need the owner to observe them.
  // Pickup off still watches occurrences already out (pickup-off BUILD.md): the owner admits nothing new.
  const open = delegation.pickup != null && hasOutstanding(data)
  useEffect(() => {
    if (!open) return undefined
    void tick()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void tick()
    }, TICK_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scope.join('\u0000')])

  // A status change can mean an accepted occurrence and a new due date: reread Reminders too.
  useEffect(() => {
    const now = statusKey(data)
    if (last.current !== null && now !== last.current) void refreshBoard()
    last.current = now
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  // A refused Run again, by occurrence key: the dialog's pause line says why, not a toast.
  const [refusals, setRefusals] = useState({})
  // Run again in flight, by card id. It stops, confirms and reruns, and the row changes
  // (paused, stopped, the new task) while it does: the footer stays busy instead of following it.
  const [rerunning, setRerunning] = useState({})
  const running = useRef(new Set())

  /** 'ready' (This occurrence), 'every' (Every occurrence), 'accept', 'stop', 'retry' or 'rerun'
   *  for one card, in ticket 10's settlement shape. */
  /** takeOver: the reminder is another Mac's Hermes's and the person chose Take over here; the
   *  choice ('ready' or 'every') then replaces that Mac's claim (lib/elsewhere.js). */
  const act = async (action, card, { takeOver = false } = {}) => {
    const row = card.agent?.row
    if (action === 'stop') return stop(row)
    if (action === 'rerun' || action === 'rerun-confirmed') return rerun(card, row, { confirmed: action === 'rerun-confirmed' })
    const body =
      action === 'accept'
        ? { action, occurrence_id: row?.key }
        : action === 'retry'
          ? retryRequest(row)
          : // The card's own snapshot: the backend refuses it if Reminders has moved on since.
            takeOver
            ? takeOverRequest(card, action === 'every' ? 'every' : 'ready')[1]
            : { action: action === 'every' ? 'every' : 'ready', expected: card.source }
    const target = { sourceId: card.source?.id, key: row?.key }
    try {
      if (!body) return occurrenceOutcome(null, action, target)
      // every and retry exist only on /recurring/actions; the rest on /occurrences (one owner).
      const answer = await (action === 'every' || action === 'retry' ? postRecurring : postOccurrences)(scope, body)
      const outcome = occurrenceOutcome(answer, action, target)
      if ((action === 'ready' || action === 'every') && answer?.status === 'ok') created(answer.task?.key ? [answer.task.key] : newKeys(query.data, answer, card.source?.id))
      if (answer?.status === 'ok' && isRouted(scope)) absorb(answer)
      else await reread()
      if (answer?.reason === 'other_mac') void refreshBoard()
      // Whose reminder it is comes from the board's own read: wait for it, so the footer stays busy
      // until the card is this Mac's task.
      if (takeOver) await Promise.all([refreshBoard(), client.refetchQueries({ queryKey: queryKey(scope, 'delegation'), exact: true })]).catch(() => {})
      return outcome
    } catch (error) {
      const kind = classifyError(error)
      if (kind.kind === 'superseded') return { superseded: true, result: null, shown: null }
      await reread().catch(() => {})
      return occurrenceOutcome(null, action, target, kind)
    }
  }

  /** Stop (occurrence-contract.md, delegation-contract.md "Stop a recurring occurrence"): the same
   *  outcomes as ticket 13's one-off Stop, read by its stopOutcome. The reminder is never written. */
  const stop = async row => {
    try {
      const answer = await postOccurrences(scope, { action: 'stop', occurrence_id: row?.key })
      const outcome = stopOutcome(answer)
      await Promise.all([reread(), client.invalidateQueries({ queryKey: queryKey(scope, 'attention-live') })])
      void refreshBoard()
      // The owner's next check takes this Mac's claim line off the reminder (it is yours again).
      // Then read the occurrences again: the tick took this Mac's claim line off the reminder, and
      // Run again goes out with the snapshot held here.
      void tick({ after: true }).then(() => Promise.all([reread(), refreshBoard()]))
      return outcome
    } catch (error) {
      const kind = classifyError(error)
      if (kind.kind === 'superseded') return { superseded: true, result: null, shown: null }
      await reread().catch(() => {})
      return stopOutcome(null, kind)
    }
  }

  /** Run again (occurrence-contract.md, "Explicit rerun"): this occurrence as a new task, on the
   *  reminder's complete current snapshot. The old run stays as history. Only sent when rerunMode
   *  allows it. confirmed: the owner accepted that running again may repeat what Hermes did, so
   *  a paused occurrence is stopped first, then confirm_rerun binds that consent to its latest
   *  finished run, then rerun. Any refusal on the way is kept for the dialog's pause line. */
  const rerun = async (card, row, { confirmed = false } = {}) => {
    // Busy by card (the reminder), not by occurrence key: the rerun replaces the key mid-flight.
    if (running.current.has(card.id)) return { superseded: true, result: null, shown: null }
    running.current.add(card.id)
    setRerunning(current => ({ ...current, [card.id]: confirmed ? 'confirm' : 'run' }))
    const expected = currentSnapshot(data, card) ?? card.source
    const target = { sourceId: card.source?.id, key: row?.key }
    const refuse = message => {
      setRefusals(current => ({ ...current, [row?.key]: message }))
      return { result: { status: 'failed' }, shown: { tone: 'error', short: message, message }, message }
    }
    try {
      if (confirmed) {
        let work = row.work_before_stop
        if (row.status !== 'stopped') {
          const stopped = await postOccurrences(scope, { action: 'stop', occurrence_id: row.key })
          const said = stopOutcome(stopped)
          if (said.result?.status !== 'ok') return refuse(said.message ?? "Couldn't stop it first. Try again")
          work = stopped.work_before_stop
        }
        const run = confirmableRun(work)
        if (run == null) return refuse("Hermes hasn't finished stopping. Try again in a moment")
        const confirm = await postOccurrences(scope, { action: 'confirm_rerun', occurrence_id: row.key, run_id: run })
        if (confirm?.status !== 'ok') return refuse(occurrenceProblem(confirm))
      }
      const answer = await postOccurrences(scope, { action: 'rerun', occurrence_id: row?.key, expected })
      const outcome = occurrenceOutcome(answer, 'rerun', target)
      if (outcome.result?.status === 'ok') created([answer?.task?.key])
      setRefusals(current => {
        const next = { ...current }
        if (outcome.result?.status === 'ok') delete next[row?.key]
        else next[row?.key] = outcome.message
        return next
      })
      return outcome
    } catch (error) {
      const kind = classifyError(error)
      if (kind.kind === 'superseded') return { superseded: true, result: null, shown: null }
      return refuse(occurrenceOutcome(null, 'rerun', target, kind).message)
    } finally {
      // The new task's place in the admission queue is on ticket 13's read: without it a queued
      // rerun would read Paused for a moment. The footer stays busy until all three are back.
      await Promise.all([
        reread(),
        client.refetchQueries({ queryKey: queryKey(scope, 'delegation'), exact: true }),
        client.invalidateQueries({ queryKey: queryKey(scope, 'attention-live') })
      ]).catch(() => {})
      running.current.delete(card.id)
      setRerunning(current => {
        const next = { ...current }
        delete next[card.id]
        return next
      })
      void refreshBoard()
    }
  }

  /** The owner's answer to "Did you check it off in Reminders?" (resolve_advance): 'checked_off'
   *  accepts the saved result and the next date waits in To do; 'date_moved' leaves a changed-date
   *  pause that Run again (confirm, rerun) or Stop then answers. A refusal shows as the pause line. */
  const resolve = async (card, answer) => {
    const row = card.agent?.row
    const said = message => {
      setRefusals(current => {
        const next = { ...current }
        if (message) next[row?.key] = message
        else delete next[row?.key]
        return next
      })
      return { result: { status: message ? 'failed' : 'ok' }, message }
    }
    try {
      const reply = await postOccurrences(scope, resolveRequest(row, answer))
      return said(reply?.status === 'ok' ? null : resolveProblem(reply))
    } catch (error) {
      const kind = classifyError(error)
      if (kind.kind === 'superseded') return { superseded: true, result: null, shown: null }
      return said(resolveProblem(null, kind))
    } finally {
      // The answer changes the row's fields (the question goes away), so read them back whole.
      await Promise.all([reread(), client.invalidateQueries({ queryKey: queryKey(scope, 'attention-live') })]).catch(() => {})
      void refreshBoard()
    }
  }

  /** A held Every occurrence series (recurring-contract.md, "Owner resolution of a held series"):
   *  'reauthorize' keeps going under the reminder as it is now (a new occurrence follows the held
   *  one), 'end' stops repeating with Hermes and the reminder is yours again. Either way the
   *  history stays. Returns { ok, message }. */
  const resolveSeries = async (card, decision) => {
    const row = card.agent?.row
    const expected = currentSnapshot(data, card) ?? card.source
    try {
      const answer = await postRecurring(scope, resolveSeriesRequest(row, decision, expected))
      if (answer?.status !== 'ok') return { ok: false, message: resolveSeriesProblem(answer) }
      if (decision === 'reauthorize') created([answer.receipt?.key])
      return { ok: true, message: decision === 'end' ? 'Stopped repeating with Hermes. The reminder is yours again.' : 'Hermes keeps going with this reminder.' }
    } catch (error) {
      const kind = classifyError(error)
      if (kind.kind === 'superseded') return { superseded: true }
      return { ok: false, message: resolveSeriesProblem(null, kind) }
    } finally {
      await Promise.all([reread(), client.invalidateQueries({ queryKey: queryKey(scope, 'attention-live') })]).catch(() => {})
      void refreshBoard()
    }
  }

  // Ticket 13's agent door for useEditor, with occurrence cards routed here.
  const agent = useMemo(
    () => ({
      ...delegation,
      act: (action, card) => (card.agent?.row?.scope || ((action === 'ready' || action === 'every') && isRecurring(card)) ? act(action, card) : delegation.act(action, card)),
      choose: card => {
        // Only a plain reminder has the Delegate menu to open; a stopped one opens its Run again ask.
        if (!card.agent) setAsking(card.id)
        onChoose?.(card.id)
      }
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [delegation, data]
  )

  /** Board cards with one-off and occurrence work placed, and occurrence history attached.
   *  live: ticket 13's GET /attention states by task, which occurrence tasks share. */
  const place = useCallback(
    (cards, live = null) =>
      withOccurrences(placeCards(cards, withOccurrenceTasks(delegation.rows, data), live), data).map(card =>
        card.occurrence && refusals[card.occurrence.key] ? { ...card, occurrence: { ...card.occurrence, refusal: refusals[card.occurrence.key] } } : card
      ),
    [delegation.rows, data, refusals]
  )

  return {
    data,
    // Occurrences still out: the board keeps reading live task states for them with pickup off too.
    watching: open,
    error: query.isError ? classifyError(query.error) : null,
    agent,
    act,
    takeOver: (card, choice) => act(choice, card, { takeOver: true }),
    tick,
    resolve,
    resolveSeries,
    place,
    asking,
    rerunning: cardId => rerunning[cardId] ?? null,
    tickedAt,
    settleAsking: () => setAsking(null),
    reread
  }
}
