import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'

import { BOARD_FOCUS, focusLeftBehind, refocus } from '../src/lib/focus.js'

const page = notice => new JSDOM(`<body><div class="rk-page">
  <header><button class="rk-lists-trigger">Home, Work</button><button aria-label="Refresh">R</button></header>
  ${notice ? `<div class="rk-notice"><div class="rk-notice-actions"><button>Open Privacy Settings</button><button ${notice === 'checking' ? 'disabled' : ''}>Check again</button></div></div>` : ''}
  <div class="rk-card" tabindex="0">Prepare slides</div>
</div></body>`).window.document

test('after Check again, focus goes to what is on screen instead of the page', () => {
  // Access is back: the notice is gone, so the header's Refresh takes focus.
  let doc = page(null)
  assert.equal(doc.activeElement, doc.body)
  assert.equal(refocus(doc, BOARD_FOCUS), true)
  assert.equal(doc.activeElement.getAttribute('aria-label'), 'Refresh')

  // Still denied: back on the notice's own Check again, not Open Privacy Settings.
  doc = page('denied')
  refocus(doc, BOARD_FOCUS)
  assert.equal(doc.activeElement.textContent, 'Check again')

  // A disabled control is skipped.
  doc = page('checking')
  doc.querySelector('[aria-label="Refresh"]').disabled = true
  refocus(doc, BOARD_FOCUS)
  assert.equal(doc.activeElement.className, 'rk-lists-trigger')
})

test('the pressed button gets focus back once it is enabled again', () => {
  const doc = page(null)
  const refresh = doc.querySelector('[aria-label="Refresh"]')
  assert.equal(refresh.isConnected, true)
  refocus(doc, [refresh, ...BOARD_FOCUS])
  assert.equal(doc.activeElement, refresh)
  // One that went away is skipped for what is there now.
  const gone = doc.createElement('button')
  doc.body.focus()
  refresh.blur()
  refocus(doc, [gone, '.rk-page .rk-card'])
  assert.equal(doc.activeElement.className, 'rk-card')
})

test('focus someone already placed is left alone', () => {
  const doc = page('denied')
  const card = doc.querySelector('.rk-card')
  card.focus()
  assert.equal(refocus(doc, BOARD_FOCUS), false)
  assert.equal(doc.activeElement, card)
})

test('a dialog that reports its close late does not take focus from a control pressed since', () => {
  const doc = page('denied')
  const dialog = doc.createElement('div')
  dialog.innerHTML = '<button>Cancel</button>'
  doc.body.append(dialog)
  const cancel = dialog.querySelector('button')
  cancel.focus()
  assert.equal(focusLeftBehind({ target: dialog }, doc), true, 'focus still in the closing form')
  dialog.remove()
  assert.equal(focusLeftBehind({ target: dialog }, doc), true, 'focus went with it')
  const check = [...doc.querySelectorAll('button')].find(button => button.textContent === 'Check again')
  check.focus()
  assert.equal(focusLeftBehind({ target: dialog }, doc), false, 'Check again keeps it')
})
