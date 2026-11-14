import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readThroughActivation } from '../src/lib/reads.js'
import { SupersededError } from '../src/lib/state.js'

test('the first good read after startup is kept when only the activation epoch moved', async () => {
  // The first answer arrives after the epoch bump that every startup makes: request() drops it.
  let calls = 0
  const read = async () => {
    calls += 1
    if (calls === 1) throw new SupersededError()
    return { status: 'ok', pickup_enabled: true }
  }
  assert.deepEqual(await readThroughActivation(read, () => true), { status: 'ok', pickup_enabled: true })
  assert.equal(calls, 2)
})

test('a read for a connection that is no longer routed stays dropped', async () => {
  let calls = 0
  const read = async () => {
    calls += 1
    throw new SupersededError()
  }
  await assert.rejects(readThroughActivation(read, () => false), { name: 'SupersededError' })
  assert.equal(calls, 1)
  // And it gives up after a few tries instead of looping.
  await assert.rejects(readThroughActivation(read, () => true, 3), { name: 'SupersededError' })
  assert.equal(calls, 4)
})

test('other failures are not repeated', async () => {
  let calls = 0
  await assert.rejects(
    readThroughActivation(async () => {
      calls += 1
      throw new Error('503: down')
    }, () => true),
    /503/
  )
  assert.equal(calls, 1)
})

test('a slow read asked for many times runs once, plus one more for everything asked meanwhile', async () => {
  const { oneAtATime } = await import('../src/lib/reads.js')
  const gates = []
  let started = 0
  const read = oneAtATime(() => new Promise((resolve, reject) => gates.push({ resolve, reject, n: ++started })))
  const first = read(['a'])
  const second = read(['a'])
  const third = read(['a'])
  await Promise.resolve()
  assert.equal(started, 1)
  assert.equal(second, third)
  // Another key has its own lane.
  const other = read(['b'])
  await Promise.resolve()
  assert.equal(started, 2)
  gates[0].resolve('one')
  assert.equal(await first, 'one')
  await new Promise(r => setTimeout(r))
  // The follow-up started only after the first ended: it saw everything asked before it.
  assert.equal(started, 3)
  gates[2].resolve('two')
  assert.equal(await second, 'two')
  // A failed read does not block the follow-up, and a later ask starts fresh.
  const again = read(['a'])
  const after = read(['a'])
  await Promise.resolve()
  gates[3].reject(new Error('down'))
  await assert.rejects(again, /down/)
  await new Promise(r => setTimeout(r))
  gates[4].resolve('three')
  assert.equal(await after, 'three')
  gates[1].resolve('b')
  assert.equal(await other, 'b')
  assert.equal(started, 5)
})
