import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'

const sdk = `
import { createElement, useState } from 'react'
const h = () => globalThis.__rkOnboarding
export const gatewayActivationEpoch = () => 0
export const atom = value => ({ get: () => value })
export const host = { state: { profile: { get: () => h().scope[1] }, connectionId: { get: () => h().scope[0] } } }
export const useValue = value => value.get()
export const Button = ({ size, variant, children, ...props }) => createElement('button', props, children)
export const Checkbox = ({ checked, onCheckedChange, ...props }) => createElement('input', { ...props, type: 'checkbox', checked: checked === true, onChange: e => onCheckedChange(e.target.checked) })
export const Codicon = () => null
export const Dialog = Codicon, DialogContent = Codicon, DialogTitle = Codicon, Popover = Codicon, PopoverContent = Codicon, PopoverTrigger = Codicon, Switch = Codicon, Tip = Codicon
export const useQuery = options => { h().queryOptions = options; return h().query }
export const useQueryClient = () => ({ setQueryData: (key, data) => { h().cache.push({ key, data }) } })
export function useMutation(options) {
  const [state, setState] = useState({ isPending: false })
  return { ...state, mutate: action => {
    setState({ isPending: true, variables: action })
    Promise.resolve().then(() => options.mutationFn(action)).then(data => {
      options.onSuccess?.(data)
      setState({ isPending: false, data, variables: action })
    }, error => setState({ isPending: false, isError: true, error, variables: action })).finally(() => options.onSettled?.())
  } }
}
`

async function loadComponents() {
  const dir = await mkdtemp(join(tmpdir(), 'rk-onboarding-'))
  const result = await build({
    stdin: {
      contents: `export { Setup } from './src/onboarding/Setup.jsx'; export { ConnectionStatus } from './src/onboarding/Connect.jsx'; export { useHelperSetup } from './src/onboarding/useHelperSetup.js'; export { bindClient } from './src/api/client.js'; export { PickupReview, pickupPhase } from './src/delegation/Pickup.jsx'`,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'js'
    },
    bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', write: false,
    loader: { '.css': 'text' },
    plugins: [{ name: 'host-boundary', setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }))
      builder.onResolve({ filter: /^@hermes\/plugin-sdk$/ }, () => ({ path: 'sdk', namespace: 'double' }))
      builder.onResolve({ filter: /LinkSetup\.jsx$/ }, () => ({ path: 'links', namespace: 'double' }))
      builder.onLoad({ filter: /.*/, namespace: 'double' }, args => ({ contents: args.path === 'sdk' ? sdk : 'export const LinkSetup = () => null; export const TaskLinksFact = LinkSetup, TaskLinksButton = LinkSetup' }))
    } }]
  })
  const path = join(dir, 'components.mjs')
  await writeFile(path, result.outputFiles[0].text)
  return { ...await import(pathToFileURL(path)), dispose: () => rm(dir, { recursive: true, force: true }) }
}

test('Connect actions, slow setup, connection scope, and list drafts', async () => {
  const dom = new JSDOM('<div id="root"></div>')
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const harness = globalThis.__rkOnboarding = { scope: ['local', 'default'], query: {}, cache: [] }
  const module = await loadComponents()
  const root = createRoot(document.getElementById('root'))
  const render = node => act(async () => root.render(node))
  const buttons = () => [...document.querySelectorAll('button')]
  const click = text => act(async () => buttons().find(button => button.textContent === text).click())
  const calls = []
  const helper = { pending: false, run: action => calls.push(action) }
  const connected = { envelope: {} }
  const status = (code, overrides = {}) => createElement(module.ConnectionStatus, { helper, onRetry: () => calls.push('retry'), pending: false, profile: 'default', view: { ...connected, helperStatus: code }, ...overrides })
  try {
    await render(status('signing_required'))
    assert.equal(document.querySelector('h2').textContent, 'Set up Reminders access')
    assert.match(document.body.textContent, /local signing identity/)
    assert.match(document.body.textContent, /Keychain and Reminders access/)
    assert.doesNotMatch(document.body.textContent, /certificate|codesign/i)
    await click('Set up Reminders access')
    assert.deepEqual(calls, ['prepare'])
    await render(status('toolchain_required'))
    await click('Install Apple tools')
    await click('Check again')
    assert.deepEqual(calls, ['prepare', 'install_tools', 'check'])
    buttons()[1].focus()
    const focused = document.activeElement
    await render(status('signing_required', { helper: { ...helper, pending: true, action: 'prepare' } }))
    assert.ok(buttons().every(button => button.getAttribute('aria-disabled') === 'true' && !button.disabled))
    assert.equal(document.activeElement, focused)
    await act(async () => { for (const button of buttons()) button.click() })
    assert.deepEqual(calls, ['prepare', 'install_tools', 'check'], 'busy controls do not send more actions')
    assert.match(document.body.textContent, /Setting up/)
    await render(status('session_locked'))
    assert.match(document.body.textContent, /Unlock the Mac/)
    assert.deepEqual(buttons().map(button => button.textContent), ['Check again'])
    await render(status(null, { view: { ...connected, denied: true } }))
    assert.match(document.body.textContent, /RK Reminders Helper/)
    assert.ok(buttons().some(button => button.textContent === 'Open Privacy Settings'))

    const requests = []
    const unbind = module.bindClient({ rest: (path, options) => new Promise(resolve => requests.push({ path, options, resolve })) })
    let controller, ready = 0
    function Probe() {
      controller = module.useHelperSetup(['local', 'default'], true, () => { ready++ })
      return createElement('span', null, controller.pending ? 'busy' : 'idle')
    }
    await render(createElement(Probe))
    assert.equal(requests.length, 0, 'mounting never prepares the helper')
    let read
    await act(async () => { read = harness.queryOptions.queryFn() })
    assert.equal(requests[0].path, '/helper-setup')
    assert.equal(requests[0].options.method, undefined, 'status inspection uses GET')
    requests[0].resolve({ status: 'signing_required' })
    await read
    await act(async () => { controller.run('prepare'); controller.run('prepare') })
    assert.equal(requests.length, 2, 'same-event duplicate clicks submit once')
    assert.deepEqual(requests[1].options.body, { action: 'prepare' })
    assert.equal(controller.pending, true)
    harness.scope = ['remote', 'default']
    await act(async () => { requests[1].resolve({ status: 'ready' }) })
    assert.equal(ready, 0, 'late replies cannot refresh another connection')
    assert.equal(harness.cache.length, 0, 'late replies cannot paint another connection')
    harness.scope = ['local', 'default']
    await act(async () => controller.run('prepare'))
    harness.scope = ['local', 'other']
    await act(async () => requests[2].resolve({ status: 'ready' }))
    assert.equal(ready, 0, 'late replies cannot refresh another profile')
    harness.scope = ['local', 'default']
    await act(async () => controller.run('prepare'))
    await act(async () => requests[3].resolve({ status: 'ready' }))
    assert.equal(ready, 1)
    assert.equal(harness.cache[0].data.status, 'ready')
    harness.query = { data: { status: 'ready' }, isError: true, error: new Error('fetch failed'), isFetching: false }
    await render(createElement(Probe))
    assert.equal(controller.pending, false, 'failed GET with cached readiness cannot leave setup busy')
    await act(async () => controller.run('check'))
    assert.equal(requests[4].options.method, undefined)
    await act(async () => requests[4].resolve({ status: 'ready' }))
    assert.equal(ready, 2, 'Check again recovers after a failed status GET')
    harness.query = {}
    unbind()

    const lists = [{ id: 'a', title: 'School' }, { id: 'b', title: 'Personal' }]
    const view = { step: 'lists', envelope: { lists, setup: { selected_list_ids: ['a'] } } }
    function Wizard({ step }) {
      const [draft, setDraft] = useState(null)
      return createElement(module.Setup, { listDraft: draft, onListDraft: setDraft, scope: harness.scope, saving: { reset() {} }, view: step === 'lists' ? view : { ...connected, step: 'connect', helperStatus: 'signing_required' } })
    }
    await render(createElement(Wizard, { step: 'lists' }))
    await act(async () => document.querySelectorAll('input')[2].click())
    await render(createElement(Wizard, { step: 'connect' }))
    await render(createElement(Wizard, { step: 'lists' }))
    assert.ok([...document.querySelectorAll('input')].every(input => input.checked), 'draft list selection survives a setup interruption')

    const delegation = { data: { status: 'setup_required', reason: 'owner_board_unavailable' } }
    assert.equal(module.pickupPhase(delegation).phase, 'unavailable')
    let opened = false
    await render(createElement(module.Setup, {
      view: { step: 'review', envelope: { ...view.envelope, cards: [] } },
      pickup: createElement(module.PickupReview, { delegation, fallbackReady: 0 }),
      onOpenBoard: () => { opened = true }
    }))
    assert.match(document.body.textContent, /isn.t set up for agent work/)
    assert.equal(document.querySelectorAll('[role="switch"]').length, 0)
    await click('Open board')
    assert.equal(opened, true, 'unavailable pickup never blocks opening the board')
  } finally {
    await act(async () => root.unmount())
    await module.dispose()
    dom.window.close()
    delete globalThis.window
    delete globalThis.document
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
    delete globalThis.__rkOnboarding
  }
})
