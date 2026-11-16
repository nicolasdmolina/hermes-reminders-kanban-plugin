// Agent pickup and delegation (reminders_kanban/api/delegation-contract.md). GET /delegation is
// read-only; POST /delegation/actions takes activate, deactivate, ready, maximum, tick, accept and resume.
// Both go through `request`, so answers for another connection or profile are dropped.
import { request } from './client.js'

export const getDelegation = scope => request(scope, '/delegation')

/** POST /delegation/actions. `body` is { action, expected?, resources?, maximum?, instruction_version? }. */
export const postDelegation = (scope, body) => request(scope, '/delegation/actions', { method: 'POST', body })

/** GET /attention (attention-contract.md), read here only for each task's live state. */
export const getLiveAttention = (scope, after = 0) => request(scope, `/attention?after=${after}`)

/** POST /delegation/{task_id}/stop (delegation-contract.md, "Stop a delegated task"): stops queued
 *  or running work, releases its slot and leaves the reminder unchecked. `taskId` is the row's
 *  `task_id` from GET /delegation. No body. Idempotent. */
export const postStop = (scope, taskId) => request(scope, `/delegation/${encodeURIComponent(taskId)}/stop`, { method: 'POST' })
