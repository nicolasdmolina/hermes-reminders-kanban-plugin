# Install the experimental preview

This preview includes the source and a built plugin package. Fresh-account signing and permission recovery remain unverified. Browsing and editing require the native helper and macOS consent.

## Check prerequisites

Use macOS 14 or later with Hermes Desktop and Xcode command-line tools. Run `xcode-select --install` if `swiftc` is unavailable. Use Hermes 0.23.1 or later. The plugin declares that minimum, and Hermes refuses to load it on older versions.

Delegation needs a running Hermes gateway for the profile and uses Hermes' scheduled jobs. Each delegated run is one job named `Reminders: <task>`, removed when the run ends. It runs on the profile's main model under `approvals.cron_mode` (default: approval-gated commands are refused). No Hermes configuration change is needed.

The release repository contains source at its root and the built package under `plugin/`. Hermes must load the package directory containing `plugin.yaml`, `desktop/plugin.js`, and `dashboard/plugin_api.py`. Do not install the development root, which contains a `pyproject.toml` for source tests.

Install from the Hermes plugin catalog, which pins the reviewed commit:

```sh
hermes plugins install reminders-kanban --enable
hermes plugins doctor reminders-kanban
```

To install a specific GitHub release instead, copy the exact command from its release notes. It pins a full commit SHA and selects the package subdirectory. The command has this form:

```sh
hermes plugins install 'nicolasdmolina/hermes-reminders-kanban-plugin#plugin' --ref <full-release-commit-sha> --enable --yes-deps
hermes plugins doctor reminders-kanban
```

Replace `<full-release-commit-sha>` with the published release's full 40-character commit SHA. Enable the Desktop half in **Capabilities > Plugins**. Rescan if the Desktop bundle has not appeared.

## Allow the native helper

Open the Reminders board and click **Set up Reminders access**. The beta checks Apple developer tools, provisions a new per-user code-signing identity when needed, and builds the Swift helper on your Mac. The identity uses user-domain trust for code signing. Setup does not change system trust or Gatekeeper.

If developer tools are missing, click **Install Apple tools** and complete Apple's installer. Return to the board and click **Check again**. Approve macOS Keychain consent when requested. The signing private key stays on your Mac.

Approve the macOS Reminders prompt when the helper requests access. If access was denied, allow **RK Reminders Helper** in **System Settings > Privacy & Security > Reminders**, then click **Check again**. A locked Mac can prevent the helper from completing an access request. Unlock the Mac before retrying.

Select your lists and review their reminders before enabling pickup.

The first setup on a clean account and permission persistence after a helper rebuild require real-device verification. A successful compile or an existing account's permission grant does not establish those checks.

## Keep background work under your control

Keep the owning Hermes gateway running for background work. Closing the board does not stop the gateway. Work runs through Hermes' own scheduled jobs; the plugin launches no other agent process. If Hermes restarts during a run, the run is left alone for up to two hours, then marked failed; it is never started again by itself.

Pickup activation is separate from plugin enablement. Turning pickup off stops new automatic starts. It retains existing task state so that you can review, answer, or stop work already created.

To stop background passes entirely, disable the plugin. Administrators can also set `plugins.entries.reminders-kanban.settings.unattended` to `false` and reload the plugin. Preserve unrelated plugin settings.

## Use task links on another device

Local task review works without a public address. For links that open from another device, configure an authenticated HTTPS address for the Hermes dashboard and verify it from that device. The dashboard must serve the plugin page as well as the API.

Setup can use an existing Tailscale installation to configure a private HTTPS Serve route after you apply that option. It can also save your own dashboard address. Configuration changes keep a local backup. The plugin does not configure public Internet routing or host a dashboard for you. Do not put passwords or access tokens into reminder URLs. Existing task links keep their original address, so review address changes before applying them.

## Build your own package

From the editable source root, run:

```sh
scripts/package-plugin --build /absolute/path/to/a-new-plugin-directory
```

The command installs UI build dependencies, builds both bundles, and creates a new runtime directory. On macOS it also prepares a signed helper using this Mac's existing signing identity, so a background gateway can use it without accessing the signing key. Run this command in the logged-in user session after setting up Reminders access. A signing failure stops the command.

This locally signed package is for this Mac only. Do not publish or redistribute it. For a portable source package, use the public export described in the [development guide](development.md). The exporter includes Swift sources and builds the helper on each user's Mac instead.

The helper cache key includes its native sources, signing identity, and any custom macOS deployment target. Changing them requires a new prepared package. Build failures appear as recoverable errors; the gateway log keeps the compiler or signing diagnostic.

The command refuses to overwrite an existing directory. `--backend-only` is for integration proofs and is not an installable release.

Read the [development guide](development.md) to prepare a clean public source snapshot and verify its package.
