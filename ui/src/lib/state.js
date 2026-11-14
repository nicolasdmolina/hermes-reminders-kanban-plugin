import { ACCESS } from './access.js'
// Turns backend envelopes and request failures into one screen to show.
// Pure: no host imports. Contract: reminders_kanban/api/preview-contract.md.

/** Raised when a response arrives after the user switched connection or profile. */
export class SupersededError extends Error {
  constructor() {
    super('Response belongs to a previous Hermes connection')
    this.name = 'SupersededError'
  }
}

/** Maps a failed ctx.rest call to a recovery kind.
 *  The host reports HTTP failures as "<status>: <body>" messages. */
export function classifyError(error) {
  if (error instanceof SupersededError || error?.name === 'SupersededError') return { kind: 'superseded' }
  const message = String(error?.message ?? error ?? '')
  const status = Number(error?.statusCode) || Number(/^(\d{3}):/.exec(message)?.[1]) || null
  if (status === 401 || status === 403) return { kind: 'auth', status }
  if (status === 404 || /got HTML|endpoint is likely missing/i.test(message)) return { kind: 'backend_missing', status }
  if (status === 422) return { kind: 'bad_request', status }
  // Transport failures, timeouts and 5xx all mean the owning host is not answering.
  return { kind: 'unavailable_host', status }
}

const hasCards = envelope => Boolean(envelope?.cards?.length) || Boolean(envelope?.observed_at)
const hasSelection = envelope => (envelope?.setup?.selected_list_ids?.length ?? 0) > 0 || envelope?.setup?.stage !== 'select_lists'

/**
 * Decides what the page shows.
 *
 * input.setup / input.preview: latest envelopes (either may be undefined).
 * input.setupError / input.previewError: classified request failures.
 * input.previewPending: a /preview read is in flight.
 * input.reviewing: the user just chose lists in this session and has not opened the board.
 * input.choosing: the user asked to change lists.
 */
export function deriveView(input) {
  const { setup, preview, setupError, previewError, previewPending, reviewing, choosing } = input
  const envelope = preview ?? setup
  const requestError = previewError ?? (preview ? null : setupError)

  if (requestError && requestError.kind !== 'superseded') {
    // Keep the last observation from this connection visible, marked as not current.
    if (envelope && hasCards(envelope) && hasSelection(envelope)) {
      return { screen: 'board', envelope, notice: { kind: requestError.kind } }
    }
    return { screen: 'problem', envelope, problem: { kind: requestError.kind } }
  }

  if (!envelope || envelope.status === 'loading') {
    return { screen: 'onboarding', step: 'connect', envelope, checking: true }
  }

  const helperStatus = helperRecovery(envelope)
  if (helperStatus) return { screen: 'onboarding', step: 'connect', envelope, helperStatus }
  if (choosing && envelope.status === 'access_denied') return { screen: 'onboarding', step: 'connect', envelope, denied: true }

  if (choosing && envelope.lists?.length >= 0 && envelope.status !== 'unavailable_host') {
    return { screen: 'onboarding', step: 'lists', envelope, revising: hasSelection(envelope) }
  }

  const code = envelope.error?.code ?? null
  switch (envelope.status) {
    case 'select_lists':
      return { screen: 'onboarding', step: 'lists', envelope }
    case 'ready':
    case 'empty_list':
      if (reviewing) return { screen: 'onboarding', step: 'review', envelope }
      return { screen: 'board', envelope, notice: null }
    case 'stale':
      // GET /setup paints saved work while /preview checks the source.
      if (!preview) return { screen: 'board', envelope, notice: previewPending ? { kind: 'checking' } : null }
      return { screen: 'board', envelope, notice: { kind: code === 'list_unavailable' ? 'list_unavailable' : 'refresh_failed', code } }
    case 'access_denied':
      if (!hasSelection(envelope)) return { screen: 'onboarding', step: 'connect', envelope, denied: true }
      if (hasCards(envelope)) return { screen: 'board', envelope, notice: { kind: 'access_denied' } }
      return { screen: 'problem', envelope, problem: { kind: 'access_denied' } }
    case 'unavailable_host':
      if (hasCards(envelope)) return { screen: 'board', envelope, notice: { kind: 'unavailable_host' } }
      return { screen: 'problem', envelope, problem: { kind: 'unavailable_host' } }
    case 'read_failure':
      return { screen: 'problem', envelope, problem: { kind: code === 'list_unavailable' ? 'list_unavailable' : 'read_failure', code } }
    case 'persistence_failed':
      return { screen: 'problem', envelope, problem: { kind: 'persistence_failed' } }
    default:
      return { screen: 'problem', envelope, problem: { kind: 'read_failure', code: envelope.status } }
  }
}

const HELPER_RECOVERY = new Set(['signing_required', 'toolchain_required', 'session_locked', 'setup_failed', 'unsupported_platform'])

export function helperRecovery(envelope) {
  const code = envelope?.error?.code ?? envelope?.status
  return HELPER_RECOVERY.has(code) ? code : null
}

/** Copy for every recoverable condition. Titles name the problem; actions name the recovery. */
export const PROBLEMS = {
  unavailable_host: {
    title: "Can't reach Hermes",
    body: 'The Mac running this Hermes profile is not answering. Your list choices are kept.',
    action: 'Try again'
  },
  auth: {
    title: 'Sign in to Hermes again',
    body: 'This connection needs you to sign in before it can read your board.',
    action: 'Try again'
  },
  backend_missing: {
    title: 'Reminders Kanban is off for this profile',
    body: 'Turn on the Reminders Kanban plugin for this Hermes profile, then restart Hermes.',
    action: 'Try again'
  },
  bad_request: {
    title: "Hermes didn't accept that selection",
    body: 'Choose your lists again.',
    action: 'Choose lists'
  },
  access_denied: {
    title: ACCESS.title,
    body: ACCESS.body,
    action: 'Check again'
  },
  read_failure: {
    title: "Couldn't read your reminders",
    body: 'Nothing was changed.',
    action: 'Try again'
  },
  list_unavailable: {
    title: 'A selected list is gone',
    body: 'It was deleted or is no longer shared with this Mac. Choose your lists again.',
    action: 'Choose lists'
  },
  persistence_failed: {
    title: "Couldn't save your setup",
    body: "Hermes couldn't write this board's settings, so your list choice wasn't saved.",
    action: 'Try again'
  }
}

/** One-line notices shown above a board that still has the last good read. */
export const NOTICES = {
  checking: 'Checking Reminders…',
  refresh_failed: "Couldn't refresh. Showing reminders from {time}.",
  list_unavailable: 'A selected list is gone. Showing reminders from {time}.',
  access_denied: "Hermes can't read Reminders. Showing reminders from {time}.",
  unavailable_host: "Can't reach Hermes. Showing reminders from {time}.",
  auth: 'Sign in to Hermes again. Showing reminders from {time}.',
  backend_missing: 'Reminders Kanban is off for this profile. Showing reminders from {time}.',
  bad_request: "Hermes didn't accept that request. Showing reminders from {time}."
}
