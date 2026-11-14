// The task the dialog's conversation shows, for footer actions that depend on it (ticket 21's
// Run again needs to know whether Hermes ever ran it). TaskConversation provides it.
import { createContext } from 'react'

export const TaskViewContext = createContext(null)
