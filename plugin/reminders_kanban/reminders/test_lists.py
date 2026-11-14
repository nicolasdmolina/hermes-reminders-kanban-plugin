"""Temporary proof lists. Serialize proof owners across worktrees on this Mac."""

import argparse
import fcntl
import json
import os
from contextlib import contextmanager
from pathlib import Path

from . import helper

TITLES = ("RK Test", "RK Test 2")
LEASE_DIR = Path.home() / "Library/Caches/reminders-kanban/test-lists"


def lifecycle(action, owner=None):
    owner = os.getpid() if owner is None else owner
    LEASE_DIR.mkdir(parents=True, exist_ok=True)
    with (LEASE_DIR / "lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        lease = LEASE_DIR / "owner.json"
        previous = json.loads(lease.read_text()) if lease.exists() else None
        if previous is not None and previous != owner:
            try:
                os.kill(previous, 0)
            except ProcessLookupError:
                pass
            else:
                raise RuntimeError(f"Temporary Reminders lists are in use by process {previous}")
        if action == "setup":
            # Probe permission before any write. Record ownership before setup for crash recovery.
            helper.run("lists")
            lease.write_text(json.dumps(owner))
        result = helper.run("test-lists", action=action)
        if action == "teardown":
            lease.unlink(missing_ok=True)
        return result


@contextmanager
def proof_lists():
    inherited = os.environ.get("RK_TEST_LIST_OWNER")
    owner = int(inherited) if inherited else os.getpid()
    try:
        lifecycle("setup", owner)
        yield
    finally:
        if not inherited:
            lifecycle("teardown", owner)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["setup", "teardown"])
    parser.add_argument("--owner", type=int, required=True, help="PID of the owning proof process")
    args = parser.parse_args()
    lifecycle(args.action, args.owner)
