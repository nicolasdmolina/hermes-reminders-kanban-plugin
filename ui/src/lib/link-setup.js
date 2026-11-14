// Task-link setup as data the panel and the pickup rows render. Pure: no host imports.
// Contract: ~/hermes-reminders-kanban-evidence/link-setup/BUILD.md (wins) and design/PROPOSAL.md.
// Routes: GET /task-links/setup, POST /task-links/setup/{check,apply,local,undo}; GET /delegation
// carries task_links { status, reason, mode }.

export const MODES = [
  { id: 'tailscale', label: 'Tailscale' },
  { id: 'own', label: 'My own URL' },
  { id: 'local', label: 'Only on this Mac' }
]

export const TAILSCALE_LINKS = {
  download: 'https://tailscale.com/download',
  app: '/Applications/Tailscale.app',
  https: 'https://login.tailscale.com/admin/dns'
}

/** Tailscale's state as one row: { text, tone, fix } where fix names the button that helps. */
export const TAILSCALE_STATE = {
  ready: { text: 'Connected', tone: 'ok', fix: null },
  not_installed: { text: 'Not on this Mac', tone: 'bad', fix: { label: 'Get Tailscale', open: TAILSCALE_LINKS.download } },
  signed_out: { text: 'Signed out', tone: 'bad', fix: { label: 'Open Tailscale', open: TAILSCALE_LINKS.app } },
  https_off: { text: 'HTTPS off', tone: 'bad', fix: { label: 'Turn on HTTPS', open: TAILSCALE_LINKS.https } },
  unknown: { text: "Couldn't check", tone: 'bad', fix: null }
}

// What the phone is asked for when a link opens: Hermes' own sign-in page, which carries its maker's
// (Nous Research) name whichever way it signs you in.
export const SIGNIN = { password: 'Hermes username and password', nous: 'Nous account', oidc: 'Single sign-on' }

const ORIGIN = {
  not_https: 'Use an https:// address.',
  loopback: 'Use an address your phone can reach, not this Mac’s own.',
  has_path: 'Use just the address, with nothing after the host name.',
  has_credentials: 'Leave the user name and password out of the address.'
}

/** One plain line for a check or apply answer that didn't succeed, or null. */
const PROBLEMS = {
  ...ORIGIN,
  unreachable: "Couldn't reach Hermes at that address.",
  other_server: 'That address opens a different server.',
  no_signin: 'Anyone with the address could open your tasks. Add a dashboard password or Nous sign-in first.',
  password_on_public: 'Password sign-in is only for private networks. Use Tailscale, or Nous sign-in.',
  no_dashboard: 'Your phone opens tasks through the Hermes dashboard. Start it on this Mac, then check again.',
  env_override: 'The address is set outside Hermes settings on this Mac, so it can’t be changed here.',
  stale: 'Tailscale changed since this opened. Check again.',
  funnel_on: 'Tailscale Funnel is on for that address, which makes it public. Turn Funnel off, then try again.',
  changed_since: 'The address was changed since it was saved here, so it was left as it is.',
  unavailable: "Couldn't read task-link setup. Try again."
}

export const problemFor = status => (status && status !== 'ok' && status !== 'ready' ? PROBLEMS[status] ?? PROBLEMS.unavailable : null)

/** Why a saved address can't be used (GET status `invalid`), in plain words. */
export const invalidText = reason => `The saved address can’t be used. ${ORIGIN[reason] ?? ((reason !== 'unavailable' && PROBLEMS[reason]) || null) ?? 'Enter a new one.'}`

export const hostOf = address => (typeof address === 'string' ? address.replace(/^https:\/\//, '').replace(/\/+$/, '') : '')

/**
 * The Agent pickup switch waits for task links: { ready, local, known }. ready when links are ready or the
 * person chose Only on this Mac. An older backend sends no task_links: the button stays on and the
 * activate refusal says why (delegation-outcomes.js).
 */
export function linksGate(taskLinks) {
  if (!taskLinks || typeof taskLinks.status !== 'string') return { ready: true, local: false, known: false }
  const local = taskLinks.status === 'local'
  return { ready: local || taskLinks.status === 'ready', local, known: true }
}

/**
 * The Task links row (review step and the Pickup popover): { text, host, action } where action is
 * the button label ('Set up' or 'Set up phone access') or null. address: GET /task-links/setup's,
 * when read (the delegation read has no address).
 */
export function linksFact(taskLinks, address = null) {
  if (!taskLinks?.status) return null
  switch (taskLinks.status) {
    case 'ready':
      // Ready on this Mac says nothing about the phone: the way back into setup stays on offer.
      return { text: address ? null : 'Ready', host: address ? hostOf(address) : null, action: 'Change' }
    case 'local':
      return { text: 'This Mac only', host: null, action: 'Set up phone access' }
    case 'restart_needed':
      return { text: 'Restart needed', host: null, action: 'Set up' }
    default:
      return { text: 'Not set up', host: null, action: 'Set up' }
  }
}

/** Why the Tailscale and My own URL panes can't go on yet: 'dashboard', 'signin', 'env' or null. */
export function blockedBy(setup) {
  if (!setup?.dashboard) return null
  if (setup.can_write === false) return 'env'
  if (!setup.dashboard.running) return 'dashboard'
  if (!setup.dashboard.signin) return 'signin'
  return null
}

/**
 * The apply call that continues a saved setup (Check again after Restart needed), or null.
 * Tailscale when the saved address is the one Tailscale serves; otherwise My own URL.
 */
export function continueBody(setup) {
  const address = setup?.address
  if (!address) return null
  const ts = setup.tailscale
  if (ts?.state === 'ready' && ts.address === address) return { mode: 'tailscale', expected: address }
  return { mode: 'own', address }
}

/**
 * The saved address the panel shows as Restart needed, or null. pending: the setup read says
 * restart_needed, or this panel's apply answered so (local mode keeps reading `local`). Choosing a
 * tab (`editing`) leaves it, so an address that never comes up (unreachable) can be replaced.
 */
export function savedAddress(setup, saved, { mode, editing }) {
  if (editing || mode === 'local' || setup?.status === 'ready') return null
  return (setup?.status === 'restart_needed' ? setup.address : saved) || null
}

/** A just-typed address the Check button can send: trimmed, non-empty. */
export const draftAddress = text => String(text ?? '').trim()
