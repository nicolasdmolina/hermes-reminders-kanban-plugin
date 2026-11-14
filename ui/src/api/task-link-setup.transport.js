// The real transport for task-link setup: the plugin's scoped client, and task_links as the
// delegation read reports them (GET /delegation `task_links`: { status, reason, mode }).
export { request as transport } from './client.js'

export const useTaskLinks = delegation => delegation?.data?.task_links ?? null
