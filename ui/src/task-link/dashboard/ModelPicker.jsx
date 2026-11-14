// The browser task page's model and reasoning choice for a reply. Desktop uses Hermes' own model
// menu; a browser has none, so this is one chip in the reply box that names the choice, and a
// sheet from the bottom edge to change it, fed by the dashboard's model list. Same props as
// delegation/ModelChoice.jsx's ModelChoicePicker.
import { Codicon } from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'

import { choiceLabel, EFFORT_OPTIONS, normalChoice, parseModelValue, pickerOptions } from '../../lib/model-choice.js'
import { TASK_PAGE } from '../../lib/task-link.js'

// One list per profile, kept for the page's life; a read that failed is tried again when the sheet is next opened.
const catalogs = new Map()

/** Hermes' model list for the link's profile: { payload, status: 'loading' | 'ready' | 'failed' }.
 *  Read once per page through the dashboard's signed-in fetch; `again` changing retries a failure. */
function useCatalog(again) {
  const profile = new URLSearchParams(window.location.search).get('profile') ?? ''
  const [state, setState] = useState(() => (catalogs.has(profile) ? { payload: catalogs.get(profile), status: 'ready' } : { payload: null, status: 'loading' }))
  useEffect(() => {
    if (catalogs.has(profile)) return void setState({ payload: catalogs.get(profile), status: 'ready' })
    let live = true
    setState({ payload: null, status: 'loading' })
    // Everything before the page path: the reverse-proxy prefix, if any (as dashboard.jsx does).
    const at = window.location.pathname.indexOf(TASK_PAGE)
    const prefix = at > 0 ? window.location.pathname.slice(0, at) : ''
    const failed = () => live && setState({ payload: null, status: 'failed' })
    const read = window.__HERMES_PLUGIN_SDK__
      // The link's own profile, and only providers set up on purpose, as Hermes' chat pickers show.
      ?.authedFetch(`${prefix}/api/model/options?explicit_only=true${profile ? `&profile=${encodeURIComponent(profile)}` : ''}`, { cache: 'no-store' })
    if (!read) return void failed()
    read
      .then(response => (response.ok ? response.json() : null))
      .then(body => {
        if (!body?.providers) return failed()
        catalogs.set(profile, body)
        if (live) setState({ payload: body, status: 'ready' })
      })
      .catch(failed)
    return () => {
      live = false
    }
  }, [profile, again])
  return state
}

const EFFORT_WORDS = Object.fromEntries(EFFORT_OPTIONS)
const effortWord = effort => EFFORT_WORDS[effort] ?? effort

export function ModelPicker({ choice, onChange, disabled = false, labelPrefix = 'Model and reasoning' }) {
  const [open, setOpen] = useState(false)
  // Opening the sheet again after the list failed to load tries once more.
  const [again, setAgain] = useState(0)
  const { payload, status } = useCatalog(again)
  const chip = useRef(null)
  const sheet = useRef(null)
  const current = normalChoice(choice)
  const { groups, efforts, value } = pickerOptions(payload, current)
  const label = choiceLabel(current, effortWord)

  const close = () => {
    setOpen(false)
    chip.current?.focus()
  }
  const show = () => {
    if (status === 'failed') setAgain(count => count + 1)
    setOpen(true)
  }
  // Reasoning is kept across a model change when the new model can take it.
  const pick = modelValue => {
    if (modelValue === value) return
    const next = parseModelValue(modelValue)
    const fits = pickerOptions(payload, { ...next, effort: null }).efforts.some(([effort]) => effort === current.effort)
    onChange({ ...next, effort: fits ? current.effort : null })
  }

  // The reply box locked (sending) while the sheet is up: nothing more can be chosen.
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  // While it is open: focus starts on the current model, and the page behind does not scroll.
  useEffect(() => {
    if (!open) return undefined
    ;(sheet.current?.querySelector('.rk-sheet-models [aria-pressed="true"]') ?? sheet.current?.querySelector('button'))?.focus()
    const root = document.documentElement
    const before = root.style.overflow
    root.style.overflow = 'hidden'
    // On the document, so they work wherever focus has gone (a tap on the title, or Safari not
    // focusing a tapped button): Escape closes, and Tab stays inside the sheet.
    const onKey = event => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        return close()
      }
      if (event.key !== 'Tab') return
      const stops = [...(sheet.current?.querySelectorAll('button') ?? [])]
      const first = stops[0]
      const last = stops[stops.length - 1]
      // On the sheet itself (a tap on its empty space) counts as outside its buttons.
      const inside = sheet.current?.contains(document.activeElement) && document.activeElement !== sheet.current
      if (!inside || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first)?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      root.style.overflow = before
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  // The list arriving after the sheet opened rebuilds its rows: focus goes back to the current one.
  useEffect(() => {
    if (open && status === 'ready' && !sheet.current?.contains(document.activeElement)) {
      sheet.current?.querySelector('.rk-sheet-models [aria-pressed="true"]')?.focus()
    }
  }, [open, status])

  return (
    <span className="rk-model-picker">
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${labelPrefix}: ${label}`}
        className="rk-model-chip"
        disabled={disabled}
        onClick={show}
        ref={chip}
        type="button"
      >
        <span className="rk-model-chip-name">{current.model ?? 'Profile default'}</span>
        {current.effort && <span className="rk-model-chip-effort">· {effortWord(current.effort)}</span>}
        <Codicon name="chevron-down" size="0.75rem" />
      </button>
      {open && (
        <>
          <div aria-hidden className="rk-sheet-veil" onClick={close} />
          <div aria-labelledby="rk-sheet-title" aria-modal="true" className="rk-sheet" ref={sheet} role="dialog" tabIndex={-1}>
            <div className="rk-sheet-head">
              <h2 className="rk-sheet-title" id="rk-sheet-title">
                For this reply
              </h2>
              <button className="rk-sheet-done" onClick={close} type="button">
                Done
              </button>
            </div>
            {efforts.length > 0 && (
              <div className="rk-sheet-group">
                <span className="rk-sheet-label" id="rk-sheet-reasoning">
                  Reasoning
                </span>
                <div aria-labelledby="rk-sheet-reasoning" className="rk-sheet-efforts" role="group">
                  <button aria-pressed={!current.effort} onClick={() => onChange({ model: current.model, provider: current.provider, effort: null })} type="button">
                    Default
                  </button>
                  {efforts.map(([effort, word]) => (
                    <button
                      aria-pressed={current.effort === effort}
                      key={effort}
                      onClick={() => onChange({ model: current.model, provider: current.provider, effort })}
                      type="button"
                    >
                      {word}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="rk-sheet-group rk-sheet-grow">
              <span className="rk-sheet-label" id="rk-sheet-model">
                Model
              </span>
              <div aria-labelledby="rk-sheet-model" className="rk-sheet-models" role="group">
                <button aria-pressed={!value} className="rk-sheet-row" onClick={() => pick('')} type="button">
                  <span className="rk-sheet-row-text">
                    <span>Profile default</span>
                    {payload?.model && <span className="rk-sheet-sub">{payload.model}</span>}
                  </span>
                  {!value && <Codicon name="check" size="1rem" />}
                </button>
                {status !== 'ready' && (
                  <p className="rk-sheet-note" role="status">
                    {status === 'loading' ? 'Loading your models…' : "Couldn't load your models. Close this and open it again to retry."}
                  </p>
                )}
                {groups.map(group => (
                  <div aria-label={group.name} className="rk-sheet-provider" key={group.key} role="group">
                    <span aria-hidden className="rk-sheet-provider-name">
                      {group.name}
                    </span>
                    {group.models.map(model => (
                      <button
                        aria-pressed={model.value === value}
                        className="rk-sheet-row"
                        key={model.value}
                        onClick={() => pick(model.value)}
                        type="button"
                      >
                        <span className="rk-sheet-row-text">{model.label}</span>
                        {model.value === value && <Codicon name="check" size="1rem" />}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </span>
  )
}
