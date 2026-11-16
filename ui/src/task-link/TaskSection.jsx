// Desktop entry: the task conversation inside the task dialog, for a reminder whose link (URL field
// or "Open in Hermes:" note) names a Hermes task, or whose delegation row carries the task's stored
// binding (no written link: "Only on this Mac", or not written yet). TaskDialog passes its title,
// meta pills and the reminder's details; this fills the header pill, the body and the composer.
import { host } from '@hermes/plugin-sdk'
import { useMemo } from 'react'

import { pluginContext, request, useScope } from '../api/client.js'
import { bindingDest, claims, hasHermesTask, notesWithoutLink, taskLinkOf } from '../lib/task-link.js'
import { DialogHead, StatusPill } from '../task/shell.jsx'
import { BILLING_ROUTE, REPAIR_ROUTE } from '../recovery/Recovery.jsx'
import { LinkProblem, TaskConversation } from './TaskPanel.jsx'

/** Transport bound to one connection/profile scope; late answers reject as superseded. */
export function desktopApi(scope) {
  return {
    get: path => request(scope, path),
    post: (path, body) => request(scope, path, { method: 'POST', body })
  }
}

/** A card has a Hermes task when its reminder carries the task link, or its own delegation or
 *  occurrence row carries the stored binding (a reminder with no written link). The dialog then
 *  shows the task's own state (the status pill) instead of the reminder's column, and no
 *  human-only actions (Start, Mark done, Edit). Column placement is ticket 13's. */
export { hasHermesTask }

/** The reminder's notes as the dialog shows them: the claim line (the task link, or "In Hermes on
 *  <Mac>") is left out, since the dialog already says whose task it is (the line stays in Apple
 *  Reminders). */
export const taskNotes = source => (taskLinkOf(source) || claims(source?.notes).length ? notesWithoutLink(source.notes) : (source?.notes ?? ''))

/** footer: board actions for this task (ticket 13's Resume / Stop), shown when the
 *  conversation itself has no composer. */
/** occurrence: open this occurrence instead of the task's current one (a repeating reminder's
 *  earlier result). pill: the dialog's status pill when it isn't the task's. earlier: the task is
 *  an earlier occurrence of this reminder. knownLabels, paused, upcoming: what the board knows
 *  about a repeating reminder's occurrences (ticket 21, recurring/dialog.js). */
/** recoveryRow: the task's delegation row, for ticket 17's recovery states (ui/src/recovery/). */
/** binding: the task's stored destination ({ owner_id, link_id, url }) from its delegation or
 *  occurrence row, used when the reminder carries no written link. */
export function TaskSection({ binding = null, foreign = false, details, earlier = false, footer, hold = null, knownLabels = null, meta, occurrence = null, onClose, paused = null, pill, previous = null, queuedLabel, recoveryRow = null, repeating = true, source, title, upcoming = null }) {
  const scope = useScope()
  const dest = useMemo(() => {
    // foreign: the link in the notes is the other Mac's; this Mac's own task is its stored binding.
    const link = (foreign ? null : taskLinkOf(source)) ?? bindingDest(binding, scope[1])
    return link && occurrence ? { ...link, occurrence } : link
  }, [foreign, source?.url, source?.notes, binding?.owner_id, binding?.link_id, binding?.url, occurrence, scope[1]])
  // Open in Hermes goes to the occurrence on screen, not the reminder's newest one. A task with no
  // phone address ("Only on this Mac") has no web page to open, so no button.
  const open = dest?.url
    ? shown => {
        const url = new URL(dest.url)
        if (shown) url.searchParams.set('occurrence', shown)
        void pluginContext()?.os.openExternal(url.toString())
      }
    : undefined
  const api = useMemo(() => desktopApi(scope), [scope[0], scope[1]])
  // Repair sign-in and Open billing close the dialog and open that page of Hermes settings.
  const recovery = useMemo(() => {
    if (!recoveryRow) return null
    const open = route => () => (onClose?.(), host.navigate(route))
    return { row: recoveryRow, onRepair: open(REPAIR_ROUTE), onBilling: open(BILLING_ROUTE) }
  }, [recoveryRow, onClose])
  if (!dest) return null
  // A link minted by another profile must not be resolved through this one.
  if (dest.profile !== scope[1]) {
    return (
      <>
        <DialogHead meta={meta} onClose={onClose} pill={<StatusPill label="Different profile" />} title={title} />
        <div className="rk-task-body">
          <LinkProblem kind="wrong_profile" profile={dest.profile} />
        </div>
      </>
    )
  }
  return (
    <TaskConversation
      api={api}
      autoFocus
      dest={dest}
      details={details}
      earlier={earlier}
      footer={footer}
      hold={hold}
      knownLabels={knownLabels}
      paused={paused}
      previous={previous}
      upcoming={upcoming}
      key={`${dest.owner}/${dest.link}/${dest.occurrence ?? ''}`}
      meta={meta}
      onClose={onClose}
      pill={pill}
      onOpen={open}
      queuedLabel={queuedLabel}
      recovery={recovery}
      repeating={repeating}
      title={title}
    />
  )
}
