// Plugin CSS. A disk plugin can't rely on the host's compiled Tailwind classes,
// so each feature folder ships a scoped .css file (classes prefixed `rk-`, colors
// from host `var(--ui-*)` tokens and the plugin's derived `--rk-*` tokens in theme/tokens.css)
// and registers it here at import time. The token sheet always mounts first.
import tokens from './theme/tokens.css'

const sheets = [tokens]

export function defineStyles(css) {
  sheets.push(css)
}

/** Mounts every registered sheet; the disposer removes it on unload or hot reload. */
export function installStyles(ctx) {
  const style = document.createElement('style')
  style.dataset.plugin = 'reminders-kanban'
  style.textContent = sheets.join('\n')
  document.head.append(style)
  ctx.onDispose(() => style.remove())
}
