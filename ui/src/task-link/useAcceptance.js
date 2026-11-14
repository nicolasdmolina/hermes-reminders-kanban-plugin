import { useRef, useState } from 'react'

import { acceptRequest } from '../lib/occurrences.js'
import { classifyLinkError, submissionOutcome } from '../lib/task-link.js'

// Lives with the conversation: its composer can disappear as soon as Hermes accepts,
// before the slower Reminders completion answers.
export function useAcceptance(api, refresh) {
  const [receipts, setReceipts] = useState({})
  const pending = useRef(new Map())
  const routed = useRef(api)
  routed.current = api

  const accept = async (taskId, known) => {
    if (pending.current.get(taskId) === api) return
    pending.current.set(taskId, api)
    const save = (phase, message) => {
      if (routed.current === api) setReceipts(current => ({ ...current, [taskId]: { api, phase, message } }))
    }
    save('saving', 'Accepted. Saving to Reminders…')
    try {
      const target = await acceptRequest(api, taskId, known)
      if (routed.current !== api) return
      if (!target) {
        save('failed', "Hermes can't find the reminder for this task, so it can't be checked off here.")
        return
      }
      const response = await api.post(...target)
      if (routed.current !== api) return
      const outcome = submissionOutcome(response, 'accept', taskId)
      save(outcome.kind === 'sent' ? 'confirmed' : 'failed', outcome.kind === 'sent' ? 'Reminder checked off' : outcome.message)
      if (outcome.reread) {
        window.dispatchEvent(new CustomEvent('rk:attention-refresh'))
        window.dispatchEvent(new CustomEvent('rk:task-changed'))
        void refresh()
      }
    } catch (error) {
      if (routed.current !== api) return
      save('failed', classifyLinkError(error) === 'sign_in'
        ? 'Sign in to confirm whether the reminder was checked off.'
        : "Couldn't confirm the reminder was checked off. Check its state before trying again.")
      void refresh()
    } finally {
      if (pending.current.get(taskId) === api) pending.current.delete(taskId)
    }
  }

  /** Drops a failed receipt once the user moves on (sends a reply). */
  const clear = taskId => setReceipts(current => (current[taskId]?.phase === 'failed' ? { ...current, [taskId]: undefined } : current))

  return { accept, clear, forTask: taskId => receipts[taskId]?.api === api ? receipts[taskId] : null }
}
