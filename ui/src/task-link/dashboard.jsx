// Browser entry: the page a stable task link opens, served by the owning Hermes web
// dashboard behind its own sign-in. Built by ui/build.mjs into dashboard/dist/index.js
// (a classic script; react and the SDK primitives come from window.__HERMES_PLUGIN_SDK__).
import { useCallback, useEffect, useMemo, useState } from 'react'

import { splitTitle } from '../lib/cards.js'
import { pageEntry, pagePath, TASK_PAGE } from '../lib/task-link.js'
import { usePolledRecovery } from '../recovery/poll.js'
import { defineStyles, installStyles } from '../styles.js'
import dashboardCss from './dashboard.css'
import { DialogHead, StatusPill } from '../task/shell.jsx'
import { ModelPicker } from './dashboard/ModelPicker.jsx'
import { LinkEmpty, LinkProblem, TaskConversation } from './TaskPanel.jsx'

defineStyles(dashboardCss)

const PLUGIN = 'reminders-kanban'
const API_ROOT = `/api/plugins/${PLUGIN}`

// Everything before the page path: the reverse-proxy prefix, if any.
const basePrefix = () => {
  const at = window.location.pathname.indexOf(TASK_PAGE)
  return at > 0 ? window.location.pathname.slice(0, at) : ''
}

/** JSON over the dashboard's authenticated fetch. Errors look like ctx.rest's ("<status>: <body>").
 *  authedFetch never redirects on 401, so the page keeps its draft and shows its own sign-in state. */
export function dashboardApi(profile) {
  const sdk = window.__HERMES_PLUGIN_SDK__
  const call = async (path, init) => {
    const separator = path.includes('?') ? '&' : '?'
    const scoped = path.includes('profile=') ? path : `${path}${separator}profile=${encodeURIComponent(profile)}`
    const response = await sdk.authedFetch(`${basePrefix()}${API_ROOT}${scoped}`, { cache: 'no-store', ...init })
    const text = await response.text()
    if (!response.ok) {
      const error = new Error(`${response.status}: ${text}`)
      error.statusCode = response.status
      throw error
    }
    return text ? JSON.parse(text) : null
  }
  return {
    get: path => call(path),
    post: (path, body) =>
      call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  }
}

function signIn() {
  const here = window.location.pathname + window.location.search
  window.location.assign(`${basePrefix()}/login?next=${encodeURIComponent(here)}`)
}

// The dashboard has no dark class; read its page color so the shared tokens use the right bounds.
// Computed colors come back as rgb(), color(srgb ...) or oklab()/oklch(); lightness is enough.
function lightnessOf(value) {
  const ok = /okl(?:ab|ch)\(\s*([\d.]+)(%?)/.exec(value)
  if (ok) return ok[2] ? Number(ok[1]) / 100 : Number(ok[1])
  const srgb = /srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(value)
  const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value)
  const parts = srgb ? srgb.slice(1).map(Number) : rgb ? rgb.slice(1).map(n => Number(n) / 255) : null
  return parts ? 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2] : null
}

function pageIsDark() {
  for (const element of [document.body, document.documentElement]) {
    const value = element ? getComputedStyle(element).backgroundColor : ''
    if (!value || /^transparent$|,\s*0\)$|\/\s*0\)$/.test(value)) continue
    const lightness = lightnessOf(value)
    if (lightness !== null) return lightness < 0.5
  }
  return false
}

function usePageMode() {
  const [mode, setMode] = useState(() => (pageIsDark() ? 'dark' : 'light'))
  useEffect(() => {
    const measure = () => setMode(pageIsDark() ? 'dark' : 'light')
    const observer = new MutationObserver(measure)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
    measure()
    return () => observer.disconnect()
  }, [])
  return mode
}

function TaskLinkPage() {
  const [href, setHref] = useState(() => window.location.href)
  const [title, setTitle] = useState(null)
  const entry = useMemo(() => pageEntry(href), [href])
  const dest = entry.kind === 'task' ? entry.dest : null
  const api = useMemo(() => (dest ? dashboardApi(dest.profile) : null), [dest?.profile])
  // No Settings here: a broken sign-in is repaired on the Mac, so the browser shows no repair button.
  const feed = usePolledRecovery(api)
  // The row behind this stable link; a repeating reminder's occurrence rows (scope) have no Retry.
  // Run again keeps the stopped run's row (archived under `storage_key`) beside the new one, on the
  // same link: the current run is the row without it, else the newest (placement.js rowFor).
  const rows = dest ? (feed.feed?.tasks ?? []).filter(task => task?.destination?.link_id === dest.link && task.destination.owner_id === dest.owner && !task.scope) : []
  const row = rows.find(task => !task.storage_key) ?? rows.at(-1) ?? null
  const recovery = useMemo(() => (row ? { row, refresh: feed.refresh } : null), [row, feed.refresh])

  useEffect(() => {
    const follow = () => setHref(window.location.href)
    window.addEventListener('popstate', follow)
    return () => window.removeEventListener('popstate', follow)
  }, [])

  useEffect(() => {
    if (title) document.title = `${splitTitle(title).text} · Hermes`
  }, [title])

  const onOccurrence = useCallback(
    id => {
      if (!dest) return
      window.history.replaceState(window.history.state, '', `${basePrefix()}${pagePath(dest, id)}`)
    },
    [dest]
  )

  const mode = usePageMode()
  const heading = <h1 className="rk-task-title" dir="auto">{title ? splitTitle(title).text : 'Task'}</h1>

  return (
    <div className="rk-dash" data-mode={mode}>
      <main className="rk-dash-page rk-task">
        {dest ? (
          <TaskConversation
            api={api}
            dest={dest}
            key={`${dest.owner}/${dest.link}/${dest.profile}`}
            modelPicker={ModelPicker}
            occurrenceRows={feed.occurrences}
            onOccurrence={onOccurrence}
            onSignIn={signIn}
            onTitle={setTitle}
            recovery={recovery}
            // A one-off's earlier entries are runs, not occurrences.
            repeating={!row}
            title={heading}
          />
        ) : entry.kind === 'no_task' ? (
          <div className="rk-task-body">
            <LinkEmpty />
          </div>
        ) : (
          <>
            <DialogHead pill={<StatusPill label="Not found" />} title={<h1 className="rk-task-title">Task</h1>} />
            <div className="rk-task-body">
              <LinkProblem kind="not_found" onRetry={() => window.location.reload()} />
            </div>
          </>
        )}
      </main>
    </div>
  )
}

const plugins = window.__HERMES_PLUGINS__
if (plugins && window.__HERMES_PLUGIN_SDK__) {
  installStyles({ onDispose() {} })
  plugins.register(PLUGIN, TaskLinkPage)
}
