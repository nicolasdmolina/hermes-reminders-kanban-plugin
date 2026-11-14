// The board's View settings for one connection and profile, and the /view answer for the
// cards on screen. The query runs on the server's cards (not the optimistic ones) and is
// keyed by the board read, so a drag or an edit never re-queries; the previous answer stays
// on screen while a new one loads, which keeps cards, focus and drag targets where they are.
import { useQuery } from '@hermes/plugin-sdk'
import { useMemo, useRef, useState } from 'react'

import { isRouted, queryKey } from '../api/client.js'
import { postView } from '../api/views.js'
import { selectedListNames } from '../lib/cards.js'
import { arrangeBoard, DEFAULT_VIEW, filteredEmpty, isCustomized, normalizeLists, viewRequest } from '../lib/views.js'

// Remembered for the session, per connection and profile, so leaving the page keeps the
// view. There is no saved-view management (spec, "View controls and sorting").
const remembered = new Map()

export function useBoardView({ scope, envelope, cards, updatedAt }) {
  const key = scope.join('\u0000')
  const integrated = envelope?.setup?.selected_list_ids ?? []
  const [stored, setStored] = useState(() => remembered.get(key) ?? DEFAULT_VIEW)
  const view = { ...stored, listIds: normalizeLists(stored.listIds, integrated) }

  const setView = update =>
    setStored(current => {
      const next = typeof update === 'function' ? update(current) : update
      remembered.set(key, next)
      return next
    })

  const serverCards = envelope?.cards
  const query = useQuery({
    queryKey: queryKey(scope, 'view', updatedAt, view.owner, view.repeats, view.listIds, view.sort, view.done),
    queryFn: async () => ({
      response: await postView(scope, viewRequest(serverCards, view)),
      sent: serverCards.map(card => card.id)
    }),
    enabled: serverCards ? () => isRouted(scope) : false,
    placeholderData: previous => previous,
    retry: false,
    staleTime: Infinity,
    gcTime: 60_000
  })

  // A failed query keeps the last answer on screen rather than blanking the board.
  const last = useRef(null)
  if (query.data && !query.isPlaceholderData) last.current = query.data
  const result = query.data ?? last.current

  const arranged = useMemo(() => arrangeBoard(envelope?.columns, cards, result), [envelope?.columns, cards, result])
  const names = selectedListNames(envelope)

  return {
    view,
    setView,
    arranged,
    customized: isCustomized(view),
    empty: filteredEmpty(view, arranged, cards),
    lists: integrated.map((id, index) => ({ id, title: names[index] })),
    failed: query.isError && query.error?.name !== 'SupersededError',
    pending: query.isFetching,
    retry: () => query.refetch()
  }
}
