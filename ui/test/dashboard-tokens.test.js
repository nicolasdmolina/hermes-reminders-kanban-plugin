// The browser task page runs on the web dashboard, which defines none of the Desktop host tokens.
// A host token the task styles or the shared tokens read but dashboard.css does not map is
// silently invalid there, so every one of them must be mapped on .rk-dash.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const used = text => new Set([...text.matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1]).filter(name => /^--(?:ui|dt)-|^--foreground$/.test(name)))

test('every host token the browser page reads is mapped on .rk-dash', () => {
  const dashboard = read('task-link/dashboard.css')
  const block = /\.rk-dash \{([^}]*)\}/.exec(dashboard)?.[1] ?? ''
  const mapped = new Set([...block.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]))
  const needed = new Set([...used(read('task/task.css')), ...used(read('task-link/task-link.css')), ...used(read('theme/tokens.css'))])
  assert.deepEqual([...needed].filter(name => !mapped.has(name)).sort(), [])
})
