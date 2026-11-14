import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { allState, LIST_LIMIT, offersAll, toggleAll } from '../src/lib/selection.js'

const LISTS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

test('All is checked, mixed or clear from the chosen lists', () => {
  assert.equal(allState(LISTS, new Set()), false)
  assert.equal(allState(LISTS, new Set(['b'])), 'indeterminate')
  assert.equal(allState(LISTS, new Set(['a', 'b', 'c'])), true)
  // A saved id for a list Reminders no longer has doesn't count toward All.
  assert.equal(allState(LISTS, new Set(['a', 'b', 'gone'])), 'indeterminate')
  assert.equal(allState([], new Set()), false)
})

test('clicking All chooses every list from none or some, and clears from all', () => {
  assert.deepEqual([...toggleAll(LISTS, new Set())], ['a', 'b', 'c'])
  assert.deepEqual([...toggleAll(LISTS, new Set(['c']))], ['a', 'b', 'c'])
  assert.deepEqual([...toggleAll(LISTS, new Set(['a', 'b', 'c']))], [])
})

test('All is offered for two lists up to the save limit, never past it', () => {
  const lists = n => Array.from({ length: n }, (_, i) => ({ id: String(i) }))
  assert.equal(offersAll(lists(1)), false)
  assert.equal(offersAll(lists(2)), true)
  assert.equal(offersAll(lists(LIST_LIMIT)), true)
  assert.equal(offersAll(lists(LIST_LIMIT + 1)), false)
})

test('the limit matches the backend preview route', () => {
  const route = readFileSync(new URL('../../reminders_kanban/api/preview.py', import.meta.url), 'utf8')
  assert.match(route, new RegExp(`selected_list_ids: .*max_length=${LIST_LIMIT}\\)`))
})
