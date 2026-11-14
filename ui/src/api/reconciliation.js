// Reconnection and identity recovery (reminders_kanban/api/reconciliation-contract.md). GET is the
// owner's durable view and works while Reminders is unreadable; POST recheck rereads the source for
// one workflow without starting any work. Both go through `request`, so answers for another
// connection or profile are dropped.
import { request } from './client.js'

export const getReconciliation = scope => request(scope, '/reconciliation')

// A recheck rereads every delegated reminder, one native read after another, under the owner's
// lock: on a large list (about 800 reminders, 2026-11-08) it outlasts the usual 90 s request limit.
const RECHECK_MS = 10 * 60_000

/** POST /reconciliation/actions {action: "recheck", workflow}. workflow: 'one_off' or 'recurring'. */
export const postRecheck = (scope, workflow) =>
  request(scope, '/reconciliation/actions', { method: 'POST', body: { action: 'recheck', workflow }, timeoutMs: RECHECK_MS })
