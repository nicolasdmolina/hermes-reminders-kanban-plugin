// Every occurrence (reminders_kanban/api/recurring-contract.md). Only `every` and `retry` go here:
// /recurring and /occurrences share one owner, so the read, tick, accept and stop stay on
// api/occurrences.js. Through `request`, so answers for another connection or profile are dropped.
import { request } from './client.js'

/** POST /recurring/actions. `body` is { action: 'every', expected, resources? } or
 *  { action: 'retry', occurrence_id, run_id }. */
export const postRecurring = (scope, body) => request(scope, '/recurring/actions', { method: 'POST', body })
