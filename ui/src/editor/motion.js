// Card motion for moves, drops and snap-backs: FLIP with Web Animations on transform
// only. Every path is instant under reduced motion.
//
// Timing chart (product UI register):
//   move      the moved card travels from its old slot to its new one in 180 ms
//             (standard easing); a floating copy flies so no column clips it
//   siblings  cards whose slot shifted slide into place over the same 180 ms
//   pickup    0 press → 140 lifted (scale 1.03, shadow); tilt follows pointer speed
//   drop      the drag ghost settles into the new slot in 180 ms
//   snap-back the ghost arcs home in 340 ms (lifts 14 px mid-way), then the reason shows

export const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)

export const cardElement = id => (id ? document.querySelector(`[data-rk-card][data-card-id="${CSS.escape(id)}"]`) : null)

const STANDARD = 'cubic-bezier(0.2, 0, 0, 1)'
const MOVE_MS = 180
const SETTLE = 'cubic-bezier(0.2, 0.9, 0.3, 1.04)'

// The element that occupies the card's place in its column (the card plus its reason).
const slotOf = el => el.closest('.rk-card-slot') ?? el
// Position inside the column's content box: unaffected by scrolling or running transforms.
const placeOf = el => {
  const slot = slotOf(el)
  return { column: el.closest('[data-rk-column]')?.dataset.rkColumn ?? null, top: slot.offsetTop, slot }
}

/**
 * A queue the Board flushes after each render. It remembers where every card sat after the
 * last render; on the next one, cards that changed place within their column slide there,
 * and cards that changed column travel as a floating copy captured before the change.
 */
export function createMotion() {
  let last = new Map()
  const travelers = new Map()
  let focusId = null

  return {
    /** Call before a change that moves this card to another column. */
    travel(id) {
      const el = cardElement(id)
      if (!el || reducedMotion() || travelers.has(id)) return
      travelers.set(id, createGhost(el, { lift: false }))
    },
    /** Fly an existing drag ghost into the card's new slot after the next render. */
    land(id, ghost) {
      travelers.get(id)?.remove()
      travelers.set(id, ghost)
    },
    /** Focus this card after the next render (it remounts when it changes column). */
    focus(id) {
      focusId = id
    },
    /** Keep focus on this card through a change that moves it (a rollback, a board read): it
     *  remounts in its new column, and the focus would otherwise fall to the page. */
    keepFocus(id) {
      const el = cardElement(id)
      if (el && el.contains(document.activeElement)) focusId = id
    },
    flush() {
      const reduce = reducedMotion()
      if (focusId) {
        const el = cardElement(focusId)
        if (el) {
          focusId = null
          el.focus({ preventScroll: true })
          el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }
      }
      const next = new Map()
      for (const el of document.querySelectorAll('[data-rk-card][data-card-id]')) {
        const id = el.dataset.cardId
        const place = placeOf(el)
        next.set(id, { column: place.column, top: place.top })
        const ghost = travelers.get(id)
        if (ghost) {
          travelers.delete(id)
          if (reduce) {
            ghost.remove()
            continue
          }
          // Opacity, not visibility: a hidden element loses keyboard focus.
          place.slot.style.opacity = '0'
          flyTo(ghost, el.getBoundingClientRect(), { duration: MOVE_MS, easing: ghost.lifted ? SETTLE : STANDARD }).then(() => {
            place.slot.style.opacity = ''
            ghost.remove()
          })
          continue
        }
        const before = last.get(id)
        if (reduce || !before || before.column !== place.column) continue
        const dy = before.top - place.top
        if (Math.abs(dy) < 1) continue
        place.slot.getAnimations().forEach(animation => animation.cancel())
        place.slot.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: MOVE_MS, easing: STANDARD })
      }
      last = next
      // A traveler whose card did not render (filtered, gone) has nowhere to land.
      for (const [id, ghost] of travelers) {
        if (!next.has(id)) {
          travelers.delete(id)
          ghost.remove()
        }
      }
    }
  }
}

// ── floating copies ─────────────────────────────────────────────────────────

/** A positioned copy of a card. The outer node moves; the inner copy carries the lift,
 *  so the two transforms never fight. */
export function createGhost(el, { lift = true } = {}) {
  const rect = el.getBoundingClientRect()
  const ghost = document.createElement('div')
  ghost.className = 'rk-ghost'
  ghost.setAttribute('aria-hidden', 'true')
  ghost.style.left = `${rect.left}px`
  ghost.style.top = `${rect.top}px`
  ghost.style.width = `${rect.width}px`
  const copy = el.cloneNode(true)
  copy.removeAttribute('data-card-id')
  copy.removeAttribute('data-rk-card')
  copy.removeAttribute('id')
  copy.tabIndex = -1
  copy.classList.add('rk-ghost-card')
  if (!lift) copy.dataset.flat = 'true'
  ghost.append(copy)
  ;(el.closest('.rk-page') ?? document.body).append(ghost)
  Object.assign(ghost, { origin: rect, x: 0, y: 0, tilt: 0, lifted: lift })
  if (lift && !reducedMotion()) {
    copy.animate(
      [
        { transform: 'scale(0.98)', boxShadow: '0 0 0 0 transparent' },
        { transform: 'scale(1.03)', boxShadow: 'var(--rk-lift-shadow)' }
      ],
      { duration: 140, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'forwards' }
    )
  }
  return ghost
}

export function placeGhost(ghost, x, y, tilt) {
  ghost.x = x
  ghost.y = y
  ghost.tilt = tilt
  ghost.style.transform = `translate(${x}px, ${y}px) rotate(${tilt}deg)`
}

function flyTo(ghost, rect, { duration, easing, arc = 0 }) {
  const x = rect.left - ghost.origin.left
  const y = rect.top - ghost.origin.top
  const from = `translate(${ghost.x}px, ${ghost.y}px) rotate(${ghost.tilt}deg)`
  const to = `translate(${x}px, ${y}px) rotate(0deg)`
  const frames = arc
    ? [
        { transform: from },
        { transform: `translate(${(ghost.x + x) / 2}px, ${(ghost.y + y) / 2 - arc}px) rotate(${ghost.tilt / 3}deg)`, offset: 0.45 },
        { transform: to }
      ]
    : [{ transform: from }, { transform: to }]
  if (ghost.lifted) {
    const copy = ghost.firstChild
    copy?.getAnimations().forEach(animation => animation.cancel())
    copy?.animate([{ transform: 'scale(1.03)' }, { transform: 'scale(1)' }], { duration, easing, fill: 'forwards' })
  }
  return ghost.animate(frames, { duration, easing, fill: 'forwards' }).finished.catch(() => {})
}

/** Sends a drag ghost home on a short arc, or removes it at once under reduced motion. */
export async function snapBack(ghost, el) {
  if (!reducedMotion() && el?.isConnected) {
    await flyTo(ghost, el.getBoundingClientRect(), { duration: 340, easing: SETTLE, arc: 14 })
  }
  ghost.remove()
}
