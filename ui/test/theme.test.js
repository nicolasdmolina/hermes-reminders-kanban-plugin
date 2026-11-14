// Every plugin color must follow the active Hermes theme: feature code may use host --ui-* / --dt-*
// tokens and the derived --rk-* tokens from src/theme/tokens.css, never a literal color.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src', import.meta.url))
// CSS Color 4 named colors (plus the system keywords that paint a fixed color).
const NAMED = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood
  cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray
  darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen
  darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue
  firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew
  hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
  lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray
  lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue
  mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred
  midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
  palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple
  rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue
  slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow
  yellowgreen canvas canvastext linktext visitedtext activetext buttonface buttontext buttonborder field fieldtext
  highlight highlighttext selecteditem selecteditemtext mark marktext graytext accentcolor accentcolortext`.split(/\s+/)
)
const FUNCTIONS = [
  [/#[0-9a-f]{3,8}\b/gi, 'hex color'],
  [/\b(?:rgba?|hsla?|hwb|lab|lch)\(/gi, 'color function'],
  [/(?<![\w-])color\((?!from\b)/gi, 'literal color()'],
  [/\b(?:oklch|oklab)\((?!from\b)/gi, 'literal oklch/oklab (derive with `oklch(from var(--token) ...)` instead)']
]

const files = dir =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(dir, entry.name)) : /\.(css|jsx?|tsx?)$/.test(entry.name) ? [join(dir, entry.name)] : []
  )
const strip = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** Literal colors in one file's text: functions anywhere, named colors in CSS values or JS strings. */
export function literalColors(text, css) {
  const found = []
  const clean = strip(text)
  for (const [pattern, kind] of FUNCTIONS) for (const match of clean.matchAll(pattern)) found.push(`${kind} "${match[0]}"`)
  // CSS: every declaration value (custom properties included). JS: inline style values (a color
  // property's string, or a one-word string such as a '--rk-tone' value); other strings are copy.
  const values = css
    ? [...clean.matchAll(/[\w-]+\s*:\s*([^;{}]+)/g)].map(m => [m[1], true])
    : [
        ...[...clean.matchAll(/['"]?(?:--[\w-]+|[\w-]*(?:color|background|border|outline|fill|stroke|shadow)[\w-]*)['"]?\s*:\s*(['"`])((?:(?!\1).)*)\1/gi)].map(m => [m[2], true]),
        ...[...clean.matchAll(/(['"`])((?:(?!\1).)*)\1/g)].map(m => [m[2], false])
      ]
  for (const [value, styled] of values) {
    // Drop token names but keep var() fallbacks, which paint when the token is missing.
    const words = value.replace(/var\(\s*--[\w-]+\s*,?/g, ' ').match(/(?<![\w-])[a-z]+(?![\w-(])/gi) ?? []
    for (const word of words) if (NAMED.has(word.toLowerCase()) && (styled || words.length === 1)) found.push(`named color "${word}" in "${value.trim()}"`)
  }
  return found
}

test('ui/src has no literal colors', () => {
  const found = files(SRC).flatMap(file => literalColors(readFileSync(file, 'utf8'), file.endsWith('.css')).map(f => `${file.slice(SRC.length + 1)}: ${f}`))
  assert.deepEqual(found, [], 'use host tokens or the derived --rk-* tokens in src/theme/tokens.css')
})

test('the guard catches every literal form and allows token derivations', () => {
  const css = `.a { color: #60a5fa; --rk-tone: red; background: rebeccapurple; border-color: color(display-p3 1 0 0);
    outline-color: rgb(0 0 0); fill: oklch(0.5 0.1 10); }`
  assert.equal(literalColors(css, true).length, 6)
  const ok = `.b { color: var(--ui-yellow); --rk-x: oklch(from var(--ui-blue) min(l, 0.6) c h); background: color-mix(in srgb, var(--ui-green) 8%, transparent); border: 1px solid currentColor; text-align: left; display: grid; }`
  assert.deepEqual(literalColors(ok, true), [])
  assert.ok(literalColors(`style={{ '--rk-tone': 'red' }}`, false).length >= 1)
  assert.ok(literalColors(`style={{ border: "1px solid red" }}`, false).length >= 1)
  assert.equal(literalColors(`.a { color: var(--missing, red) }`, true).length, 1)
  assert.deepEqual(literalColors(`const label = 'Gold plan'; const tone = 'var(--rk-agent)'`, false), [])
})

test('derived tokens start from host tokens only', () => {
  const tokens = strip(readFileSync(join(SRC, 'theme', 'tokens.css'), 'utf8'))
  const referenced = [...tokens.matchAll(/var\((--[\w-]+)/g)].map(m => m[1])
  assert.deepEqual(referenced.filter(name => !/^--(?:ui|dt|rk)-|^--foreground$/.test(name)), [])
  // Every derived ink is bounded for readability, and the bounds exist for each surface and mode.
  const derived = [...tokens.matchAll(/(--rk-[\w-]+):\s*oklch\(from[^;]*;/g)]
  assert.ok(derived.length > 0)
  for (const [declaration, name] of derived) assert.match(declaration, /clamp\(var\(--rk-(ink|mark)-lo\), l, var\(--rk-\1-hi\)\)/, name)
  for (const selector of [
    ':root',
    ':root.dark',
    '.rk-card,\n.rk-column-count',
    ':root.dark .rk-card,\n:root.dark .rk-column-count',
    '.rk-view-trigger,\n.rk-view-action,\n.rk-lists-trigger,\n.rk-header [data-rk-new],\n.rk-notice-actions > button,\n.rk-card-actions > button',
    ':root.dark .rk-view-trigger,\n:root.dark .rk-view-action,\n:root.dark .rk-lists-trigger,\n:root.dark .rk-header [data-rk-new],\n:root.dark .rk-notice-actions > button,\n:root.dark .rk-card-actions > button'
  ]) {
    const block = new RegExp(`(^|\\n)${selector.replace(/[.\[\]]/g, '\\$&').replace(/\n/g, '\\n')} \\{([^}]*)\\}`).exec(tokens)?.[2] ?? ''
    for (const bound of ['--rk-ink-lo', '--rk-ink-hi', '--rk-ink-c', '--rk-mark-lo', '--rk-mark-hi']) assert.match(block, new RegExp(`${bound}:`), `${selector} ${bound}`)
  }
})
