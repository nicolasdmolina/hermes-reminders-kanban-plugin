"""Ordered, bounded starts for the plugin's own task store. See admission.md."""

import fcntl
import json
from contextlib import contextmanager
from pathlib import Path

from reminders_kanban.execution import TaskControl, UnsupportedControl, board
from reminders_kanban.execution.runner import Backend, Runner

DEFAULT_MAXIMUM = 3


def profile_for(home):
    home = Path(home)
    return home.name if home.parent.name == "profiles" else "default"


class Admission:
    """One profile's store. All lifecycle callers must use ``serialized``.

    The lock file sits beside the store, so separate processes (the gateway's timer, dashboard
    routes, a scheduled run handing back) share ordering, settings and one start at a time.
    """

    def __init__(self, home, *, cron=None):
        from reminders_kanban.runtime import board_for

        self.home = Path(home)
        self.board = board_for(home)
        self.profile = profile_for(home)
        self.path = board.path_for(home)
        self.runner = Runner(self.path, cron)
        self.kb = Backend(self.runner)

    @staticmethod
    def _tables(conn):
        conn.execute("CREATE TABLE IF NOT EXISTS rk_admission ("
                     "task_id TEXT PRIMARY KEY, sequence INTEGER, resources TEXT, "
                     "park_event INTEGER)")
        conn.execute("CREATE TABLE IF NOT EXISTS rk_settings (key TEXT PRIMARY KEY, value INTEGER)")

    @contextmanager
    def serialized(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(str(self.path) + ".rk-admission.lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with board.connect_closing(self.path) as conn:
                self._tables(conn)
                yield conn

    @contextmanager
    def reading(self):
        """Observe committed state without waiting on a source-check pass."""
        with board.connect_closing(self.path) as conn:
            self._tables(conn)
            conn.execute("PRAGMA query_only=ON")
            conn.execute("BEGIN")
            try:
                yield conn
            finally:
                conn.execute("ROLLBACK")

    def _maximum(self, conn):
        row = conn.execute("SELECT value FROM rk_settings WHERE key='maximum'").fetchone()
        return row[0] if row else DEFAULT_MAXIMUM

    def set_maximum(self, maximum):
        if maximum is not None and (type(maximum) is not int or maximum < 1):
            raise ValueError("maximum must be a positive integer or None for the default")
        with self.serialized() as conn, board.write_txn(conn):
            if maximum is None:
                conn.execute("DELETE FROM rk_settings WHERE key='maximum'")
            else:
                conn.execute("INSERT OR REPLACE INTO rk_settings VALUES ('maximum', ?)", (maximum,))

    def hold(self, conn, task_id):
        """Register preparation without granting a start; caller holds serialized()."""
        task = board.get_task(conn, task_id)
        if task.status in {"ready", "todo"}:
            board.schedule_task(conn, task_id)
        with board.write_txn(conn):
            conn.execute("INSERT OR REPLACE INTO rk_admission VALUES (?, NULL, '[]', NULL)",
                         (task_id,))

    def pause(self, task_id):
        """Revoke queued admission before stopping the run."""
        with self.serialized() as conn:
            with board.write_txn(conn):
                conn.execute("UPDATE rk_admission SET park_event=NULL WHERE task_id=?", (task_id,))
            return TaskControl(conn, self.kb).pause(task_id)

    def ready(self, task_id, *, resources=()):
        """Record a deliberate Ready action, parked until admission.

        Resource keys must include known shared accounts/services as well as paths.
        Repeating Ready while already queued preserves its original position.
        """
        resources = sorted(set(resources))
        if any(not isinstance(key, str) or not key.strip() for key in resources):
            raise ValueError("resource keys must be nonempty strings")
        with self.serialized() as conn:
            task = board.get_task(conn, task_id)
            if task is None:
                raise KeyError(task_id)
            if self._parked(conn, task):
                return
            if task.status not in {"ready", "todo"}:
                raise UnsupportedControl("Ready requires an eligible task")
            if not TaskControl(conn, self.kb)._workers_stopped(task_id):
                raise UnsupportedControl("previous worker has not stopped")
            keys = set(resources)
            if task.workspace_kind == "dir" and task.workspace_path:
                keys.add("workspace:" + str(Path(task.workspace_path).resolve()))
            with board.write_txn(conn):
                seq = conn.execute(
                    "SELECT coalesce(max(sequence), 0)+1 FROM rk_admission").fetchone()[0]
                conn.execute("INSERT OR REPLACE INTO rk_admission VALUES (?, ?, ?, NULL)",
                             (task_id, seq, json.dumps(sorted(keys))))
            self._park(conn, task_id)

    def _park(self, conn, task_id):
        if board.schedule_task(conn, task_id):
            event = board.list_events(conn, task_id)[-1]
            with board.write_txn(conn):
                conn.execute("UPDATE rk_admission SET park_event=? WHERE task_id=?",
                             (event.id, task_id))

    def _parked(self, conn, task):
        events = [e for e in board.list_events(conn, task.id) if e.kind == "scheduled"]
        row = conn.execute("SELECT park_event FROM rk_admission WHERE task_id=?",
                           (task.id,)).fetchone()
        return (task.status == "scheduled" and bool(events) and row is not None
                and events[-1].id == row[0])

    def _snapshot(self, conn):
        maximum = self._maximum(conn)
        control = TaskControl(conn, self.kb)
        tasks = {t.id: t for t in board.list_tasks(conn, include_archived=True)}
        rows = conn.execute("SELECT * FROM rk_admission ORDER BY sequence, task_id").fetchall()
        known = {r["task_id"] for r in rows}
        if any(t.id not in known and t.status != "archived" for t in tasks.values()):
            raise UnsupportedControl("store contains unregistered tasks; admission refused")
        running = sum(t.status == "running" for t in tasks.values())
        occupied = set()
        for row in rows:
            task = tasks.get(row["task_id"])
            if task and (task.status == "running" or not control._workers_stopped(task.id)):
                occupied.update(json.loads(row["resources"]))
        queue = []
        for row in rows:
            task = tasks.get(row["task_id"])
            if not task or not (self._parked(conn, task) or task.status in {"ready", "todo"}):
                continue
            reason = None
            if not control._workers_stopped(task.id):
                reason = "worker_still_alive"
            elif occupied.intersection(json.loads(row["resources"])):
                reason = "resource_busy"
            elif running >= maximum:
                reason = "board_capacity"
            queue.append({"task_id": task.id, "reason": reason})
        return {"board_maximum": maximum, "effective_limit": maximum, "running": running,
                "other_boards_running": 0, "queue": queue}

    def observe(self):
        with self.reading() as conn:
            return self._snapshot(conn)

    def admit(self, *, before_dispatch=None):
        """One bounded pass: settle finished runs, then start queued tasks up to the maximum."""
        with self.serialized() as conn:
            self._snapshot(conn)  # fail closed before changing anything
            self.runner.reconcile(conn)
            for task in board.list_tasks(conn):
                if task.status in {"ready", "todo"}:
                    self._park(conn, task.id)
            started, attempted = [], set()
            while True:
                snapshot = self._snapshot(conn)
                candidate = next((q for q in snapshot["queue"] if q["reason"] is None
                                  and q["task_id"] not in attempted), None)
                if not candidate:
                    break
                task_id = candidate["task_id"]
                attempted.add(task_id)
                if before_dispatch is not None and not before_dispatch(conn, task_id):
                    continue
                board.unblock_task(conn, task_id)
                run_id = self.runner.start(conn, task_id, self.profile)
                if run_id is None:
                    self._park(conn, task_id)
                    continue
                started.append({"task_id": task_id, "run_id": run_id})
            return {**self._snapshot(conn), "started": started}
