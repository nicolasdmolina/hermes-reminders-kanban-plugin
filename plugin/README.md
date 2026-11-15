# Hermes Reminders Kanban

Apple Reminders as a Kanban board inside Hermes Desktop. Keep personal tasks and delegated work together, with changes saved back to Reminders.

![Reminders board in Hermes Desktop with demo tasks](docs/media/board.png)

The current board with synthetic demo tasks in an isolated Hermes Desktop session. Pickup is unavailable on this host. This image does not demonstrate real Reminders sync or agent execution.

The board has To do, Ready for Agent, In progress, Needs you, and Done columns. You can edit titles, notes, due dates, priorities, and lists. Filters separate personal and delegated tasks, and recurring and one-off reminders. Title labels such as `[Agent · Ready]` are editable text markers, not native Reminders tags.

## Experimental preview

This is an experimental macOS preview for developers and early testers. Fresh-account setup and the public Hermes execution integration are not yet verified. It requires macOS 14 or later, Xcode command-line tools, and Hermes Desktop. The helper is compiled locally and needs a persistent local code-signing identity and your Reminders permission. **Set up Reminders access** starts that local setup after your click and retains macOS consent prompts.

Reminder browsing and editing use the native EventKit helper. The public release requires a supported board-scoped execution interface in Hermes. The development execution bridge and task-link authentication use private host interfaces; execution also depends on a legacy configuration. Hermes updates can break those interfaces. Its migration is awaiting maintainer agreement. This is not a supported public execution release. Do not change global dispatcher settings to bypass the compatibility check.

The source implements questions, result review, retry, task links, and delegation for one occurrence or each due occurrence. Those execution flows require the compatible host. Source tests and a compiled package do not prove that a new Mac can complete setup or execute work. Fresh-account setup, the released host capability, and cross-device task links remain release checks.

## Install

Requires Hermes 0.23.1 or later. Install from the Hermes plugin catalog:

```sh
hermes plugins install reminders-kanban --enable
```

Read the [installation guide](docs/installation.md) for prerequisites, local helper setup, and host compatibility. To install straight from GitHub, use the pinned command in the release notes. The installable package is the `plugin/` subdirectory of this repository; the repository root contains editable source and development dependencies.

## Data and background work

You choose the Reminders lists shown on the board. Human tasks are not eligible for agent pickup. Explicit delegation and activation authorize new work. Existing Ready labels appear in the setup preview before pickup is enabled.

The plugin stores task bindings, settings, and execution state in the local Hermes profile. It uses a native helper to read and write Apple Reminders. Reminders may sync through your Apple account. Delegated task content goes to Hermes and its configured model provider. The plugin adds no separate hosted service or telemetry endpoint. It runs local Swift compilation, code signing, and helper launches. Task-link setup checks the dashboard and installed Tailscale status. An explicit setup action can back up and update Hermes configuration or add a private Tailscale Serve route.

While enabled in a running gateway, the plugin checks work in the background every five seconds. One profile owner performs the passes. Turning pickup off stops new automatic starts while existing work can still be observed and reviewed. Disabling the plugin stops its background timer. Closing the board does not stop the gateway.

Local task review does not require a public address. Cross-device task links require your own reachable, authenticated HTTPS Hermes dashboard. The plugin does not provision public hosting. Links contain task identifiers, not authentication tokens.

## Limits

- Hermes is the only execution agent. Per-task agent selection is not supported.
- Repeat schedules, subtasks, and attachments are edited in Apple Reminders.
- An accepted result completes the reminder. Finishing agent work alone does not mark it complete.
- A running, compatible owning gateway is required for background work. Opening a task link on another device does not transfer execution.
- Use one execution Mac during this preview. Two independent Macs can briefly start the same reminder before iCloud syncs their claims. A claim write can also conflict with a phone note edit that has not synced yet. Real iCloud coordination remains unverified.
- Permission denial, an unavailable helper, or an incompatible host needs attention before affected operations can continue.

Read the [development guide](docs/development.md) to build, test, and reproduce the installable package. The project uses the [MIT license](LICENSE), with [third-party notices](THIRD_PARTY_NOTICES.md) for adapted icons.
