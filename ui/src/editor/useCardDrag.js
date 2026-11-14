// Pointer drag for board cards. A DOM ghost follows the pointer (so moves are
// visible and animatable, unlike the OS image of HTML5 drag and drop); lanes say
// whether they take the card; a refused drop arcs home and then shows its reason.
import { useRef, useState } from 'react'

import { cardElement, createGhost, placeGhost, snapBack } from './motion.js'

const THRESHOLD = 4
const EDGE = 56
const MAX_TILT = 3

const columnAt = (x, y) => document.elementFromPoint(x, y)?.closest?.('[data-rk-column]')?.dataset.rkColumn ?? null

/**
 * verdictFor(card, column) → null | { refused, reason } | { action }
 * onDrop(card, column, ghost) commits an allowed move and takes over the ghost.
 * onRefuse(card, verdict) shows why a drop was refused, after the card is home.
 */
export function useCardDrag({ verdictFor, onDrop, onRefuse }) {
  const [state, setState] = useState(null)
  const latest = useRef({})
  latest.current = { verdictFor, onDrop, onRefuse }

  const onPointerDown = (card, event) => {
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const el = event.currentTarget
    const board = el.closest('.rk-board')
    const start = { x: event.clientX, y: event.clientY }
    let drag = null
    let pointer = start
    let frame = 0
    let lastX = start.x
    let lastT = performance.now()

    const verdict = column => latest.current.verdictFor(card, column)
    const update = column => {
      if (drag.over === column) return
      drag.over = column
      drag.verdict = column ? verdict(column) : null
      setState({ cardId: card.id, over: column, verdict: drag.verdict })
    }

    // Lanes scroll sideways while the pointer rests near the board's edge.
    const autoScroll = () => {
      frame = requestAnimationFrame(autoScroll)
      if (!board) return
      const box = board.getBoundingClientRect()
      const speed = pointer.x < box.left + EDGE ? -1 : pointer.x > box.right - EDGE ? 1 : 0
      if (speed) {
        const depth = speed < 0 ? box.left + EDGE - pointer.x : pointer.x - (box.right - EDGE)
        board.scrollLeft += speed * Math.min(18, 4 + depth / 3)
        update(columnAt(pointer.x, pointer.y))
      }
    }

    const begin = () => {
      drag = { ghost: createGhost(el), over: undefined, verdict: null }
      document.documentElement.dataset.rkDragging = 'true'
      update(card.column)
      frame = requestAnimationFrame(autoScroll)
    }

    const move = moveEvent => {
      pointer = { x: moveEvent.clientX, y: moveEvent.clientY }
      if (!drag) {
        if (Math.hypot(pointer.x - start.x, pointer.y - start.y) < THRESHOLD) return
        begin()
      }
      moveEvent.preventDefault()
      // Tilt leans into horizontal speed and eases back when the pointer rests.
      const now = performance.now()
      const speed = (pointer.x - lastX) / Math.max(8, now - lastT)
      lastX = pointer.x
      lastT = now
      const tilt = drag.ghost.tilt * 0.7 + Math.max(-MAX_TILT, Math.min(MAX_TILT, speed * 2.2)) * 0.3
      placeGhost(drag.ghost, pointer.x - start.x, pointer.y - start.y, tilt)
      update(columnAt(pointer.x, pointer.y))
    }

    const cleanup = () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', cancel, true)
      window.removeEventListener('keydown', key, true)
      cancelAnimationFrame(frame)
      delete document.documentElement.dataset.rkDragging
    }

    // The release after a drag must not also open the card.
    const swallowClick = () => {
      const stop = clickEvent => {
        clickEvent.stopPropagation()
        clickEvent.preventDefault()
      }
      window.addEventListener('click', stop, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', stop, true), 0)
    }

    const finish = async (column, refuse) => {
      const { ghost } = drag
      const result = column ? verdict(column) : null
      if (result?.action) {
        setState(null)
        latest.current.onDrop(card, column, ghost)
        return
      }
      await snapBack(ghost, cardElement(card.id))
      setState(null)
      if (refuse && result?.refused) latest.current.onRefuse(card, result)
    }

    const up = upEvent => {
      cleanup()
      if (!drag) return
      swallowClick()
      void finish(columnAt(upEvent.clientX, upEvent.clientY), true)
    }
    const cancel = () => {
      cleanup()
      if (drag) void finish(null, false)
    }
    const key = keyEvent => {
      if (keyEvent.key !== 'Escape' || !drag) return
      keyEvent.preventDefault()
      keyEvent.stopPropagation()
      cancel()
    }

    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', cancel, true)
    window.addEventListener('keydown', key, true)
  }

  return { state, onPointerDown }
}
