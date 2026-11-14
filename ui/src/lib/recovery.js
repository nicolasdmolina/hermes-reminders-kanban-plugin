// Recovery states for a delegated task (ticket 17), from the owner's GET /recovery rows
// (reminders_kanban/api/recovery-contract.md). Pure, so node --test covers every state.
// The backend decides the column and the one permitted action; this only names them.

// Native states in which no failure is current: a worker is running, asked, delivered or finished,
// or the task was stopped (a stopped task goes back to you in To do, ticket 13).
// The recovery row and the task are read at different moments, so a stale row never covers these.
const LIVE = new Set(['active', 'question', 'result', 'done', 'stopped'])

/** The recovery a row carries, unless the task (or the row itself) has moved past it. */
export function currentRecovery(row, liveState = null) {
  const recovery = row?.recovery
  if (!recovery || !recovery.action) return null
  // The owner marks a recovery authorized when it lets a new attempt start (a Retry, or a wait or
  // restored account resuming); it is over then, even before the new worker is observed.
  if (recovery.authorized) return null
  if (LIVE.has(liveState) || LIVE.has(row.status)) return null
  if (row.guard && row.guard.status && row.guard.status !== 'active') return null
  return recovery
}

const KINDS = {
  // A usage limit: Hermes tries again by itself. Only the native next-check time is known.
  wait: { label: 'Waiting for capacity', tone: 'waiting', card: 'Waiting for capacity' },
  // An empty paid balance: the person adds funds where Hermes manages billing (never bought here);
  // it resumes on its own once the account is restored.
  fund_account: { label: 'Balance empty', tone: 'attention', card: 'Balance empty' },
  // A broken sign-in: the person repairs it in Hermes settings.
  repair_access: { label: 'Sign-in needs repair', tone: 'attention', card: 'Sign-in needs repair' },
  // An ordinary failed attempt: a deliberate Retry starts a new attempt on the same task.
  // One name on the card and the pill: "Stopped" is for work someone stopped on purpose.
  retry: { label: 'Needs a retry', tone: 'danger', card: 'Needs a retry' },
  // Effects of the last attempt are unknown. Nothing checks them on its own (recovery-contract.md:
  // a trusted owner adapter must), so the person checks it in Hermes, or stops it to take it back.
  reconcile: { label: 'Needs a check', tone: 'attention', card: 'Needs a check' }
}

const parseTime = iso => {
  const time = typeof iso === 'string' ? Date.parse(iso) : NaN
  return Number.isNaN(time) ? null : new Date(time)
}

/**
 * What to show for one recovery: { action, label, tone, card, column, nextCheck, due, control,
 * line }. `control` is the one control offered: 'retry', 'repair', 'billing' or null. `nextCheck` is set only
 * for an automatic usage wait (never a reset or funding time); `due` says that time has passed.
 */
export function recoveryView(recovery, { now = new Date(), canRepair = true } = {}) {
  if (!recovery) return null
  const kind = KINDS[recovery.action]
  if (!kind) return null
  const wait = recovery.action === 'wait'
  const nextCheck = wait ? parseTime(recovery.next_check_at) : null
  const due = Boolean(nextCheck && nextCheck.getTime() <= now.getTime())
  const occupied = Boolean(recovery.occupied)
  let control = null
  if (recovery.action === 'retry') control = 'retry'
  if (recovery.action === 'repair_access' && !recovery.access_repaired && canRepair) control = 'repair'
  if (recovery.action === 'fund_account' && canRepair) control = 'billing'
  return {
    action: recovery.action,
    label: kind.label,
    tone: kind.tone,
    card: kind.card,
    column: recovery.column ?? (wait ? 'In progress' : 'Needs you'),
    nextCheck,
    due,
    occupied,
    control,
    runId: recovery.run_id ?? null,
    line: lineFor(recovery, { nextCheck, due, occupied, canRepair })
  }
}

function lineFor(recovery, { nextCheck, due, occupied, canRepair }) {
  switch (recovery.action) {
    case 'wait':
      return { text: 'Hermes hit a usage limit and will try again on its own.', time: nextCheck, due }
    case 'fund_account':
      return {
        text: canRepair
          ? 'Add funds to your model provider account. Hermes starts again on its own after that.'
          : 'Add funds to your model provider account in Hermes on your Mac. Hermes starts again on its own after that.'
      }
    case 'repair_access':
      return recovery.access_repaired
        ? { text: 'The sign-in is repaired. Hermes is starting again.' }
        : {
            text: canRepair
              ? "Hermes couldn't sign in to its model provider. Sign in again in Settings; the task stays here until Hermes confirms it works."
              : "Hermes couldn't sign in to its model provider. Sign in again in Hermes settings on your Mac; the task stays here until Hermes confirms it works."
          }
    case 'retry':
      return occupied
        ? { text: 'The last attempt is still closing.' }
        : { text: 'Retry starts a new attempt on the same task.' }
    case 'reconcile':
      return {
        text: canRepair
          ? "Hermes isn't sure whether this finished. Check it in Hermes, or stop it to take it back."
          : "Hermes isn't sure whether this finished. Check it in Hermes on your Mac."
      }
    default:
      return null
  }
}

// The run that hit an empty balance ended like a usage limit (exit 75); while the balance recovery
// shows, that run's history line (matched by the recovery's run_id) says what happened instead.
const BALANCE_RUN = 'Balance ran out'

/** The thread with a balance recovery's run named for what it was; anything else unchanged. */
export function historyFor(thread, rec) {
  if (rec?.action !== 'fund_account' || rec.runId == null) return thread
  return thread.map(item => (item.type === 'activity' && item.runId != null && String(item.runId) === String(rec.runId) ? { ...item, label: BALANCE_RUN } : item))
}

/** The earliest next-check time among usage waits, or null. */
export function nextCheckDue(feed) {
  let soonest = null
  for (const row of Array.isArray(feed?.tasks) ? feed.tasks : []) {
    const recovery = currentRecovery(row)
    if (recovery?.action !== 'wait') continue
    const time = parseTime(recovery.next_check_at)
    if (time && (!soonest || time < soonest)) soonest = time
  }
  return soonest
}

/** Outcome of POST /recovery/actions retry for this source: 'started', 'refused' or 'problem'. */
export function retryOutcome(response, sourceId) {
  if (!response || typeof response !== 'object') return { kind: 'problem', message: "Couldn't reach Hermes. Try again." }
  if (response.status === 'attention') {
    return {
      kind: 'refused',
      message: response.task
        ? "Hermes couldn't retry this yet. It is checking the task again."
        : "Hermes couldn't retry this task."
    }
  }
  if (response.status === 'ok') {
    // A permitted retry is marked authorized (no longer current) before its worker is observed.
    const row = (response.tasks ?? []).find(task => task?.expected?.id === sourceId)
    if (row && currentRecovery(row)?.action === 'retry') {
      return { kind: 'refused', message: "Hermes couldn't retry this yet. It is checking the task again." }
    }
    return { kind: 'started' }
  }
  if (response.status === 'inactive') return { kind: 'refused', message: 'Turn on agent pickup first.' }
  if (response.status === 'setup_required') return { kind: 'problem', message: "This Hermes isn't set up for agent work." }
  return { kind: 'problem', message: "Hermes couldn't retry this. Try again." }
}
