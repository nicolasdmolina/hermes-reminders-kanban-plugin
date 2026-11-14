import assert from 'node:assert/strict'
import { test } from 'node:test'

import { deactivationOutcome, keepsTicking, runActivation } from '../src/lib/delegation-outcomes.js'
import { choiceLabel, DEFAULT_CHOICE, EFFORTS, isDefault, menuCurrent, normalChoice, saveQueue, sameChoice } from '../src/lib/model-choice.js'

const SOL = { model: 'gpt-6.1-sol', provider: 'openai-codex', effort: 'high' }
const label = value => ({ high: 'High', none: 'Off' })[value] ?? value

test('the backend shape: nulls for the profile default, provider kept exactly', () => {
  assert.deepEqual(normalChoice(null), DEFAULT_CHOICE)
  assert.deepEqual(normalChoice({ model: '', provider: '', effort: '' }), DEFAULT_CHOICE)
  assert.deepEqual(normalChoice(SOL), SOL)
  assert.deepEqual(normalChoice({ model: 'm', provider: 'custom:rk-mc', effort: null }), { model: 'm', provider: 'custom:rk-mc', effort: null })
  // A model without its provider (or the reverse) is refused by the backend, so it falls back.
  assert.deepEqual(normalChoice({ model: 'm', provider: '', effort: 'low' }), { model: null, provider: null, effort: 'low' })
  assert.deepEqual(normalChoice({ model: '', provider: 'p' }), DEFAULT_CHOICE)
  assert.equal(normalChoice({ effort: 'turbo' }).effort, null)
  assert.equal(normalChoice({ effort: 'none' }).effort, 'none')
})

test('every Hermes effort is one the backend accepts', () => {
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) assert.ok(EFFORTS.has(effort), effort)
})

test('the trigger reads Profile default, the model, and the effort when one is set', () => {
  assert.equal(choiceLabel(DEFAULT_CHOICE, label), 'Profile default')
  assert.equal(choiceLabel(SOL, label), 'gpt-6.1-sol · High')
  assert.equal(choiceLabel({ ...SOL, effort: null }, label), 'gpt-6.1-sol')
  assert.equal(choiceLabel({ effort: 'none' }, label), 'Profile default · Off')
  assert.ok(isDefault(DEFAULT_CHOICE))
  assert.ok(!isDefault({ effort: 'none' }))
  assert.ok(sameChoice({ model: '', provider: '' }, DEFAULT_CHOICE))
  assert.ok(!sameChoice(SOL, { ...SOL, effort: 'low' }))
})

test("the catalog menu's current value uses '' for inherit", () => {
  assert.deepEqual(menuCurrent(DEFAULT_CHOICE), { effort: '', fast: false, model: '', provider: '' })
  assert.deepEqual(menuCurrent(SOL), { effort: 'high', fast: false, model: 'gpt-6.1-sol', provider: 'openai-codex' })
})

test('saves go out one at a time in order, and settled waits for the last', async () => {
  const sent = []
  const gates = []
  const queue = saveQueue(choice => {
    sent.push(choice.effort)
    return new Promise(resolve => gates.push(() => resolve({ ok: true, choice })))
  })
  assert.equal(await queue.settled(), null)
  const first = queue.save({ effort: 'low' })
  const second = queue.save({ effort: 'high' })
  assert.equal(queue.pending, 2)
  await Promise.resolve()
  assert.deepEqual(sent, ['low'])
  const waiting = queue.settled()
  gates.shift()()
  assert.equal((await first).choice.effort, 'low')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(sent, ['low', 'high'])
  gates.shift()()
  assert.equal((await second).choice.effort, 'high')
  assert.equal((await waiting).choice.effort, 'high')
  assert.equal(queue.pending, 0)
})

test('a failed or throwing save resolves to its problem and the queue keeps going', async () => {
  let calls = 0
  const queue = saveQueue(async () => {
    calls += 1
    if (calls === 1) throw new Error('boom')
    return { problem: "Couldn't reach Hermes. Try again." }
  })
  assert.deepEqual(await queue.save(SOL), { problem: 'boom' })
  assert.deepEqual(await queue.save(SOL), { problem: "Couldn't reach Hermes. Try again." })
  assert.equal((await queue.settled()).problem, "Couldn't reach Hermes. Try again.")
})

test('pickup off is ok only when the answer says pickup is off', () => {
  assert.deepEqual(deactivationOutcome({ status: 'ok', pickup_enabled: false }), { ok: true })
  assert.ok(deactivationOutcome({ status: 'ok', pickup_enabled: true }).problem)
  assert.ok(deactivationOutcome(null, { kind: 'unreachable' }).problem)
})

test('the switch turns off through the same steps, reading the off answer', async () => {
  const problems = []
  let settled = 0
  const outcome = await runActivation({
    post: async () => ({ status: 'ok', pickup_enabled: false }),
    read: deactivationOutcome,
    reread: async () => {},
    refreshBoard: () => {},
    classify: () => ({ kind: 'unreachable' }),
    onProblem: problem => problems.push(problem),
    onSettled: () => (settled += 1)
  })
  assert.deepEqual(outcome, { ok: true })
  assert.deepEqual(problems, [])
  assert.equal(settled, 1)
})

test('the owner tick keeps watching work already out after pickup goes off', () => {
  const rows = statuses => ({ tasks: statuses.map(status => ({ status })) })
  assert.ok(keepsTicking(true, rows([])))
  assert.ok(!keepsTicking(null, rows(['active'])))
  assert.ok(!keepsTicking(false, rows([])))
  assert.ok(!keepsTicking(false, rows(['done', 'stopped', 'deleted'])))
  for (const status of ['ready', 'active', 'question', 'result', 'paused', 'failed', 'needs_reconciliation']) {
    assert.ok(keepsTicking(false, rows(['done', status])), status)
  }
})

test('the browser page’s picker lists signed-in providers, keeps the current choice, and offers only fitting efforts', async () => {
  const { modelValue, parseModelValue, pickerOptions } = await import('../src/lib/model-choice.js')
  const payload = {
    providers: [
      { slug: 'openai-codex', name: 'OpenAI', authenticated: true, models: ['gpt-6-luna', 'gpt-6.1-sol'], featured_models: ['gpt-6.1-sol'], capabilities: { 'gpt-6.1-sol': { reasoning: true, can_disable_reasoning: false }, 'gpt-6-luna': { reasoning: false } } },
      { slug: 'signed-out', name: 'Signed out', authenticated: false, models: ['x'] }
    ]
  }
  const none = pickerOptions(payload, null)
  assert.equal(none.value, '')
  assert.deepEqual(none.groups.map(group => group.name), ['OpenAI'])
  assert.deepEqual(none.groups[0].models.map(model => model.label), ['gpt-6.1-sol', 'gpt-6-luna'])
  assert.equal(none.efforts[0][0], 'none')

  const sol = pickerOptions(payload, { model: 'gpt-6.1-sol', provider: 'openai-codex', effort: 'high' })
  assert.deepEqual(parseModelValue(sol.value), { provider: 'openai-codex', model: 'gpt-6.1-sol' })
  assert.ok(!sol.efforts.some(([value]) => value === 'none'))
  assert.equal(pickerOptions(payload, { model: 'gpt-6-luna', provider: 'openai-codex' }).efforts.length, 0)

  // A choice the list doesn't carry (or no list at all) still shows as itself.
  const gone = pickerOptions(null, { model: 'old-model', provider: 'somewhere' })
  assert.equal(gone.value, modelValue('somewhere', 'old-model'))
  assert.equal(gone.groups[0].models[0].label, 'old-model')
  assert.deepEqual(parseModelValue(''), { provider: null, model: null })
})
