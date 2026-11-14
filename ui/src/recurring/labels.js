// Dated names for a task's occurrences ("Nov 6 · Accepted"), for the conversation's occurrence
// picker on Desktop and in the browser. Only react and pure code: the browser bundle uses it too.
import { useEffect, useState } from 'react'

import { occurrenceLabels } from '../lib/occurrences.js'

/** Reads GET /occurrences once per task when it has earlier occurrences; {} until then or if
 *  the read fails (the picker keeps its plain names). */
export function useOccurrenceLabels(api, view, earlier = false) {
  const [labels, setLabels] = useState({})
  const wanted = Boolean(view && (view.historical || earlier || view.occurrences.length > 1))
  // Reread when an occurrence is added, chosen, or changes state (an accepted result).
  const ids = wanted ? [...view.occurrences.map(entry => entry.id), view.selectedOccurrence, view.state].join('|') : ''
  useEffect(() => {
    if (!ids) return undefined
    let live = true
    api
      .get('/occurrences')
      .then(answer => live && setLabels(occurrenceLabels(answer)))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [api, ids])
  return labels
}
