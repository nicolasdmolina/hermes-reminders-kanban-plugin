"""Snapshot reads and fixture-only preserving write proof. See CONTRACT.md."""

from __future__ import annotations

import fcntl
import tempfile
from pathlib import Path
from typing import Any

from . import helper

# Ticket 01 must use this same owning-integration lock when integrating writes.
WRITE_LOCK = Path(tempfile.gettempdir()) / "reminders-kanban-writes.lock"


def action(op: str, **fields: Any) -> dict[str, Any]:
    """Return a renderable outcome; never automatically retry a write.

    Write callers supply proofToken while release preservation gaps remain.
    read/read_many are unrestricted and never enable agent pickup.
    """
    if op not in {"read", "read_many", "create", "edit", "rk02_retire"}:
        return {"outcome": "bad_request", "message": "Unsupported action"}
    try:
        if op in {"create", "edit", "rk02_retire"}:
            with WRITE_LOCK.open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                result = helper.run(op, **fields)
        else:
            result = helper.run(op, **fields)
        return {"outcome": "ok", "result": result}
    except helper.HelperError as exc:
        return {"outcome": exc.code, "message": exc.message, "current": exc.current}
