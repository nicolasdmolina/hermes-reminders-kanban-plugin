import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'

import { useAcceptance } from '../src/task-link/useAcceptance.js'

test('acceptance is immediate, completion requires proof, and late replies stay with their task and connection', async () => {
  const dom = new JSDOM('<div id="root"></div>')
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.CustomEvent = dom.window.CustomEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.getElementById('root'))
  const posts = []
  let current, refreshed = 0
  const refresh = () => { refreshed++ }
  const api = {
    get: () => { throw new Error('known task must not require another lookup') },
    post: (...args) => new Promise((resolve, reject) => posts.push({ args, resolve, reject }))
  }
  function Conversation({ transport = api, taskId }) {
    current = useAcceptance(transport, refresh)
    const receipt = current.forTask(taskId)
    return createElement('span', null, receipt?.message ?? 'Review result')
  }
  const render = (taskId, transport) => act(async () => root.render(createElement(Conversation, { taskId, transport })))
  try {
    for (const [taskId, known, route] of [
      ['one-off', { task: { task_id: 'one-off', expected: { id: 'source' } } }, '/delegation/actions'],
      ['recurring', { occurrence: { key: 'occurrence', review: true }, occurrenceTaskId: 'recurring' }, '/occurrences/actions']
    ]) {
      await render(taskId)
      let completion
      await act(async () => { completion = current.accept(taskId, known); void current.accept(taskId, known) })
      assert.equal(document.querySelector('span').textContent, 'Accepted. Saving to Reminders…')
      assert.equal(posts.at(-1).args[0], route)
      assert.equal(posts.length, taskId === 'one-off' ? 1 : 2, 'duplicate clicks cannot submit twice')
      assert.equal(current.forTask(taskId).phase, 'saving', 'an unresolved native write cannot claim completion')
      await act(async () => {
        posts.at(-1).resolve({ status: 'ok', tasks: [{ task_id: taskId, status: 'done', completion: { status: 'completed' } }] })
        await completion
      })
      assert.equal(document.querySelector('span').textContent, 'Reminder checked off')
      assert.equal(current.forTask(taskId).phase, 'confirmed')
    }
    assert.equal(refreshed, 2)

    const known = { task: { task_id: 'failed', expected: { id: 'other-source' } } }
    await render('failed')
    let completion
    await act(async () => { completion = current.accept('failed', known) })
    await act(async () => {
      posts.at(-1).resolve({ status: 'ok', tasks: [{ task_id: 'failed', status: 'needs_reconciliation', accepted: true }] })
      await completion
    })
    assert.equal(current.forTask('failed').phase, 'failed')
    assert.match(document.querySelector('span').textContent, /isn't completed yet/)

    await act(async () => { completion = current.accept('failed', known) })
    await act(async () => { posts.at(-1).reject(new Error('connection lost')); await completion })
    assert.match(document.querySelector('span').textContent, /Couldn't confirm/)
    assert.equal(current.forTask('failed').phase, 'failed')

    await act(async () => { completion = current.accept('failed', known) })
    await render('failed', { ...api })
    await act(async () => {
      posts.at(-1).resolve({ status: 'ok', tasks: [{ task_id: 'failed', status: 'done', completion: { status: 'completed' } }] })
      await completion
    })
    assert.equal(document.querySelector('span').textContent, 'Review result', 'a previous connection cannot confirm this one')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    delete globalThis.window
    delete globalThis.document
    delete globalThis.CustomEvent
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
  }
})
