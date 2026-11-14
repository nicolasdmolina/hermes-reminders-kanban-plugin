// Hermes Desktop entry for Reminders Kanban. Built into desktop/plugin.js by ui/build.mjs.
// Register each feature here with one line; keep feature code in its own folder.
import { PALETTE_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA, host } from '@hermes/plugin-sdk'

import { bindClient } from './api/client.js'
import { newReminderCommand } from './editor/command.js'
import { BoardPage } from './page/BoardPage.jsx'
import { startAttention } from './questions/feed.js'
import { installStyles } from './styles.js'

export const ROUTE = '/reminders-kanban'

export default {
  id: 'reminders-kanban',
  name: 'Reminders Kanban',
  defaultEnabled: false,
  register(ctx) {
    ctx.onDispose(bindClient(ctx))
    installStyles(ctx)
    ctx.onDispose(startAttention(ctx, ROUTE))
    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, data: { path: ROUTE }, render: () => <BoardPage /> },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 52,
        data: { path: ROUTE, label: 'Reminders', codicon: 'checklist' }
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'reminders-kanban.open',
          label: 'Open Reminders board',
          keywords: ['reminders', 'kanban', 'board', 'tasks'],
          run: () => host.navigate(ROUTE)
        }
      },
      newReminderCommand(ROUTE)
    ])
  }
}
