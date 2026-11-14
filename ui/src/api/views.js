// The board view query (reminders_kanban/workflow/views.md). Display only: it has no
// Reminders or dispatcher effect, so it is safe to repeat on every board read.
import { request } from './client.js'

/** POST /view. `body` is viewRequest() from lib/views.js. */
export const postView = (scope, body) => request(scope, '/view', { method: 'POST', body })
