// Command palette entry: "New reminder" opens the board with the create form.
import { atom, host, PALETTE_AREA } from '@hermes/plugin-sdk'

/** Counts palette requests; the board opens the create form when it changes. */
export const createRequests = atom(0)

export const newReminderCommand = route => ({
  id: 'new-reminder',
  area: PALETTE_AREA,
  data: {
    id: 'reminders-kanban.new',
    label: 'New reminder',
    keywords: ['reminders', 'create', 'add', 'task'],
    run: () => {
      host.navigate(route)
      createRequests.set(createRequests.get() + 1)
    }
  }
})
