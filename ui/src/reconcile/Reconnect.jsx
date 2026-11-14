// What the board's reconnect check found (ticket 25), as one notice under the header, in the
// stale notice's place: "Checking Reminders…" while the owner rereads every delegated reminder,
// then each task that changed meanwhile (deleted, checked off, new instructions, a held identity).
// Open goes to the task's card, or to the task itself when its reminder is gone, so its
// conversation stays reachable. Mounted with one line by the board page.
import {
  Button,
  Codicon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tip
} from '@hermes/plugin-sdk'

import { NOTICES } from '../lib/state.js'
import { defineStyles } from '../styles.js'
import css from './reconcile.css'

defineStyles(css)

/** reconnect: useReconnect's { checking, findings, dismiss }. onOpen(finding) opens that task. */
export function ReconnectNotice({ onOpen, reconnect }) {
  const { checking, findings, dismiss } = reconnect
  // What changed shows as soon as it is observed; the reread may still be running on a long list.
  if (checking && !findings.length) {
    return (
      <div className="rk-notice rk-enter" role="status">
        <Codicon name="loading" size="0.85rem" spinning />
        <span className="rk-notice-text">{NOTICES.checking}</span>
      </div>
    )
  }
  if (!findings.length) return null
  const one = findings.length === 1 ? findings[0] : null
  return (
    <div className="rk-notice rk-enter rk-reconnect" role="status">
      <Codicon name="info" size="0.85rem" />
      <span className="rk-notice-text">
        {one ? (
          <>
            <span className="rk-reconnect-title">{one.title}</span>
            <span className="rk-reconnect-what"> · {one.text}</span>
          </>
        ) : (
          `${findings.length} tasks changed in Reminders`
        )}
      </span>
      <div className="rk-notice-actions">
        {one ? (
          <Button onClick={() => onOpen(one)} size="xs" variant="secondary">
            Open
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button aria-label={`${findings.length} tasks changed in Reminders. Choose a task`} size="xs" variant="secondary">
                <span>Show</span>
                <Codicon name="chevron-down" size="0.7rem" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="rk-attn-menu">
              {findings.map(item => (
                <DropdownMenuItem className="rk-attn-item" key={item.key} onSelect={() => onOpen(item)}>
                  <span className="rk-attn-item-title">{item.title}</span>
                  <span className="rk-attn-item-kind">{item.text}</span>
                  <Codicon aria-hidden className="rk-attn-item-go" name="chevron-right" size="0.75rem" />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Tip label="Dismiss">
          <Button aria-label="Dismiss" onClick={() => (dismiss(), document.querySelector('.rk-lists-trigger')?.focus())} size="icon-xs" variant="ghost">
            <Codicon name="close" size="0.8rem" />
          </Button>
        </Tip>
      </div>
    </div>
  )
}
