"""Backend routes for /api/plugins/reminders-kanban/.

Hermes loads this file by path with no package context, so the plugin root is
added to sys.path before importing the core package.
"""

import sys
from pathlib import Path

_PLUGIN_ROOT = str(Path(__file__).resolve().parent.parent)
if _PLUGIN_ROOT not in sys.path:
    sys.path.insert(0, _PLUGIN_ROOT)

from reminders_kanban.api import router  # noqa: E402

__all__ = ["router"]
