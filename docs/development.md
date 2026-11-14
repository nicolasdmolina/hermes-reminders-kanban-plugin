# Build and verify a public release

## Run source checks

Use Python 3.11 through 3.14, uv, and Node.js 22. From the source root, run:

```sh
uv sync --locked
uv run ruff check .
uv run pytest
cd ui
npm ci
npm run check
```

The UI check builds `desktop/plugin.js` and `dashboard/dist/index.js`. It rejects unsupported Desktop imports and runs the UI tests. On macOS, compile the native helper without signing for a compile check:

```sh
RK_COMPILE_ONLY=1 native/reminders-helper/build.sh /absolute/path/to/a-new-build-directory
```

Do not launch that unsigned compile artifact to test Reminders permission.

## Export editable sources and a complete plugin

From the private development checkout, run:

```sh
scripts/prepare-public-release /absolute/path/to/a-new-public-snapshot
```

The destination must be new and outside the checkout. The command exports an explicit allowlist, builds the UI from the exported sources, and stages a complete `plugin/` directory. It does not copy Git history or publish anything.

The source export includes Python, Swift, UI sources, lockfiles, automated tests, build scripts, public documentation, and the CI workflow. It excludes private planning, agent instructions, local installation receipts, and machine-specific proof harnesses. Live-only tests are excluded. Default source checks run without the private proof artifacts. Host and real Reminders integration proofs remain separate release requirements.

The runtime directory includes the Python backend, native helper sources and build script, both generated bundles, public documentation, and the license. It excludes development dependencies, source tests, and `pyproject.toml`. The public snapshot retains editable sources alongside that directory.

If a real board screenshot is approved for publication, save it as `docs/media/board.png` and add its reference to the README before exporting. The exporter includes that exact optional image. Do not substitute a mock image for product evidence.

## Check that the package matches the sources

From the public snapshot root, run:

```sh
cd ui
npm ci
npm run check
cd ..
python3 scripts/package-plugin --check plugin
```

The check compares the full runtime file set and file bytes with the freshly built sources. It rejects missing, modified, extra, or symlinked files. Package content has no generated timestamps. The `plugin/` directory is excluded from source discovery, so rebuilding never produces `plugin/plugin/`.

To inspect a separate rebuild, run:

```sh
python3 scripts/package-plugin /absolute/path/to/a-new-package
python3 scripts/package-plugin --check /absolute/path/to/a-new-package
```

The CI workflow runs source tests, UI checks, native compilation, and the package comparison. It uploads the installable package after successful checks. This verifies reproducibility. Reminders permission, cross-device access, and agent execution on a released Hermes host need separate live checks.

## Publish a reviewed snapshot

Create the public repository from the exported directory with a new Git history. Keep the private development history private. Review the exported files before publishing. Mark experimental snapshots as prereleases and list their unfinished live checks. A stable release needs fresh-account setup, real-device sync, and supported host execution proof.

The intended repository name is `nicolasdmolina/hermes-reminders-kanban-plugin`. Its catalog package path is `plugin`. Repository creation and catalog publication are separate actions from source preparation.
