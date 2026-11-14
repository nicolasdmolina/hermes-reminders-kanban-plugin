// The one door to this plugin's backend (/api/plugins/reminders-kanban/).
//
// Every query key carries the Hermes connection and profile it was read from, and
// every response is dropped if the user switched connection or profile while it
// was in flight (preview-contract.md, story 73). Feature folders add their own
// request functions here or in a sibling file; they all go through `request`.
import * as sdk from '@hermes/plugin-sdk'

import { SupersededError } from '../lib/state.js'

const { atom, host, useValue } = sdk

export const PLUGIN_ID = 'reminders-kanban'

let ctx = null

/** Called from register(); returns the disposer. */
export function bindClient(pluginContext) {
  ctx = pluginContext
  return () => {
    if (ctx === pluginContext) ctx = null
  }
}

/** Plugin-scoped storage and OS doors for components. */
export const pluginContext = () => ctx

const PRIVACY_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders'

// The host's external-open bridge admits only web links and local paths: it answers
// false for x-apple.* deep links, so fall back to opening the app by path.
const openWithFallback = async (url, path) => {
  const opened = await ctx?.os.openExternal(url).catch(() => false)
  if (!opened) await ctx?.os.openExternal(path).catch(() => false)
}

/** Opens System Settings at Privacy & Security → Reminders (or just System Settings). */
export const openPrivacySettings = () => void openWithFallback(PRIVACY_SETTINGS, '/System/Applications/System Settings.app')

/** Opens Apple Reminders. The host cannot open a reminder's own deep link. */
export const openRemindersApp = () => void ctx?.os.openExternal('/System/Applications/Reminders.app').catch(() => false)

const LOCAL = 'local'

// Older desktop builds may lack these atoms; fall back to a single local scope.
const connectionAtom = host.state.connectionId
const NO_CONNECTION = atom(null)
const activationEpoch = () => (typeof sdk.gatewayActivationEpoch === 'function' ? sdk.gatewayActivationEpoch() : 0)
const routedConnection = () =>
  (typeof host.activeConnectionId === 'function' ? host.activeConnectionId() : connectionAtom?.get?.()) || LOCAL

/** [connection, profile] for the request that would be routed right now. */
export function currentScope() {
  return [routedConnection(), host.state.profile.get() || 'default']
}

/** Reactive scope for building query keys during render. */
export function useScope() {
  const connection = useValue(connectionAtom ?? NO_CONNECTION) || LOCAL
  const profile = useValue(host.state.profile) || 'default'
  return [connection, profile]
}

export const queryKey = (scope, ...rest) => [PLUGIN_ID, ...scope, ...rest]

/** A query key is fetchable only while it belongs to the routed connection and profile. */
export function isRouted(scope) {
  const [connection, profile] = currentScope()
  return scope[0] === connection && scope[1] === profile
}

/** Calls the backend for `scope` (the query key's connection and profile). Rejects with
 *  SupersededError if that is not the routed scope when the call starts or when it returns. */
export async function request(scope, path, options) {
  if (!ctx) throw new Error('Reminders Kanban is not loaded')
  if (!isRouted(scope)) throw new SupersededError()
  const epoch = activationEpoch()
  const result = await ctx.rest(path, { timeoutMs: 90_000, ...options })
  if (activationEpoch() !== epoch || !isRouted(scope)) throw new SupersededError()
  return result
}

export const getSetup = scope => request(scope, '/setup')
export const getPreview = scope => request(scope, '/preview')
export const putSetup = (scope, selectedListIds) =>
  request(scope, '/setup', { method: 'PUT', body: { selected_list_ids: selectedListIds } })

// The status read never builds the helper or opens a system prompt.
export const getHelperSetup = scope => request(scope, '/helper-setup')
export const postHelperSetup = (scope, action) => request(scope, '/helper-setup', { method: 'POST', body: { action } })
