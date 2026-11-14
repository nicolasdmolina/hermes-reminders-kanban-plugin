# Install the experimental preview

This preview includes the source and a built plugin package. Fresh-account signing and permission recovery remain unverified. Normal released Hermes setups cannot delegate through this plugin yet; browsing and editing require the native helper and macOS consent.

## Check prerequisites

Use macOS 14 or later with Hermes Desktop and Xcode command-line tools. Run `xcode-select --install` if `swiftc` is unavailable. Installation and Desktop checks for this preview use Hermes source revision `2a47b7e2f12e650df6d5d10ed390d736b4891d09`. Other host revisions require their own compatibility checks.

Delegation needs a Hermes release with board-scoped execution support. That capability is not in the released host yet. Until a compatible host is available, treat delegation as unavailable. Changing global Kanban dispatcher settings is not a supported installation step.

The release repository contains source at its root and the built package under `plugin/`. Hermes must load the package directory containing `plugin.yaml`, `desktop/plugin.js`, and `dashboard/plugin_api.py`. Do not install the development root, which contains a `pyproject.toml` for source tests.

Copy the exact install command from the GitHub release notes. It pins a full commit SHA and selects the package subdirectory. The command has this form:

```sh
hermes plugins install 'nicolasdmolina/hermes-reminders-kanban-plugin#plugin' --ref <full-release-commit-sha> --enable --yes-deps
hermes plugins doctor reminders-kanban
```

Replace `<full-release-commit-sha>` with the published release's full 40-character commit SHA. The command requires a Hermes version that supports repository subdirectories. This preview is distributed directly from GitHub. Catalog submission is pending the supported Hermes integration. Enable the Desktop half in **Capabilities > Plugins**. Rescan if the Desktop bundle has not appeared.

## Allow the native helper

Open the Reminders board and click **Set up Reminders access**. The beta checks Apple developer tools, provisions a new per-user code-signing identity when needed, and builds the Swift helper on your Mac. The identity uses user-domain trust for code signing. Setup does not change system trust or Gatekeeper.

If developer tools are missing, click **Install Apple tools** and complete Apple's installer. Return to the board and click **Check again**. Approve macOS Keychain consent when requested. The signing private key stays on your Mac.

Approve the macOS Reminders prompt when the helper requests access. If access was denied, allow **RK Reminders Helper** in **System Settings > Privacy & Security > Reminders**, then click **Check again**. A locked Mac can prevent the helper from completing an access request. Unlock the Mac before retrying.

Select your lists and review their reminders before enabling pickup. Do not activate delegated work until the board reports that its execution host is compatible.

The first setup on a clean account and permission persistence after a helper rebuild require real-device verification. A successful compile or an existing account's permission grant does not establish those checks.

## Keep background work under your control

Keep the owning Hermes gateway running for background work. Closing the board does not stop the gateway. The plugin uses the gateway's existing execution mechanism and does not launch another dispatcher.

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
