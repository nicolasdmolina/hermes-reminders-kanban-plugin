// Focus through card remounts (ticket 28B): a card that moves column remounts, so a rollback or a
// board read that moves the focused card must queue focus for its new element.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'

import { createMotion } from '../src/editor/motion.js'

// The smallest DOM motion.js touches: cards found by id, focus, and no animation (reduced motion).
function fakeCard(id) {
  const el = {
    dataset: { cardId: id, rkCard: '' },
    focused: 0,
    contains: node => node === el,
    focus() {
      el.focused += 1
      globalThis.document.activeElement = el
    },
    scrollIntoView() {},
    closest: () => null,
    offsetTop: 0
  }
  return el
}

let cards
beforeEach(() => {
  cards = new Map()
  globalThis.CSS = { escape: value => value }
  globalThis.window = { matchMedia: () => ({ matches: true }) }
  globalThis.document = {
    activeElement: null,
    querySelector: selector => cards.get(/data-card-id="([^"]+)"/.exec(selector)?.[1]) ?? null,
    querySelectorAll: () => [...cards.values()]
  }
})
afterEach(() => {
  delete globalThis.CSS
  delete globalThis.window
  delete globalThis.document
})

test('keepFocus: a focused card that remounts gets focus back after the next render', () => {
  const motion = createMotion()
  const before = fakeCard('a')
  cards.set('a', before)
  before.focus()
  motion.keepFocus('a')
  // The rollback renders the card in its old column: a new element replaces the focused one.
  const after = fakeCard('a')
  cards.set('a', after)
  globalThis.document.activeElement = null
  motion.flush()
  assert.equal(after.focused, 1)
  assert.equal(globalThis.document.activeElement, after)
})

test('keepFocus: a card that did not have focus does not take it', () => {
  const motion = createMotion()
  const other = fakeCard('b')
  cards.set('a', fakeCard('a'))
  cards.set('b', other)
  other.focus()
  motion.keepFocus('a')
  const after = fakeCard('a')
  cards.set('a', after)
  motion.flush()
  assert.equal(after.focused, 0)
  assert.equal(globalThis.document.activeElement, other)
})
