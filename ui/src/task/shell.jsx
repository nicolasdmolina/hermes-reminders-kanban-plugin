// The one dialog look every task shares (design option A, "Conversation"): a status pill with the
// header actions on the right, the title, a row of meta pills, then a hairline. Used by the Desktop
// task dialog for plain reminders and Hermes tasks alike, and by the browser task page. Plain
// elements plus SDK Button/Codicon, so the browser page renders it through its SDK shim.
import { Button, Codicon, StatusDot } from '@hermes/plugin-sdk'

import { defineStyles } from '../styles.js'
import css from './task.css'

defineStyles(css)

// The dot reads like Hermes' session dots (SessionStatusDot / StatusDot): amber when it needs you,
// accent while working, success when done, destructive when it stopped, muted while waiting.
const HOST_DOT = { attention: 'warn', danger: 'bad', muted: 'muted' }

/** tone: attention | active | danger | done | agent | muted */
export function StatusPill({ label, tone = 'muted' }) {
  return (
    <span className="rk-pill" data-tone={tone}>
      {HOST_DOT[tone] ? (
        <StatusDot className="rk-pill-host-dot" tone={HOST_DOT[tone]} />
      ) : (
        <span aria-hidden className="rk-pill-dot" data-state={tone} />
      )}
      {label}
    </span>
  )
}

/** items: [{ label, tone? }]; empty labels are skipped. */
export function MetaPills({ items }) {
  const shown = items.filter(item => item?.label)
  if (!shown.length) return null
  return (
    <div className="rk-meta-pills">
      {shown.map((item, index) => (
        <span className="rk-meta-pill" data-tone={item.tone} key={index}>
          {item.sr && <span className="rk-sr">{item.sr} </span>}
          {item.label}
        </span>
      ))}
    </div>
  )
}

/** pill: <StatusPill/>; end: actions before the close button; title: the host's heading element. */
export function DialogHead({ end, meta, onClose, pill, title }) {
  return (
    <>
      <header className="rk-head">
        <div className="rk-head-bar">
          {pill}
          <div className="rk-head-end">
            {end}
            {onClose && (
              <Button aria-label="Close" onClick={onClose} size="icon-xs" type="button" variant="ghost">
                <Codicon name="close" />
              </Button>
            )}
          </div>
        </div>
        {title}
        {meta}
      </header>
      <div aria-hidden className="rk-hairline" />
    </>
  )
}
