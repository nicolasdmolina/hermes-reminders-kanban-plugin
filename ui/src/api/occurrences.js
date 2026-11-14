// This occurrence delegation (reminders_kanban/api/occurrence-contract.md). GET /occurrences is
// read-only; POST /occurrences/actions takes ready, tick and accept. Both go through `request`,
// so answers for another connection or profile are dropped.
import { request } from './client.js'

export const getOccurrences = scope => request(scope, '/occurrences')

/** POST /occurrences/actions. `body` is { action, expected?, occurrence_id?, resources? }. */
export const postOccurrences = (scope, body) => request(scope, '/occurrences/actions', { method: 'POST', body })
