// Focus that fell to the page when the control holding it went away (a notice answered, a
// screen swapped out) goes to the first control still there, instead of staying lost.

/** Focuses the first enabled match (an element or a selector) when nothing has focus; true if it moved. */
export function refocus(doc, targets) {
  const active = doc.activeElement
  if (active && active !== doc.body && active.isConnected) return false
  for (const entry of targets) {
    const target = typeof entry === 'string' ? doc.querySelector(entry) : entry
    if (target?.isConnected && !target.disabled) {
      target.focus({ preventScroll: true })
      if (doc.activeElement === target) return true
    }
  }
  return false
}

// A board notice's own next step while it is there (Check again, Try again), then the header's
// Refresh, then the lists button, then the first card.
export const BOARD_FOCUS = [
  '.rk-page .rk-notice-actions button:last-child',
  '.rk-page button[aria-label="Refresh"]',
  '.rk-page .rk-lists-trigger',
  '.rk-page .rk-card'
]

/**
 * Whether a closing dialog should hand focus back: only while focus is still inside it or lost.
 * Radix can report the close late (after a later render), when a control focused since must keep it.
 */
export function focusLeftBehind(event, doc) {
  const active = doc.activeElement
  return !active || active === doc.body || !active.isConnected || Boolean(event.target?.contains?.(active))
}
