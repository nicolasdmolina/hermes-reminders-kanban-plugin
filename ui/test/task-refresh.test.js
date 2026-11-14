import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'

import { useTaskLink } from '../src/task-link/useTaskLink.js'

test('Stop, Run again and Accept refresh the mounted conversation without waiting for a poll', async () => {
  const dom = new JSDOM('<div id="root"></div>')
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.getElementById('root'))
  const dest = { owner: 'owner', link: 'link', profile: 'default' }
  const requests = []
  const api = { get: () => new Promise(resolve => requests.push(resolve)) }
  let current
  function Conversation({ row }) {
    current = useTaskLink(dest, api, undefined, row)
    return createElement('span', null, current.load.view?.state ?? 'loading')
  }
  const render = row => act(async () => root.render(createElement(Conversation, { row })))
  const answer = (index, state, task = 't_1') => act(async () => requests[index]({
    status: 'resolved', binding: { task, profile: 'default' }, state,
    actions: [], comments: [], attempts: [], occurrence_ids: [],
    current_occurrence_id: 'occ-1', selected_occurrence_id: 'occ-1'
  }))
  try {
    const running = { task_id: 't_1', status: 'active', accepted: false }
    await render(running)
    await answer(0, 'active')
    await render({ ...running })
    assert.equal(requests.length, 1, 'equivalent board snapshots do not refetch')

    let oldRead
    await act(async () => { oldRead = current.refresh({ quiet: true }) })
    await render({ ...running, status: 'stopped' })
    assert.equal(requests.length, 3, 'Stop supersedes the unfinished running-state read immediately')
    await answer(2, 'stopped')
    await answer(1, 'active')
    await oldRead
    assert.equal(document.querySelector('span').textContent, 'stopped', 'late pre-Stop data cannot restore Working')

    await render({ task_id: 't_2', status: 'ready', accepted: false })
    assert.equal(requests.length, 4, 'Run again resolves the new task behind the stable link immediately')
    await answer(3, 'ready', 't_2')
    assert.equal(current.load.view.taskId, 't_2')
    assert.equal(document.querySelector('span').textContent, 'ready')

    await render({ task_id: 't_2', status: 'done', accepted: true })
    assert.equal(requests.length, 5, 'Accept refreshes the completed state immediately')
    await answer(4, 'done', 't_2')
    assert.equal(document.querySelector('span').textContent, 'done')

    // The conversation's own Accept action also refreshes before its board row changes.
    let poll, accepted
    await act(async () => { poll = current.refresh({ quiet: true }) })
    await act(async () => { accepted = current.refresh() })
    assert.equal(requests.length, 7, 'an action refresh is not swallowed by a pending poll')
    await answer(6, 'done', 't_2')
    await answer(5, 'active', 't_2')
    await Promise.all([poll, accepted])
    assert.equal(document.querySelector('span').textContent, 'done')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    delete globalThis.window
    delete globalThis.document
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
  }
})
