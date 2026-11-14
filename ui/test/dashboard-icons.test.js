import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// The browser task page draws its own icons (dashboard/sdk.js). Every icon name the task panel
// can ask for must be drawn or aliased there, or a line shows an empty slot.
const read = file => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
const sdk = read('task-link/dashboard/sdk.js')
const drawn = new Set([...sdk.slice(sdk.indexOf('const ICONS'), sdk.indexOf('const ALIASES')).matchAll(/^\s+'?([a-z-]+)'?:\s*$|^\s+'?([a-z-]+)'?: '/gm)].map(m => m[1] ?? m[2]))
const aliases = Object.fromEntries([...sdk.slice(sdk.indexOf('const ALIASES'), sdk.indexOf('export function Codicon')).matchAll(/'?([a-z-]+)'?: '([a-z-]+)'/g)].map(m => [m[1], m[2]]))

test('every icon the task panel asks for is drawn on the browser page', () => {
  const panel = read('task-link/TaskPanel.jsx') + read('task/shell.jsx') + read('recovery/Recovery.jsx')
  const asked = new Set([...panel.matchAll(/name="([a-z-]+)"/g)].map(m => m[1]))
  // Names chosen in expressions (the live line, problem screens, activity glyphs).
  for (const m of panel.matchAll(/'(clock|circle-slash|debug-pause|debug-stop|warning|check|loading|arrow-up|lock|remote|account|search|debug-disconnect|extensions|calendar|circle-large-outline|watch|link)'/g)) asked.add(m[1])
  const missing = [...asked].filter(name => !drawn.has(name) && !drawn.has(aliases[name]))
  assert.deepEqual(missing, [])
  for (const [from, to] of Object.entries(aliases)) assert.ok(drawn.has(to), `${from} aliases a missing icon ${to}`)
})
