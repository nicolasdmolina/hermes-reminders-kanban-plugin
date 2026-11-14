import { ACCESS } from './access.js'
// What a POST /delegation/actions answer means for the person who asked (delegation-contract.md).
// Pure: no host imports. The envelope can be `ok` while this card's own row needs attention, so
// every outcome reads the row for the card's reminder, never the envelope alone.
//
// actionOutcome returns { result: { status }, shown } in the shape ticket 10's move settlement
// reads (shown: { tone, short, message, replay, action }). Delegation actions are safe to repeat
// (the backend keeps task identity), so they never take ticket 10's "unknown save" path.

// Run again keeps the stopped run's row (archived under `storage_key`) beside the new one: the
// current run is the row without it, else the newest (placement.js rowFor).
const row = (answer, sourceId) => {
  const rows = (answer?.tasks ?? []).filter(task => task?.expected?.id === sourceId)
  return rows.find(task => !task.storage_key) ?? rows.at(-1) ?? null
}

const shown = (tone, short, message) => ({ tone, short, message, replay: false, action: null })

const PROBLEMS = {
  inactive: 'Turn on agent pickup first.',
  native_host_required: "Agent pickup isn't available in this Hermes setup. You can still use the Reminders board.",
  select_lists: 'Choose a list for the board first.',
  owner_board_unavailable: "This Hermes isn't set up for agent work yet.",
  // Task-link setup (link-setup BUILD.md): activate refuses until links are ready or "Only on this Mac".
  task_link_writer_unavailable: 'Set up task links first, or choose Only on this Mac.',
  task_link_origin_missing: 'Set up task links first, or choose Only on this Mac.',
  task_link_origin_invalid: "The saved phone address can't be used for task links. Set up task links again.",
  access_denied: ACCESS.full,
  // #80: an action that needs a fresh source read while Reminders can't be read (e.g. Accept).
  waiting_source: "Hermes can't read Reminders right now. Try again once it's back.",
  unreachable: "Couldn't reach Hermes. Try again.",
  auth: 'Sign in to Hermes again.',
  backend_missing: 'Reminders Kanban is off for this profile.'
}

/** The board's wait label for a task dialog, or undefined. Queued work says what its card says.
 *  Admission parks queued work, which Hermes reports as paused. Until the board's next delegation
 *  read places a one-off card (just delegated, or a stopped card whose Run again is under way),
 *  its task link already shows that parked run: it is waiting for a slot, so it reads "Up next",
 *  not "Paused". A real pause comes with the board's own paused row, and a repeating reminder's
 *  occurrence has its own lines. */
export function dialogQueuedLabel(agent, recurring = false) {
  if (agent?.status === 'ready') return agent.line ?? agent.label
  if (recurring || agent?.row?.scope) return undefined
  if (!agent || agent.status === 'stopped') return 'Up next'
  return undefined
}

/** Why a non-ok answer (or a transport failure `kind`) stopped an action, in plain words. */
export function problemText(answer, kind = null) {
  if (kind) return PROBLEMS[kind.kind] ?? PROBLEMS.unreachable
  const status = answer?.status
  if (status === 'setup_required') return PROBLEMS[answer.reason] ?? PROBLEMS.owner_board_unavailable
  if (status === 'attention') return attentionText(answer.reason)
  // Another Mac's Hermes claimed it since the board last read it.
  if (status === 'conflict' && answer.reason === 'other_mac') return `Hermes on ${answer.mac ?? 'another Mac'} has this`
  return PROBLEMS[status] ?? "Hermes couldn't do that. Try again."
}

function attentionText(reason) {
  const text = String(reason ?? '')
  if (/source changed/.test(text)) return 'The reminder changed in Reminders. Try again.'
  if (/external effects need reconciliation/.test(text)) return 'Hermes was partway through. Confirm running it again first.'
  if (/completion needs reconciliation/.test(text)) return "Hermes was finishing this reminder. It can't run again yet."
  if (/worker still alive/.test(text)) return 'The last run is still stopping. Try again in a moment.'
  if (/unassociated task link/.test(text)) return 'This reminder already has a task link.'
  if (/one-off required/.test(text)) return 'Use Delegate on a repeating reminder to choose which dates go to Hermes.'
  if (/selected list unavailable/.test(text)) return "One of the board's lists is unavailable."
  if (/not delegated/.test(text)) return "This reminder isn't delegated."
  if (/completion already attempted/.test(text)) return 'Hermes already started completing this reminder.'
  if (/gateway dispatch|automatic review/.test(text)) return 'Hermes is set to start tasks by itself, so agent pickup is off here.'
  return "Hermes couldn't do that. Try again."
}

/** The Agent pickup switch's steps, either way. A refusal frees the switch and shows why at once,
 *  then rereads behind it (a slow owner can take a minute to answer the reread); success stays busy
 *  until the reread shows the new state. `classify` maps a thrown request to a failure kind.
 *  `read` is activationOutcome (on) or deactivationOutcome (off). */
export async function runActivation({ post, reread, refreshBoard, classify, onProblem, onSettled, read = activationOutcome }) {
  let settled = false
  const settle = () => {
    if (settled) return
    settled = true
    onSettled()
  }
  try {
    const outcome = read(await post())
    if (outcome.problem) {
      onProblem(outcome.problem)
      settle()
    }
    await reread()
    void refreshBoard()
    return outcome
  } catch (error) {
    const kind = classify(error)
    if (kind.kind === 'superseded') return { superseded: true }
    if (!settled) onProblem(read(null, kind).problem)
    return { failed: true }
  } finally {
    settle()
  }
}

/** Activation: { ok } or { problem }. */
export function activationOutcome(answer, kind = null) {
  if (!kind && answer?.status === 'ok' && answer.pickup_enabled) return { ok: true }
  return { problem: problemText(answer, kind) }
}

/** Deactivation (pickup-off BUILD.md): { ok } or { problem }. */
export function deactivationOutcome(answer, kind = null) {
  if (!kind && answer?.status === 'ok' && answer.pickup_enabled === false) return { ok: true }
  return { problem: problemText(answer, kind) }
}

// Rows the owner still has to watch: anything not finished, stopped or gone.
const SETTLED = new Set(['done', 'stopped', 'deleted'])

/** Whether the owner tick should run: pickup on, or work still out with pickup off (running tasks
 *  finish, and questions, results and recovery keep arriving; the owner admits nothing new). */
export function keepsTicking(pickup, data) {
  if (pickup) return true
  if (pickup !== false) return false
  return (data?.tasks ?? []).some(row => row?.status && !SETTLED.has(row.status))
}

// Resume worked once the task runs or queues again. Queued work is parked in Hermes' scheduled
// state, which the owner reports as `paused` (with an active guard).
const RESUMED = new Set(['ready', 'active', 'question', 'result'])

/** One card action ('ready', 'accept', 'resume', or 'maximum'). */
export function actionOutcome(answer, action, sourceId = null, kind = null) {
  const fail = message => ({ result: { status: 'failed' }, shown: shown('error', short(message), message), message })
  if (kind || answer?.status !== 'ok') return fail(problemText(answer, kind))
  if (action === 'maximum') return { result: { status: 'ok' }, shown: shown('ok', 'Saved', 'Saved.') }
  const task = row(answer, sourceId)
  if (action === 'accept') {
    if (task?.status === 'done' && task.completion?.status === 'completed') return { result: { status: 'ok' }, shown: shown('ok', 'Accepted', 'Accepted.') }
    if (task?.status === 'needs_reconciliation') {
      return { result: { status: 'pending' }, shown: shown('warn', 'Hermes is checking it', "Accepted in Hermes, but the reminder isn't completed yet. Hermes needs to check it.") }
    }
    return fail("Couldn't accept yet. Try again.")
  }
  if (action === 'resume') {
    if (task && (RESUMED.has(task.status) || task.guard?.status === 'active')) return { result: { status: 'ok' }, shown: shown('ok', 'Resumed', 'Resumed.') }
    return fail("Couldn't resume. Open the task to see why.")
  }
  // Any row for this reminder means its Hermes task exists; placement shows where it is now
  // (queued, linking, or a link problem in Needs you). Rolling the card back would hide real work.
  if (task) return { result: { status: 'ok' }, shown: shown('ok', 'Delegated', 'Delegated.') }
  return fail("Couldn't hand it to Hermes. Try again.")
}

// Card notices are one short line; the full sentence goes to the screen reader.
function short(message) {
  const first = message.split('. ')[0].replace(/\.$/, '')
  return first.length <= 44 ? first : `${first.slice(0, 41).trimEnd()}…`
}

// Stop (POST /delegation/{task_id}/stop). The answer's `outcome` says what happened; the
// idempotent no-ops are still what the person asked for. needs_reconciliation is NOT a stop:
// termination is uncertain, so the card stays in Needs you and the reason shows.
const STOP_DONE = {
  stopped: 'Stopped. The reminder stays open.',
  already_stopped: 'Already stopped.',
  already_finished: 'Already finished. Its accepted result is kept.',
  already_deleted: 'This task was deleted in Reminders.'
}

/** Stop: ok only for a stop (or a settled no-op); needs_reconciliation is pending; else failed. */
export function stopOutcome(answer, kind = null) {
  const ok = message => ({ result: { status: 'ok' }, shown: shown('ok', message.split('. ')[0].replace(/\.$/, ''), message), message })
  const fail = (message, status = 'failed') => ({ result: { status }, shown: shown(status === 'pending' ? 'warn' : 'error', short(message), message), message })
  if (kind) return fail(problemText(null, kind))
  if (answer?.status !== 'ok') return fail(problemText(answer))
  const done = STOP_DONE[answer.outcome]
  if (done) return ok(done)
  if (answer.outcome === 'needs_reconciliation') {
    return fail("Hermes couldn't confirm it stopped. It stays in Needs you until that's checked.", 'pending')
  }
  if (answer.outcome === 'not_found') return fail("Hermes doesn't have this task any more. Refresh the board.")
  return fail("Couldn't stop it. Try again.")
}

// ── Running a stopped task again (delegation-contract.md, "Owner confirmation before rerun") ──

/**
 * The run a rerun confirmation binds to: the latest run of a stopped task's retained work, when it
 * has ended. Null when Hermes never ran it (stopped while queued: it goes straight back), or when
 * this run is already confirmed.
 */
export function rerunToConfirm(row) {
  if (row?.status !== 'stopped') return null
  const runs = row.work_before_stop?.runs ?? []
  const last = runs[runs.length - 1]
  if (!last || last.ended_at == null || last.id == null) return null
  const confirmed = row.rerun_reconciliation?.run_id
  return confirmed != null && String(confirmed) === String(last.id) ? null : last.id
}

const RERUN_REFUSALS = {
  stale_run: 'Hermes did more since this opened. Close it and try again.',
  verified_stop_required: 'Hermes is still stopping. Try again in a moment.'
}

/** confirm_rerun: { ok } or { message } in plain words for the dialog footer. */
export function confirmOutcome(answer, kind = null) {
  if (kind) return { message: problemText(null, kind) }
  if (answer?.status === 'ok' && answer.receipt) return { ok: true }
  if (answer?.status === 'not_found') return { message: "Hermes doesn't have this task any more. Refresh the board." }
  if (answer?.status === 'attention' && RERUN_REFUSALS[answer.reason]) return { message: RERUN_REFUSALS[answer.reason] }
  return { message: problemText(answer) }
}

/** Owner tick rows over the cached GET /delegation rows, matched by `key`: the tick's fields win,
 *  the per-task view fields only GET adds (work_before_stop, stopped_at, ...) stay. */
export function mergeRows(cached, fresh) {
  const byKey = new Map((cached ?? []).map(row => [row.key, row]))
  return (fresh ?? []).map(row => ({ ...(byKey.get(row.key) ?? {}), ...row }))
}

/** The Stop answer over the cached GET /delegation data: its task row and the retained work
 *  (work_before_stop) replace the cached row with the same `key` at once. Until a read lands the
 *  cache still holds the running row's view (no retained work), and a drag to Ready would then
 *  treat a task Hermes had started as one stopped while queued. */
export function withStop(cached, answer) {
  const task = answer?.status === 'ok' ? answer.task : null
  if (!cached?.tasks || !task?.key) return cached
  const stopped = row => ({ ...row, ...task, work_before_stop: answer.work_before_stop ?? null })
  return { ...cached, tasks: cached.tasks.map(row => (row.key === task.key ? stopped(row) : row)) }
}
