"""Hermes Reminders Kanban plugin package.

Hermes imports enabled plugins from their package root. Backend routes live in
dashboard/plugin_api.py. Unattended passes default on and stop on unload.
"""


def register(ctx):
    import sys
    from pathlib import Path

    root = str(Path(__file__).resolve().parent)
    if root not in sys.path:
        sys.path.insert(0, root)
    from reminders_kanban.runtime import register as register_runtime

    register_runtime(ctx)
