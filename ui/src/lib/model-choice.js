// The board's model choice for new agent tasks (reminders_kanban/api/model-choice-contract.md) as
// data. Pure: no host imports. null fields mean "Use profile default"; effort 'none' turns thinking
// off. The picker is Hermes' own ModelCatalogMenu, which speaks '' for "inherit".

export const DEFAULT_CHOICE = Object.freeze({ model: null, provider: null, effort: null })

/** Every effort the backend accepts besides null. */
export const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null)

/** A saved or menu value as the backend's shape. A model needs its provider and the reverse, so a
 *  half-named model falls back to the profile's; an effort the backend doesn't know does too. */
export function normalChoice(value) {
  const model = text(value?.model)
  const provider = text(value?.provider)
  const effort = text(value?.effort)
  const named = model && provider
  return { model: named ? model : null, provider: named ? provider : null, effort: EFFORTS.has(effort) ? effort : null }
}

export const isDefault = choice => {
  const c = normalChoice(choice)
  return !c.model && !c.effort
}

export const sameChoice = (a, b) => {
  const x = normalChoice(a)
  const y = normalChoice(b)
  return x.model === y.model && x.provider === y.provider && x.effort === y.effort
}

/** The trigger's words: "Profile default", "gpt-6.1-sol · High" or "Profile default · Off".
 *  effortLabel: the host's reasoningEffortLabel, so efforts read as they do in the composer. */
export function choiceLabel(choice, effortLabel = value => value, inherit = 'Profile default') {
  const c = normalChoice(choice)
  const base = c.model ?? inherit
  return c.effort ? `${base} · ${effortLabel(c.effort)}` : base
}

/** What the catalog menu shows as current. */
export function menuCurrent(choice) {
  const c = normalChoice(choice)
  return { effort: c.effort ?? '', fast: false, model: c.model ?? '', provider: c.provider ?? '' }
}

/**
 * Saves in the order asked, so the last pick is the one that sticks. post(choice) resolves to
 * { ok: true, choice } or { problem } (or { superseded: true }). save() resolves to its own outcome;
 * settled() waits for every queued save and resolves to the last outcome, or null when none ran.
 */
export function saveQueue(post) {
  let chain = Promise.resolve(null)
  let pending = 0
  return {
    save(choice) {
      pending += 1
      const next = chain.then(() => post(normalChoice(choice))).catch(error => ({ problem: String(error?.message ?? error) }))
      chain = next.finally(() => {
        pending -= 1
      })
      return next
    },
    async settled() {
      // A save asked while waiting joins the wait.
      let last
      let outcome
      do {
        last = chain
        outcome = await last
      } while (last !== chain)
      return outcome
    },
    get pending() {
      return pending
    }
  }
}

// ── The browser task page's picker (no Hermes menu there): a chip and a sheet ──────────────────

/** Efforts the page offers, in order, with the words Hermes uses for them. */
export const EFFORT_OPTIONS = [
  ['none', 'Off'],
  ['minimal', 'Minimal'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['xhigh', 'Extra high']
]

const SEPARATOR = '\u001f'

/** A select option's value for a provider's model, and back. '' is the profile's own model. */
export const modelValue = (provider, model) => (provider && model ? `${provider}${SEPARATOR}${model}` : '')
export function parseModelValue(value) {
  const at = String(value ?? '').indexOf(SEPARATOR)
  return at > 0 ? { provider: value.slice(0, at), model: value.slice(at + 1) } : { provider: null, model: null }
}

/**
 * Hermes' model list (GET /api/model/options: { providers: [{ slug, name, models, featured_models,
 * capabilities, authenticated }] }) as what the sheet shows for `choice`:
 * - groups: [{ name, models: [{ value, label }] }], signed-in providers only, featured models first.
 *   The current choice is always present, listed or not, so the sheet can show it.
 * - efforts: [[value, label]] the chosen model can take; empty when it has no reasoning setting.
 */
export function pickerOptions(payload, choice) {
  const current = normalChoice(choice)
  const groups = []
  let caps = null
  for (const provider of Array.isArray(payload?.providers) ? payload.providers : []) {
    if (!provider?.slug || provider.authenticated === false) continue
    const listed = (Array.isArray(provider.models) ? provider.models : []).filter(model => typeof model === 'string' && model)
    const featured = (Array.isArray(provider.featured_models) ? provider.featured_models : []).filter(model => listed.includes(model))
    const models = [...featured, ...listed.filter(model => !featured.includes(model))]
    if (current.provider === provider.slug && current.model) {
      if (!models.includes(current.model)) models.unshift(current.model)
      caps = provider.capabilities?.[current.model] ?? null
    }
    if (models.length) groups.push({ key: provider.slug, name: provider.name || provider.slug, models: models.map(model => ({ value: modelValue(provider.slug, model), label: model })) })
  }
  const chosen = modelValue(current.provider, current.model)
  if (chosen && !groups.some(group => group.models.some(model => model.value === chosen))) {
    groups.unshift({ key: `${current.provider}:current`, name: current.provider, models: [{ value: chosen, label: current.model }] })
  }
  // The profile's own model, or one Hermes says nothing about: offer every effort.
  const reasoning = caps ? caps.reasoning !== false : true
  const efforts = !reasoning ? [] : EFFORT_OPTIONS.filter(([value]) => value !== 'none' || caps?.can_disable_reasoning !== false)
  if (current.effort && !efforts.some(([value]) => value === current.effort)) efforts.push([current.effort, current.effort])
  return { groups, efforts, value: chosen }
}
