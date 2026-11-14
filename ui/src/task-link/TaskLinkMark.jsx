// Board entry point: a small marker on a card whose reminder carries a Hermes task link.
// Self-contained so the tile meta row mounts it with one line. Its .rk-tl-mark style lives in
// task-link.css, which TaskPanel.jsx registers (always part of the plugin bundle).
import { Codicon, Tip } from '@hermes/plugin-sdk'

import { cardBinding, taskLinkOf } from '../lib/task-link.js'

/** card: the board card, so a task whose link line was taken off the reminder again (stopped, or
 *  finished and reopened: the reminder is yours, and the other Mac must not read it as taken)
 *  keeps its mark from the link stored with its task. */
export function TaskLinkMark({ card = null, source }) {
  if (!taskLinkOf(source) && !cardBinding(card)?.url) return null
  return (
    <Tip label="Linked to a Hermes task">
      <span aria-label="Hermes task" className="rk-tl-mark" role="img">
        <Codicon name="comment-discussion" size="0.625rem" />
      </span>
    </Tip>
  )
}
