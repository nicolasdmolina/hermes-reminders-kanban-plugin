// Agent pickup for one connection and profile: the /delegation read, the owner tick while the
// board is open, and the deliberate actions (activate, deactivate, board maximum, model choice,
// delegate, accept, resume).
// Contract: reminders_kanban/api/delegation-contract.md. Placement lives in lib/placement.js.
import { useQuery, useQueryClient } from '@hermes/plugin-sdk'
import { useEffect, useMemo, useRef, useState } from 'react'

import { isRouted, queryKey } from '../api/client.js'
import { getDelegation, getLiveAttention, postDelegation, postModelChoice, postStop } from '../api/delegation.js'
import { readThroughActivation } from '../lib/reads.js'
import { classifyError } from '../lib/state.js'
import { actionOutcome, confirmOutcome, deactivationOutcome, keepsTicking, mergeRows, problemText, stopOutcome, withStop, runActivation } from '../lib/delegation-outcomes.js'
import { takeOverRequest } from '../lib/elsewhere.js'
import { onlyClaimChanged } from '../lib/task-link.js'
import { DEFAULT_CHOICE, normalChoice, saveQueue } from '../lib/model-choice.js'

// The owner tick observes sources, runs maintenance and starts eligible work. One at a time,
// while the board is visible and pickup is on, or off with work still out (it admits nothing new).
const TICK_MS = 12_000
// GET /attention reads each task's state live from Hermes (no Reminders read), so the board
// places a just-asked question in Needs you without waiting for the next tick.
const LIVE_MS = 5_000

// Failures that mean the owning Hermes can't run anything for this board right now.
const OWNER_DOWN = new Set(['unavailable_host', 'auth', 'backend_missing'])

const statusKey = data => (data?.tasks ?? []).map(row => `${row.key}:${row.status}`).join('|')

/** boardReadAt: when the board last read Reminders. A new read (lists chosen, refresh) rereads
 *  delegation too, so eligible Ready work and placement follow the same observation. watching:
 *  repeating reminders' occurrences are still out, so live task states keep coming with pickup off. */
export function useDelegation(scope, boardReadAt = 0, { watching = false } = {}) {
  const client = useQueryClient()
  const key = queryKey(scope, 'delegation')
  // Model saves that have landed, and the last one's answer with its scope. A read that set out
  // before a save landed carries the old choice, so it takes the saved one instead (no cancelling:
  // other actions await their rereads).
  const modelSaves = useRef(0)
  const lastSaved = useRef(null)
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const started = modelSaves.current
      const answer = await readThroughActivation(() => getDelegation(scope), () => isRouted(scope))
      const saved = lastSaved.current
      if (started === modelSaves.current || answer?.status !== 'ok' || saved?.scope !== scope.join('\u0000')) return answer
      return { ...answer, model_choice: saved.choice }
    },
    enabled: () => isRouted(scope),
    // Each read launches the native helper; a busy helper or a slow first boot can fail one read.
    retry: 2,
    retryDelay: 2000,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    // While it can't be read (or isn't set up), look again now and then instead of staying stuck.
    refetchInterval: current => ((current?.state ? current.state.data : current)?.status === 'ok' ? false : 30_000)
  })
  const data = query.data
  const ok = data?.status === 'ok'
  // GET /delegation reads Reminders, so while Reminders can't be read it answers without tasks
  // (status failed/access_denied). Delegated cards keep their last known place and state until a
  // read succeeds, under the board's stale notice (ticket 25), instead of falling back to To do.
  const lastOk = useRef(null)
  const [tickedAt, setTickedAt] = useState(0)
  // The owner stopped answering, as the board's frequent calls (the live read every 5 s, the tick
  // every 12 s) find out: Pickup never reads as on while it can't run, and the board rereads at once
  // so its own notice says so (ticket 25, lane 28A). A classified failure, or null.
  const [unreachable, setUnreachable] = useState(null)
  const noteFailure = error => {
    const kind = classifyError(error)
    if (OWNER_DOWN.has(kind.kind)) setUnreachable(current => (current?.kind === kind.kind ? current : kind))
  }
  if (ok) lastOk.current = data
  // Only events after the newest one seen come back; the live task states always do.
  const cursor = useRef(0)
  const liveOn = keepsTicking(data?.status === 'ok' ? Boolean(data.pickup_enabled) : null, data) || (watching && data?.status === 'ok')
  const live = useQuery({
    queryKey: queryKey(scope, 'attention-live'),
    queryFn: async () => {
      let feed
      try {
        feed = await readThroughActivation(() => getLiveAttention(scope, cursor.current), () => isRouted(scope))
      } catch (error) {
        noteFailure(error)
        throw error
      }
      setUnreachable(null)
      if (feed?.status === 'ok' && Number.isInteger(feed.cursor)) cursor.current = feed.cursor
      return feed
    },
    enabled: () => isRouted(scope) && liveOn,
    retry: false,
    refetchInterval: () => (document.visibilityState === 'visible' ? LIVE_MS : false),
    refetchOnWindowFocus: true
  })
  // null while unknown: drags into Ready for Agent wait instead of guessing.
  const failed = query.isError && classifyError(query.error).kind !== 'superseded'
  const pickup = ok ? Boolean(data.pickup_enabled) : failed || (data && !ok) ? false : null
  const ticks = keepsTicking(pickup, data)
  const [activating, setActivating] = useState(false)
  const [deactivating, setDeactivating] = useState(false)
  const [problem, setProblem] = useState(null)
  const ticking = useRef(false)
  const last = useRef(null)
  // Bumped by every switch flip: a tick that set out before it answers about the old state.
  const flips = useRef(0)

  const refreshBoard = () => client.invalidateQueries({ queryKey: queryKey(scope, 'preview') })
  // The reminder as the board reads it now (a fresh read), for a retry on a stale snapshot.
  const freshSource = async id => {
    await client.refetchQueries({ queryKey: queryKey(scope, 'preview'), exact: true }).catch(() => {})
    return (client.getQueryData(queryKey(scope, 'preview'))?.cards ?? []).find(entry => entry?.source?.id === id)?.source ?? null
  }
  const reread = () => client.refetchQueries({ queryKey: key, exact: true })

  // Merge a tick answer into the cached read (it has tasks and limits, not eligible or lists).
  // The tick answers with bare rows; GET adds each task's view (work_before_stop, stopped_at, ...).
  // Keep those by row key, and reread GET when a status changed so the views are current again.
  const absorb = (answer, flip) => {
    if (answer && isRouted(scope)) setUnreachable(null)
    if (!answer || answer.status !== 'ok' || !isRouted(scope)) return
    // A tick answer means the owner reread every delegated reminder (ticket 25's reconnect waits on it).
    setTickedAt(Date.now())
    const before = statusKey(client.getQueryData(key))
    const enabled = flip === flips.current && typeof answer.pickup_enabled === 'boolean' ? { pickup_enabled: answer.pickup_enabled } : {}
    client.setQueryData(key, current => (current ? { ...current, tasks: mergeRows(current.tasks, answer.tasks), limits: answer.limits, ...enabled } : current))
    if (statusKey(answer) !== before) void client.invalidateQueries({ queryKey: key, exact: true })
  }

  // One tick at a time. A caller gets the tick in flight, so what it awaits is a finished check;
  // `after: true` asks for a check that starts after now (one that sees a Stop just made).
  const inFlight = useRef(null)
  const tick = ({ after = false } = {}) => {
    if (inFlight.current) return after ? inFlight.current.then(() => tick()) : inFlight.current
    if (!isRouted(scope)) return Promise.resolve()
    ticking.current = true
    const flip = flips.current
    const run = (async () => {
      try {
        absorb(await postDelegation(scope, { action: 'tick' }), flip)
      } catch (error) {
        // The next read or tick shows what happened; ticks are safe to repeat.
        noteFailure(error)
      } finally {
        ticking.current = false
        inFlight.current = null
      }
    })()
    inFlight.current = run
    return run
  }

  useEffect(() => {
    if (!ticks) return undefined
    // Owner refresh and reconnect: tick once now, then on a gentle interval while visible.
    void tick()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void tick()
    }, TICK_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticks, scope.join('\u0000')])

  // Owner gone: reread the board now, so its notice (Can't reach Hermes, Sign in again) shows within
  // a read instead of at the next minute's poll. A good delegation read clears it too.
  useEffect(() => {
    if (unreachable) void refreshBoard()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreachable])
  useEffect(() => {
    if (query.isSuccess && !query.isFetching) setUnreachable(null)
  }, [query.isSuccess, query.isFetching, query.dataUpdatedAt])

  useEffect(() => {
    if (boardReadAt) void client.invalidateQueries({ queryKey: key, exact: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardReadAt])

  // A status change can mean a completed reminder, so the board rereads Reminders too.
  useEffect(() => {
    const now = statusKey(data)
    if (last.current !== null && now !== last.current) void refreshBoard()
    last.current = now
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  /** The one explicit activation. Safe to repeat: the backend keeps task identity. A model choice
   *  still saving lands first, so the tasks it starts take it; a failed save stops it here. */
  const activate = async () => {
    if (activating || deactivating) return
    setActivating(true)
    setProblem(null)
    flips.current += 1
    // Only saves still out count: an earlier failed one already put the row back to what is saved.
    const saved = models.pending > 0 ? await models.settled() : null
    if (saved?.problem) {
      setProblem(saved.problem)
      setActivating(false)
      return { failed: true }
    }
    if (saved?.superseded) {
      setActivating(false)
      return { superseded: true }
    }
    return runActivation({
      post: () => postDelegation(scope, { action: 'activate' }),
      reread,
      refreshBoard,
      classify: classifyError,
      onProblem: setProblem,
      onSettled: () => setActivating(false)
    })
  }

  /** Pickup off (pickup-off BUILD.md): nothing new starts; running tasks finish. Safe to repeat. */
  const deactivate = async () => {
    if (activating || deactivating) return
    setDeactivating(true)
    setProblem(null)
    flips.current += 1
    return runActivation({
      post: () => postDelegation(scope, { action: 'deactivate' }),
      read: deactivationOutcome,
      reread,
      refreshBoard,
      classify: classifyError,
      onProblem: setProblem,
      onSettled: () => setDeactivating(false)
    })
  }

  // The board's model choice for new tasks (model-choice-contract.md). Saves go out in order; the
  // row shows the newest pick until they land, then the saved choice, or the old one and why not.
  const scopeKey = scope.join('\u0000')
  const [wanted, setWanted] = useState(null)
  const [modelProblem, setModelProblem] = useState(null)
  useEffect(() => {
    setWanted(null)
    setModelProblem(null)
  }, [scopeKey])
  const models = useMemo(
    () =>
      saveQueue(async choice => {
        try {
          const answer = await postModelChoice(scope, choice)
          if (answer?.status !== 'ok' || !answer.model_choice) return { problem: problemText(answer) }
          lastSaved.current = { scope: scope.join('\u0000'), choice: answer.model_choice }
          modelSaves.current += 1
          if (isRouted(scope)) client.setQueryData(key, current => (current ? { ...current, model_choice: answer.model_choice } : current))
          return { ok: true, choice: answer.model_choice }
        } catch (error) {
          const kind = classifyError(error)
          if (kind.kind === 'superseded') return { superseded: true }
          return { problem: problemText(null, kind) }
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopeKey]
  )
  const setModelChoice = async choice => {
    setWanted(normalChoice(choice))
    setModelProblem(null)
    const outcome = await models.save(choice)
    if (models.pending === 0) setWanted(null)
    if (outcome.problem) setModelProblem(outcome.problem)
    return outcome
  }
  const savedChoice = ok ? normalChoice(data.model_choice ?? DEFAULT_CHOICE) : null

  /** Board maximum: a positive number, or null to inherit Hermes' limit. */
  const setMaximum = async maximum => {
    try {
      const answer = await postDelegation(scope, { action: 'maximum', maximum })
      if (answer?.status === 'ok' && isRouted(scope)) {
        client.setQueryData(key, current => (current ? { ...current, limits: answer.limits } : answer))
        return { ok: true }
      }
      return { problem: actionOutcome(answer, 'maximum').message }
    } catch (error) {
      return { problem: actionOutcome(null, 'maximum', classifyError(error)).message }
    }
  }

  /**
   * One deliberate card action: 'ready' (delegate), 'accept', 'resume' or 'stop'. Resolves to
   * { result: { status }, shown } in the shape ticket 10's move settlement reads; the delegation
   * read is refreshed before it resolves, so the card lands where the row now places it.
   */
  const act = async (action, card) => {
    const row = card.agent?.row
    const body =
      action === 'ready'
        ? { action, expected: card.source }
        : action === 'resume'
          ? { action, expected: { id: row.expected.id }, instruction_version: row.guard?.instruction_version }
          : { action, expected: { id: row.expected.id } }
    try {
      if (action === 'stop') {
        const answer = await postStop(scope, row.task_id)
        const outcome = stopOutcome(answer)
        // The answer already says what Hermes had done; the board needs it before any read lands.
        if (isRouted(scope)) client.setQueryData(key, current => withStop(current, answer))
        await Promise.all([reread(), client.invalidateQueries({ queryKey: queryKey(scope, 'attention-live') })])
        void refreshBoard()
        // The reminder is yours again: the owner's next check takes this Mac's claim line off it,
        // so the other Mac stops showing it as taken. Asked for now, since nothing may be ticking.
        void tick({ after: true }).then(refreshBoard)
        return outcome
      }
      let answer = await postDelegation(scope, body)
      if (action === 'ready' && answer?.status !== 'ok' && answer?.status !== 'inactive') {
        // The board's copy may be a moment old (a claim line just came off after Stop): read the
        // reminder again, and send once more when nothing but a claim line differs.
        const fresh = await freshSource(card.source.id)
        if (onlyClaimChanged(card.source, fresh)) answer = await postDelegation(scope, { ...body, expected: fresh })
      }
      const outcome = actionOutcome(answer, action, card.source.id)
      await Promise.all([reread(), client.invalidateQueries({ queryKey: queryKey(scope, 'attention-live') })])
      // The other Mac claimed it since the board read it: show the card as that Mac's now.
      if (answer?.reason === 'other_mac') void refreshBoard()
      return outcome
    } catch (error) {
      const kind = classifyError(error)
      if (kind.kind === 'superseded') return { superseded: true, result: null, shown: null }
      await reread().catch(() => {})
      return action === 'stop' ? stopOutcome(null, kind) : actionOutcome(null, action, card.source.id, kind)
    }
  }

  /** Take over here (lib/elsewhere.js): this Hermes replaces the other Mac's claim on a one-off
   *  reminder and delegates it like any other. The board rereads, since the claim is its to show. */
  const takeOver = async card => {
    try {
      const answer = await postDelegation(scope, takeOverRequest(card)[1])
      const outcome = actionOutcome(answer, 'ready', card.source.id)
      // Awaited, board included: the footer stays busy until the card is this Mac's task.
      await Promise.all([reread(), refreshBoard(), client.invalidateQueries({ queryKey: queryKey(scope, 'attention-live') })])
      return outcome
    } catch (error) {
      const kind = classifyError(error)
      if (kind.kind === 'superseded') return { superseded: true, result: null, shown: null }
      await reread().catch(() => {})
      return actionOutcome(null, 'ready', card.source.id, kind)
    }
  }

  /** The owner's consent to run a stopped task again, bound to its latest finished run. */
  const confirmRerun = async (card, runId) => {
    try {
      const answer = await postDelegation(scope, { action: 'confirm_rerun', task_id: card.agent.row.task_id, run_id: runId })
      return confirmOutcome(answer)
    } catch (error) {
      const kind = classifyError(error)
      if (kind.kind === 'superseded') return { superseded: true }
      return confirmOutcome(null, kind)
    }
  }

  return {
    data,
    // What placement reads: this read, or the last good one while it fails.
    rows: ok ? data : lastOk.current ?? data,
    tickedAt,
    confirmRerun,
    takeOver,
    // A snapshot from before polling stopped would outrank fresher rows, so it goes with the polling.
    live: liveOn && live.data?.status === 'ok' ? live.data.tasks : null,
    pickup,
    loading: query.isPending,
    // A read dropped as superseded is not a failure of this connection: it is still loading.
    error: failed ? classifyError(query.error) : unreachable,
    limits: data?.limits ?? null,
    eligible: ok ? (data.eligible ?? []) : [],
    activating,
    deactivating,
    problem,
    activate,
    deactivate,
    // null until read; an older backend without the field reads as the profile's own.
    modelChoice: wanted ?? savedChoice,
    modelSaving: wanted != null,
    modelProblem,
    setModelChoice,
    setMaximum,
    act,
    reread,
    tick
  }
}
