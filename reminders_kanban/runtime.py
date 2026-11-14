"""One profile-bound timer for the existing bounded owner admission passes."""

import contextvars
import fcntl
import hashlib
import json
import os
import threading
import time
from pathlib import Path

NAME = "reminders-kanban"


def board_for(home):
    # Hermes Kanban boards are shared across profiles, unlike our state stores.
    # Keep the existing default board and give each named profile its own board.
    home = Path(home).resolve()
    return (
        NAME
        if home.parent.name != "profiles"
        else (NAME + "-" + hashlib.sha256(str(home).encode()).hexdigest()[:12])
    )


def ensure_board(home):
    from hermes_cli import kanban_db as kb

    board = board_for(home)
    if not kb.kanban_db_path(board=board).exists():
        if kb.read_board_metadata(board).get("archived"):
            raise ValueError("plugin board is archived")
        kb.create_board(board)
    return board


def permitted(config):
    plugins = config.get("plugins") or {}
    settings = ((plugins.get("entries") or {}).get(NAME) or {}).get("settings") or {}
    return (
        NAME in plugins.get("enabled", [])
        and NAME not in plugins.get("disabled", [])
        and settings.get("unattended", True) is True
    )


def owner_tick(home):
    from agent.secret_scope import build_profile_secret_scope, reset_secret_scope, set_secret_scope

    from reminders_kanban.api.delegation import service as one_off
    from reminders_kanban.api.occurrence import service as recurring

    token = set_secret_scope(build_profile_secret_scope(home), profile_home=str(home))
    try:
        results = {}
        for name, factory in (("one_off", one_off), ("recurring", recurring)):
            try:
                owner = factory(home)
                result = owner.apply("tick") if owner else {"status": "setup_required"}
                results[name] = result["status"]
            except Exception as exc:
                results[name] = {"status": "failed", "error_type": type(exc).__name__}
        return results
    finally:
        reset_secret_scope(token)


class Ticker:
    def __init__(self, home, config, tick=owner_tick, interval=5):
        self.home = Path(home)
        self.config, self.tick, self.interval = config, tick, interval
        self.stopped = threading.Event()
        context = contextvars.copy_context()
        self.thread = threading.Thread(
            target=lambda: context.run(self.run), name="reminders-kanban-ticks", daemon=True
        )

    def start(self):
        self.thread.start()

    def stop(self):
        self.stopped.set()
        self.thread.join()  # unload waits for an already-issued owner pass to finish

    def run(self):
        directory = self.home / NAME
        directory.mkdir(parents=True, exist_ok=True)
        # CLI, workers and backend can all register the plugin. Only one process
        # owns the timer; process exit releases the lock without stale PID recovery.
        with (directory / "ticker.lock").open("a") as lock:
            while not self.stopped.is_set():
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if self.stopped.wait(self.interval):
                        return
            count = 0
            while not self.stopped.is_set():
                try:
                    if not permitted(self.config()):
                        return
                    result = self.tick(self.home)
                except Exception as exc:
                    # Keep the timer recoverable after permission/connection failures.
                    result = {"status": "failed", "error_type": type(exc).__name__}
                count += 1
                pending = directory / f"runtime-{os.getpid()}.tmp"
                pending.write_text(
                    json.dumps(
                        dict(pid=os.getpid(), ticks=count, observed_at=time.time(), result=result)
                    )
                )
                pending.replace(directory / "runtime.json")
                self.stopped.wait(self.interval)


def register(ctx):
    from hermes_cli.config import load_config_readonly
    from hermes_constants import get_hermes_home

    if os.environ.get("HERMES_SESSION_SOURCE") == "kanban" or not permitted(load_config_readonly()):
        return
    ticker = Ticker(get_hermes_home().resolve(), load_config_readonly)
    ctx.on_unload(ticker.stop)
    ticker.start()
