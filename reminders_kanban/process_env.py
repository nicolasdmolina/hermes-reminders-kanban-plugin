"""Least-privilege environments for local helper and setup commands.

Hermes may hold provider credentials in its environment. Never forward that
mapping wholesale, even to local tools; each child receives only what it needs.
"""

from __future__ import annotations

import os

_BASE_KEYS = ("PATH", "HOME", "TMPDIR", "DEVELOPER_DIR")
_OVERRIDE_KEYS = frozenset((*_BASE_KEYS, "RK_MACOS_TARGET", "RK_COMPILE_ONLY",
                            "RK_SIGNING_IDENTITY", "RK_ARCHIVE_PASSPHRASE", "HERMES_HOME"))


def child_env(**overrides: str) -> dict[str, str]:
    """Copy only platform essentials, then explicit per-command inputs.

    RK values and the Hermes profile selector are never inherited implicitly.
    Unknown overrides fail closed so a future caller cannot forward os.environ.
    """
    unknown = overrides.keys() - _OVERRIDE_KEYS
    if unknown:
        raise ValueError("Unsupported child environment keys: " + ", ".join(sorted(unknown)))
    env = {key: os.environ[key] for key in _BASE_KEYS if key in os.environ}
    env.setdefault("PATH", os.defpath)
    env.update(overrides)
    return env
