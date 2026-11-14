// A reminder another Mac's Hermes is working on (docs/adr/003-two-macs.md). Pure: no host imports.
//
// Two Macs see the same reminders through iCloud, each with its own Hermes. The board's own read
// says which reminders the other Mac has (`card.elsewhere: { mac, url }`, human-contract.md): this
// Mac shows them, never moves or edits them, and can take one over.

import { rerunToConfirm } from './delegation-outcomes.js'
import { claims } from './task-link.js'

/** The other Mac's claim on an open reminder, or null. A completed reminder is just done. */
export const elsewhereOf = card => (card?.elsewhere?.mac && !card.source?.completed ? card.elsewhere : null)

// Rows this Mac is finished with: they never outrank what the board says about the other Mac.
const OVER = new Set(['done', 'stopped', 'deleted'])

/**
 * Where a card's reminder is, given this Mac's own row for it: the other Mac's claim, or null.
 * - This Mac's live task wins over a board read from before it existed (a Take over that just
 *   went through: the board still says the other Mac has it for a moment).
 * - A row this Mac let go of (`released`: taken over, or it yielded) reads as the other Mac's at
 *   once, from the row, until the board has had time to reread (RELEASE_LAG_MS): never a
 *   "Stopped" card with a working Mark done in between. After that only the board says whose it
 *   is, so a line left in the notes can't keep the other Mac's name on the card.
 */
export const RELEASE_LAG_MS = 120_000

export function elsewhereFor(card, row = null, now = Date.now()) {
  if (!card || card.source?.completed) return null
  if (row && !row.released && !OVER.has(row.status)) return null
  const where = elsewhereOf(card)
  if (where) return where
  // (`mine`: a board read from just before the other Mac's line arrived. No claim at all: the
  // other Mac let go too, and this is this Mac's own stopped card again.)
  const since = now - Date.parse(row?.released?.at)
  if (row?.released?.mac && card.claim && since >= 0 && since < RELEASE_LAG_MS) return { mac: row.released.mac, url: row.released.url ?? null }
  return null
}

export const elsewhereLabel = mac => `On ${mac}`

/** Why a drag, a key move or a save is refused. */
export const elsewhereRefusal = mac => `Hermes on ${mac} has this`

/** The card's agent state: In progress, read-only, never a queue or a wait of this Mac's.
 *  prior: this Mac's own finished row for the reminder (it was taken over from here), if any. */
export function elsewhereAgent(card, prior = null) {
  const where = elsewhereOf(card)
  if (!where) return null
  return { status: 'elsewhere', column: 'In progress', label: elsewhereLabel(where.mac), tone: 'muted', action: null, waiting: false, queueIndex: null, nextCheckAt: null, row: null, prior: prior && !prior.scope ? prior : null }
}

/** A confirm that appears where the button just pressed was: a double-click's second click lands
 *  on it. It answers only once it has been on screen this long. */
export const CONFIRM_GUARD_MS = 400
export const confirmArmed = (shownAt, now = Date.now()) => now - shownAt >= CONFIRM_GUARD_MS

const webUrl = value => {
  try {
    return /^https?:$/.test(new URL(value).protocol) ? value : null
  } catch {
    return null
  }
}

/**
 * What the task dialog's footer offers for such a reminder, or null (the pill already says whose
 * it is): { mac, open: { label, url } | null, takeOver: { label, busy, refused }, ask: { text,
 * confirm, cancel }, choices, rerun }.
 * - open: only when the other Mac wrote a link ("Only on this Mac" has none).
 * - takeOver.refused: why it can't be taken over right now (pickup off or loading, an unsure save).
 * - choices: a repeating reminder then asks which occurrence, like Delegate: ['ready', 'every'].
 * - rerun: this Mac had started it before it was taken over: the run its consent binds to.
 */
export function elsewhereDialog(card, { pickup, unavailable = false, unsure = false } = {}) {
  const where = elsewhereOf(card)
  if (!where) return null
  const url = webUrl(where.url)
  const refused = unsure ? 'Check the last save first' : pickup == null ? 'Agent pickup is still loading' : !pickup ? (unavailable ? "Agent pickup isn't available" : 'Turn on agent pickup first') : null
  return {
    mac: where.mac,
    open: url ? { label: 'Open task', url } : null,
    takeOver: { label: 'Take over here', busy: 'Taking over…', refused },
    ask: { text: `Take over from ${where.mac}? Its work on this reminder stops.`, confirm: 'Take over', cancel: 'Cancel' },
    choices: card.recurring || card.source?.rules?.length ? ['ready', 'every'] : null,
    rerun: rerunToConfirm(card.agent?.prior) ?? null
  }
}

/**
 * A finished reminder that carries the other Mac's task link: { label, url } to open that task, or
 * null. Nothing to take over (it is done), and its task is not on this Mac to show.
 */
export function theirTaskLink(card) {
  if (!card?.source?.completed || card.claim !== 'foreign') return null
  const url = claims(card.source.notes).map(claim => webUrl(claim.url)).find(Boolean)
  return url ? { label: 'Open task', url } : null
}

/**
 * The request Take over sends: [route, body]. A one-off goes to /delegation/actions as
 * `take_over`; a repeating reminder sends its occurrence choice ('ready' or 'every') with
 * `take_over: true`. Always the card's own snapshot: the backend refuses it if Reminders moved on.
 */
export function takeOverRequest(card, choice = null) {
  if (choice === 'every') return ['/recurring/actions', { action: 'every', expected: card.source, take_over: true }]
  if (choice === 'ready') return ['/occurrences/actions', { action: 'ready', expected: card.source, take_over: true }]
  return ['/delegation/actions', { action: 'take_over', expected: card.source }]
}
