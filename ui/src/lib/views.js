// The board's View: which cards show and their order inside each column. The backend
// query decides both (POST /view, reminders_kanban/workflow/views.md); this file only
// builds the request and lays its answer over the cards the editor is drawing.
// Pure: no host imports, so node --test exercises it directly. Contract: ui/src/views/README.md.
import { groupCards } from './cards.js'

export const OWNERS = [
  { id: 'all', label: 'All' },
  { id: 'human', label: 'You' },
  { id: 'agent', label: 'Agent' }
]

export const REPEATS = [
  { id: 'all', label: 'All' },
  { id: 'recurring', label: 'Repeating' },
  { id: 'one_off', label: 'One-off' }
]

export const SORTS = [
  { id: 'default', label: 'Default' },
  { id: 'due', label: 'Due date' },
  { id: 'priority', label: 'Priority' },
  { id: 'created', label: 'Created' },
  { id: 'title', label: 'Title' }
]

/** All integrated work, each column in its own order, Done limited to the last 7 days. */
export const DEFAULT_VIEW = Object.freeze({ owner: 'all', repeats: 'all', listIds: null, sort: 'default', done: 'recent' })

/**
 * Keeps a list selection inside the integrated lists. Every integrated list selected is the
 * same as no list filter (null), so a later integration change does not silently narrow it.
 */
export function normalizeLists(listIds, integrated) {
  if (listIds == null) return null
  const known = new Set(integrated ?? [])
  const kept = [...new Set(listIds)].filter(id => known.has(id))
  return kept.length === known.size ? null : kept
}

/** Toggles one list in the View's list filter. */
export function toggleList(listIds, id, integrated) {
  const current = listIds ?? integrated ?? []
  const next = current.includes(id) ? current.filter(other => other !== id) : [...current, id]
  return normalizeLists(next, integrated)
}

/** True when any filter or the sort differs from the default. Done's window is its own toggle. */
export const isCustomized = view =>
  view.owner !== 'all' || view.repeats !== 'all' || view.listIds != null || view.sort !== 'default'

/** Back to the default filters and sort, keeping the Done window choice. */
export const resetView = view => ({ ...DEFAULT_VIEW, done: view.done })

/** The POST /view body for these cards and settings. */
export function viewRequest(cards, view) {
  return {
    // The view route sorts and filters on the card's own fields. What the board attached for its
    // own display (the agent state, and a repeating series' whole history on every past occurrence)
    // is left out: sent whole, a year of a daily series made this request tens of megabytes.
    // A past occurrence Hermes ran is a completed copy with no repeat of its own (Apple strips it):
    // it still belongs with its repeating reminder under the Repeats filter.
    cards: (cards ?? []).map(({ occurrence, agent, linkCopy, ...card }) => (occurrence?.role === 'history' ? { ...card, recurring: true } : card)),
    owner: view.owner,
    repeats: view.repeats,
    list_ids: view.listIds,
    sort: view.sort,
    done: view.done
  }
}

/** Applies the response's `attention.reveal` query: widens only what hid Needs you cards. */
export function applyReveal(view, reveal) {
  if (!reveal) return view
  return { ...view, owner: reveal.owner, repeats: reveal.repeats, listIds: reveal.list_ids ?? null, sort: reveal.sort }
}

/**
 * Lays a view answer over the cards on screen.
 *
 * `cards` are the editor's cards (server cards with optimistic moves applied), so a card
 * keeps the column the user just gave it. `result` is `{ response, sent }`: the /view answer
 * and the ids it was asked about. A card the answer kept is shown in the answer's order; a
 * card it never saw (just created, not yet re-queried) is shown at the end of its column; a
 * card it filtered out is hidden. Counts follow what is on screen, so they stay true while a
 * move is in flight.
 */
export function arrangeBoard(columns, cards, result) {
  if (!result?.response) return null
  const { response, sent } = result
  const rank = new Map(response.order.map((id, index) => [id, index]))
  const asked = new Set(sent)
  const shown = (cards ?? []).filter(card => rank.has(card.id) || !asked.has(card.id))
  const byRank = (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity)
  const groups = groupCards(columns, shown).map(group => ({ ...group, cards: [...group.cards].sort(byRank) }))
  const count = name => groups.find(group => group.name === name)?.cards.length ?? 0
  const hidden = response.attention?.hidden ?? []
  const doneHidden = response.done?.hidden ?? 0
  return {
    groups,
    shown: shown.length,
    done: { total: count('Done') + doneHidden, hidden: doneHidden, all: response.done?.window?.mode === 'all' },
    // The unfiltered count: what is on screen plus what the filters hid.
    needsYou: { total: count('Needs you') + hidden.length, hidden: hidden.length, reveal: response.attention?.reveal ?? null }
  }
}

/** Filters hide everything, and the Done window is not the reason. */
export const filteredEmpty = (view, arranged, cards) =>
  Boolean(arranged) && isCustomized(view) && (cards?.length ?? 0) > 0 && arranged.shown === 0 && arranged.done.hidden === 0
