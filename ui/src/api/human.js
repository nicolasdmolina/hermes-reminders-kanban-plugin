// Human reminder actions (reminders_kanban/api/human-contract.md). The board itself is
// read through GET /human/board in board-data.js; this file owns the write door.
import { oneAtATime } from '../lib/reads.js'
import { request } from './client.js'

// Each read launches the Reminders helper, and an action asks for several at once (its own
// refresh, the owner check's, the status change's): one runs, and one more waits for it.
export const getHumanBoard = oneAtATime(scope => request(scope, '/human/board'))

/** POST /human/actions. `body` is { operation_id, action, expected, fields }. */
export const postHumanAction = (scope, body) => request(scope, '/human/actions', { method: 'POST', body })
