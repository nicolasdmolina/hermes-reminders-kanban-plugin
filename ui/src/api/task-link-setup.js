// Task-link setup routes (link-setup BUILD.md). GET reads only; every write is a POST from a click.
// Calls go through `transport`, which is the real client in every shipped build. A capture-only
// build (RK_LINK_STUB=1 node build.mjs) swaps in task-link-setup.stub.js for states the sandbox
// can't produce; evidence made that way is labeled -stub.
import { transport } from './task-link-setup.transport.js'

/** task_links { status, reason, mode } from the delegation read (useDelegation's), or null. */
export { useTaskLinks } from './task-link-setup.transport.js'

export const getLinkSetup = scope => transport(scope, '/task-links/setup')

/** { address } → { status: ok | not_https | loopback | has_path | unreachable | other_server | no_signin | password_on_public | restart_needed, signin } */
export const checkLinkAddress = (scope, address) => transport(scope, '/task-links/setup/check', { method: 'POST', body: { address } })

/** { mode: 'tailscale', expected } or { mode: 'own', address } → { status, address, backup, reason } */
export const applyLinkSetup = (scope, body) => transport(scope, '/task-links/setup/apply', { method: 'POST', body })

/** Only on this Mac: writes plugin state only → { status: 'local' } */
export const chooseLocalLinks = scope => transport(scope, '/task-links/setup/local', { method: 'POST', body: {} })
