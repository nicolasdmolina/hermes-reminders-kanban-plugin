// Capture-only transport for task-link setup. Never in a shipped build:
// build.mjs swaps it in only with RK_LINK_STUB=1 and fails a normal build that carries it.
//
// It stands in for the backend's /task-links/setup routes (and the task_links GET
// /delegation would carry) for states the sandbox can't produce: a reachable HTTPS address, Tailscale's
// states without running the real CLI. It behaves like the backend, so the panel is driven by
// real clicks: Check answers, Set up / Save address saves, Only on this Mac switches mode. Every
// other path goes to the real backend. A capture picks the starting state with
// window.__rkLinkStub.set(name). The host name is fake; never put a real tailnet name in evidence.
import * as sdk from '@hermes/plugin-sdk'

import { request } from './client.js'

const ADDRESS = 'https://mac.tail1234.ts.net:8443'
const OWN = 'https://hermes.example.com'
const LOCAL = 'http://127.0.0.1:9119'

const dashboard = (extra = {}) => ({ running: true, local: LOCAL, signin: 'password', ...extra })
const ts = {
  ready: { state: 'ready', address: ADDRESS, port: 8443, existing: false },
  not_installed: { state: 'not_installed', address: null, port: null, existing: false },
  signed_out: { state: 'signed_out', address: null, port: null, existing: false },
  https_off: { state: 'https_off', address: null, port: null, existing: false }
}
const base = { status: 'missing', address: null, source: null, reason: null, mode: 'none', dashboard: dashboard(), tailscale: ts.ready, can_write: true, backfill: { pending: 0, conflicts: 0 } }

// { setup, check, apply, delay }: the GET answer, what Check and Set up answer, and how long they take.
const SCENARIOS = {
  missing: {},
  'ts-not-installed': { setup: { tailscale: ts.not_installed } },
  'ts-signed-out': { setup: { tailscale: ts.signed_out } },
  'ts-https-off': { setup: { tailscale: ts.https_off } },
  'ts-slow': { delay: 8_000 },
  'own-ok': { setup: { tailscale: ts.not_installed, dashboard: dashboard({ signin: 'nous' }) }, check: { status: 'ok', signin: 'nous' } },
  'own-slow': { setup: { tailscale: ts.not_installed }, check: { status: 'ok', signin: 'nous' }, delay: 8_000 },
  'own-unreachable': { setup: { tailscale: ts.not_installed }, check: { status: 'unreachable' } },
  'own-password-public': { setup: { tailscale: ts.not_installed }, check: { status: 'password_on_public', signin: 'password' } },
  'no-dashboard': { setup: { dashboard: dashboard({ running: false, signin: null }) } },
  'no-signin': { setup: { dashboard: dashboard({ signin: null }) } },
  'env-override': { setup: { can_write: false, source: 'env', reason: 'env_override' } },
  'restart-needed': { setup: { status: 'restart_needed', address: ADDRESS, source: 'config', mode: 'none' }, apply: { status: 'restart_needed', address: ADDRESS } },
  'apply-restart': { apply: { status: 'restart_needed', address: ADDRESS } },
  'apply-funnel': { apply: { status: 'funnel_on' } },
  ready: { setup: { status: 'ready', address: ADDRESS, source: 'config', mode: 'links' } },
  'ready-conflicts': { setup: { status: 'ready', address: ADDRESS, source: 'config', mode: 'links', backfill: { pending: 0, conflicts: 2 } } },
  local: { setup: { status: 'local', mode: 'local' } },
  invalid: { setup: { status: 'invalid', address: 'http://192.168.1.20:9119', source: 'config', reason: 'not_https' } }
}

const { atom } = sdk
const current = atom({ name: 'missing', setup: { ...base }, epoch: 0 })
const load = name => {
  const scenario = SCENARIOS[name]
  if (!scenario) return null
  current.set({ name, setup: { ...base, ...(scenario.setup ?? {}) }, epoch: current.get().epoch + 1 })
  return name
}
if (typeof window !== 'undefined') window.__rkLinkStub = { set: load, names: Object.keys(SCENARIOS), stub: true }

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const readiness = setup => ({ status: setup.status, reason: setup.reason, mode: setup.mode })
// A slow answer that lands after the capture moved to another scenario changes nothing.
const save = (epoch, setup) => current.get().epoch === epoch && current.set({ ...current.get(), setup })

/** task_links as GET /delegation would report them for this scenario. */
export const useTaskLinks = () => readiness(sdk.useValue(current).setup)

export async function transport(scope, path, options) {
  const { name, setup, epoch } = current.get()
  const scenario = SCENARIOS[name] ?? {}
  if (!path.startsWith('/task-links/setup')) return request(scope, path, options)
  await wait(path === '/task-links/setup' ? 350 : (scenario.delay ?? 350))
  if (path === '/task-links/setup') return setup
  if (path.endsWith('/check')) {
    const address = String(options?.body?.address ?? '')
    if (!/^https:\/\//.test(address)) return { status: 'not_https' }
    return scenario.check ?? { status: 'unreachable' }
  }
  if (path.endsWith('/local')) {
    save(epoch, { ...setup, status: setup.status === 'ready' ? 'ready' : 'local', mode: 'local' })
    return { status: 'local' }
  }
  if (path.endsWith('/apply')) {
    const body = options?.body ?? {}
    const address = body.mode === 'own' ? body.address || OWN : body.expected
    const answer = scenario.apply ?? { status: 'ready', address, backup: '~/.hermes/config.yaml.rk-backup-stub' }
    if (answer.status === 'ready') save(epoch, { ...setup, status: 'ready', address, source: 'config', mode: 'links' })
    if (answer.status === 'restart_needed') save(epoch, { ...setup, status: 'restart_needed', address: answer.address ?? address, source: 'config' })
    return answer
  }
  return { status: 'unavailable' }
}
