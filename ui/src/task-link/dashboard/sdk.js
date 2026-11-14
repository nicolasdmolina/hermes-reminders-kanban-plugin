// `@hermes/plugin-sdk` for the browser dashboard bundle: only the primitives the task
// panel uses, as plain elements styled by dashboard.css with the dashboard's own tokens.
import { inlineSpans, markdownBlocks } from '../../lib/markdown-lite.js'
import { createElement as h } from './react.js'

const join = (...names) => names.filter(Boolean).join(' ')

export function Button({ className, size = 'default', variant = 'default', type = 'button', ...props }) {
  return h('button', { ...props, className: join('rk-btn', className), 'data-size': size, 'data-variant': variant, type })
}

export function Badge({ className, variant = 'default', ...props }) {
  return h('span', { ...props, className: join('rk-badge', className), 'data-variant': variant })
}

export function Textarea({ className, ...props }) {
  return h('textarea', { ...props, className: join('rk-input', className) })
}

// The dashboard ships no codicon font: the few icons the panel uses as inline SVG in the codicon
// shapes, drawn in currentColor; any other name renders nothing.
const ICONS = {
  'arrow-up': 'M8 2.6 3.2 7.4l.7.7L7.5 4.5V13.5h1V4.5l3.6 3.6.7-.7L8 2.6Z',
  'chevron-right': 'M5.7 13.7 5 13l5-5-5-5 .7-.7L11.4 8l-5.7 5.7Z',
  'arrow-down': 'M8 13.4 12.8 8.6l-.7-.7L8.5 11.5V2.5h-1v9L3.9 7.9l-.7.7L8 13.4Z',
  'chevron-down': 'M2.3 5.7 3 5l5 5 5-5 .7.7L8 11.4 2.3 5.7Z',
  close: 'm8 8.7 3.9 3.9.7-.7L8.7 8l3.9-3.9-.7-.7L8 7.3 4.1 3.4l-.7.7L7.3 8l-3.9 3.9.7.7L8 8.7Z',
  loading: 'M8 2a6 6 0 1 0 6 6h-1A5 5 0 1 1 8 3V2Z',
  check: 'M6.3 11.9 2.6 8.2l.7-.7 3 3 6.4-6.4.7.7-7.1 7.1Z',
  // The names the panel asks for, in simple 16px shapes: a clock, a ring, a slashed ring, a stop
  // square, pause bars, a calendar, a lock and a magnifier.
  clock: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 1a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Zm-.5 2h1v3.3l2.2 2.2-.7.7-2.5-2.5V4.5Z',
  'circle-large-outline': 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 1a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Z',
  'circle-slash': 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 1a5.5 5.5 0 0 1 4.3 8.9L4.6 3.7A5.5 5.5 0 0 1 8 2.5ZM3.7 4.6l7.7 7.7A5.5 5.5 0 0 1 3.7 4.6Z',
  // The panel asks for the stop square by its codicon name.
  'debug-stop': 'M3.5 3.5h9v9h-9v-9Zm1 1v7h7v-7h-7Z',
  'debug-pause': 'M4.5 3h2v10h-2V3Zm5 0h2v10h-2V3Z',
  calendar: 'M2 3h12v11H2V3Zm1 3v7h10V6H3ZM4.5 1.5h1v2h-1v-2Zm6 0h1v2h-1v-2Z',
  lock: 'M5 7V5a3 3 0 0 1 6 0v2h1.5v7h-9V7H5Zm1 0h4V5a2 2 0 1 0-4 0v2Zm-1.5 1v5h7V8h-7Z',
  search: 'M7 2a5 5 0 1 0 3.1 8.9l3.2 3.2.7-.7-3.2-3.2A5 5 0 0 0 7 2Zm0 1a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z',
  warning:
    'M7.56 1.5h.88l6.54 12.26-.44.74H1.46l-.44-.74L7.56 1.5ZM8 2.72 2.29 13.5h11.42L8 2.72ZM8.5 12v1h-1v-1h1Zm-1-1V6h1v5h-1Z'
}
const ALIASES = { watch: 'clock', 'debug-disconnect': 'circle-slash', remote: 'circle-slash', account: 'lock', extensions: 'warning', link: 'search' }
export function Codicon({ className, name, size = '1rem', spinning }) {
  const d = ICONS[name] ?? ICONS[ALIASES[name]]
  if (!d) return null
  return h(
    'svg',
    { 'aria-hidden': 'true', className: join('rk-dash-icon', className), 'data-spinning': spinning ? 'true' : undefined, fill: 'currentColor', style: { height: size, width: size }, viewBox: '0 0 16 16' },
    h('path', { d, fillRule: 'evenodd' })
  )
}

// The dashboard has no host StatusDot; the same 0.375rem dot from the shared tone tokens.
const DOT_TONES = { good: 'var(--dt-primary)', muted: 'var(--rk-text-tertiary)', warn: 'var(--rk-attention)', bad: 'var(--dt-destructive)' }
export function StatusDot({ className, tone = 'muted', ...props }) {
  return h('span', { ...props, 'aria-hidden': 'true', className: join('rk-dash-dot', className), style: { background: DOT_TONES[tone] } })
}

export function Loader({ className, label = 'Loading' }) {
  return h('span', { className: join('rk-dash-loader', className), role: 'status', 'aria-label': label })
}

// No host Markdown renderer on the dashboard: the shapes a result uses (lib/markdown-lite.js) as
// plain elements. Headings, lists, code, bold, italic and links; anything else stays text.
const spans = text =>
  inlineSpans(text).map((span, index) => {
    const inner = span.href ? h('a', { href: span.href, rel: 'noopener noreferrer', target: '_blank' }, span.label) : span.code != null ? h('code', null, span.code) : span.text
    return span.bold ? h('strong', { key: index }, inner) : span.italic ? h('em', { key: index }, inner) : typeof inner === 'string' ? inner : h('span', { key: index }, inner)
  })
export function MessageTextContent({ text }) {
  return h(
    'div',
    { className: 'aui-md rk-dash-md' },
    ...markdownBlocks(text).map((block, index) =>
      block.type === 'pre'
        ? h('pre', { key: index }, block.text)
        : block.type === 'ul' || block.type === 'ol'
          ? h(block.type, { key: index, start: block.start }, ...block.items.map((item, at) => h('li', { key: at }, ...spans(item))))
          : h(block.type === 'h' ? 'h3' : 'p', { key: index }, ...spans(block.text))
    )
  )
}

export function Tip({ children }) {
  return children
}

// No host GlyphSpinner on the dashboard: one still braille cell in the same box.
export function GlyphSpinner({ ariaLabel = 'Loading', className }) {
  return h('span', { 'aria-label': ariaLabel, className: join('rk-dash-glyph-spinner', className), role: 'img' }, '\u2802')
}
