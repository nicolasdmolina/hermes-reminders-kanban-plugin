"""Scoped admission using the installed owner, with no independent worker runner."""

import fcntl
import json
from contextlib import contextmanager
from dataclasses import asdict

from reminders_kanban.execution import TaskControl, UnsupportedControl, UnsupportedHost


def positive(value):
    try:
        return int(value) if not isinstance(value, bool) and int(value) > 0 else None
    except (ValueError, TypeError):
        return None


class Admission:
    """Exclusive plugin board. All lifecycle callers must use ``serialized``.

    Metadata lives with its owner database, so separate processes share ordering,
    settings and the advisory lock. Existing host tables and global config are unchanged.
    """

    def __init__(self, board):
        from hermes_cli import kanban_db as kb
        from hermes_cli import kanban_db_connect as connect
        from hermes_cli import kanban_db_dispatch as dispatch
        from hermes_cli.config import load_config_readonly

        if not board or board == kb.DEFAULT_BOARD:
            raise ValueError("an explicit non-default plugin board is required")
        self.board, self.kb, self.dispatch = board, kb, dispatch
        self.path = kb.kanban_db_path(board=board)
        if self.path.resolve() == kb.kanban_db_path(board=kb.DEFAULT_BOARD).resolve():
            raise ValueError("board path aliases the default board")
        if not self.path.exists():
            raise ValueError("create the dedicated board first")
        self.connect, self.config = connect, load_config_readonly

    @contextmanager
    def serialized(self):
        with open(str(self.path) + ".rk-admission.lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with self.connect.connect_closing(board=self.board) as conn:
                conn.execute("CREATE TABLE IF NOT EXISTS rk_admission ("
                             "task_id TEXT PRIMARY KEY, sequence INTEGER, resources TEXT, "
                             "park_event INTEGER)")
                conn.execute("CREATE TABLE IF NOT EXISTS rk_settings ("
                             "key TEXT PRIMARY KEY, value INTEGER)")
                conn.commit()
                yield conn

    @contextmanager
    def reading(self):
        """Observe committed owner state without waiting on a source-check pass."""
        with self.connect.connect_closing(board=self.board) as conn:
            conn.execute("CREATE TABLE IF NOT EXISTS rk_admission ("
                         "task_id TEXT PRIMARY KEY, sequence INTEGER, resources TEXT, "
                         "park_event INTEGER)")
            conn.commit()
            conn.execute("CREATE TABLE IF NOT EXISTS rk_settings ("
                         "key TEXT PRIMARY KEY, value INTEGER)")
            conn.commit()
            conn.execute("PRAGMA query_only=ON")
            conn.execute("BEGIN")
            yield conn

    def _settings(self, conn):
        config = self.config().get("kanban", {})
        if config.get("dispatch_in_gateway", True) or self.dispatch.review_dispatch_enabled():
            raise UnsupportedHost(
                "Board-scoped delegation is not available in this Hermes setup. "
                "You can still use the Reminders board."
            )
        configured = positive(config.get("max_in_progress"))
        host = self.dispatch.resolve_max_in_progress(configured)
        row = conn.execute("SELECT value FROM rk_settings WHERE key='maximum'").fetchone()
        board = row[0] if row else configured or 3
        effective = min(v for v in (board, host, positive(config.get("max_spawn"))) if v)
        return config, host, board, effective

    def set_maximum(self, maximum):
        if maximum is not None and (type(maximum) is not int or maximum < 1):
            raise ValueError("maximum must be a positive integer or None to inherit")
        with self.serialized() as conn, self.kb.write_txn(conn):
            if maximum is None:
                conn.execute("DELETE FROM rk_settings WHERE key='maximum'")
            else:
                conn.execute("INSERT OR REPLACE INTO rk_settings VALUES ('maximum', ?)",
                             (maximum,))

    def hold(self, conn, task_id):
        """Register preparation without granting dispatch; caller holds serialized()."""
        task = self.kb.get_task(conn, task_id)
        if task.status in {"ready", "todo"}:
            self.kb.schedule_task(conn, task_id)
        conn.execute("INSERT OR REPLACE INTO rk_admission VALUES (?, NULL, '[]', NULL)",
                     (task_id,))
        conn.commit()

    def pause(self, task_id):
        """Revoke queued admission before applying the existing worker stop control."""
        with self.serialized() as conn:
            conn.execute("UPDATE rk_admission SET park_event=NULL WHERE task_id=?", (task_id,))
            conn.commit()
            return TaskControl(conn, self.kb).pause(task_id)

    def ready(self, task_id, *, resources=()):
        """Record a deliberate Ready action, parking until admission.

        Resource keys must include known shared accounts/services as well as paths.
        Repeating Ready while already queued preserves its original position.
        """
        resources = sorted(set(resources))
        if any(not isinstance(key, str) or not key.strip() for key in resources):
            raise ValueError("resource keys must be nonempty strings")
        with self.serialized() as conn:
            self._settings(conn)
            task = self.kb.get_task(conn, task_id)
            if task is None:
                raise KeyError(task_id)
            if self._parked(conn, task):
                return
            if task.status not in {"ready", "todo"}:
                raise UnsupportedControl("Ready requires an eligible owner task")
            if not TaskControl(conn, self.kb)._workers_stopped(task_id):
                raise UnsupportedControl("previous worker has not stopped")
            keys = set(resources)
            if task.workspace_kind == "dir" and task.workspace_path:
                from pathlib import Path
                keys.add("workspace:" + str(Path(task.workspace_path).resolve()))
            seq = conn.execute(
                "SELECT coalesce(max(sequence), 0)+1 FROM rk_admission").fetchone()[0]
            conn.execute("INSERT OR REPLACE INTO rk_admission VALUES (?, ?, ?, NULL)",
                         (task_id, seq, json.dumps(sorted(keys))))
            conn.commit()
            self._park(conn, task_id)

    def _park(self, conn, task_id):
        # No reason: Hermes must not synthesize a run that hides quota cooldown.
        if self.kb.schedule_task(conn, task_id):
            event = self.kb.list_events(conn, task_id)[-1]
            conn.execute("UPDATE rk_admission SET park_event=? WHERE task_id=?",
                         (event.id, task_id))
            conn.commit()

    def _parked(self, conn, task):
        events = [e for e in self.kb.list_events(conn, task.id) if e.kind == "scheduled"]
        row = conn.execute("SELECT park_event FROM rk_admission WHERE task_id=?",
                           (task.id,)).fetchone()
        return (task.status == "scheduled" and bool(events) and row is not None
                and events[-1].id == row[0] and events[-1].kind == "scheduled")

    def _snapshot(self, conn):
        config, host, board, effective = self._settings(conn)
        tasks = {t.id: t for t in self.kb.list_tasks(conn, include_archived=True)}
        rows = conn.execute("SELECT * FROM rk_admission ORDER BY sequence, task_id").fetchall()
        known = {r["task_id"] for r in rows}
        if any(t.id not in known and t.status != "archived" for t in tasks.values()):
            raise UnsupportedControl("board contains unregistered tasks; admission refused")
        running = sum(t.status == "running" for t in tasks.values())
        others = self.dispatch.count_running_tasks_other_boards(self.board)
        occupied = set()
        for row in rows:
            task = tasks.get(row["task_id"])
            if task and (task.status == "running"
                         or not TaskControl(conn, self.kb)._workers_stopped(task.id)):
                occupied.update(json.loads(row["resources"]))
        queue = []
        for row in rows:
            task = tasks.get(row["task_id"])
            if not task or not (self._parked(conn, task) or task.status in {"ready", "todo"}):
                continue
            reason = None
            if self.kb.unsatisfied_parents(conn, task.id):
                reason = "dependencies"
            elif not TaskControl(conn, self.kb)._workers_stopped(task.id):
                reason = "worker_still_alive"
            elif occupied.intersection(json.loads(row["resources"])):
                reason = "resource_busy"
            elif running >= effective:
                reason = "board_capacity"
            elif host and running + others >= host:
                reason = "host_capacity"
            elif self.dispatch.check_respawn_guard(conn, task.id, lane="ready"):
                reason = "host_cooldown"
            queue.append({"task_id": task.id, "reason": reason})
        return {"board_maximum": board, "host_limit": host, "effective_limit": effective,
                "running": running, "other_boards_running": others, "queue": queue,
                "host_limit_atomic": False}, config

    def observe(self):
        with self.reading() as conn:
            return self._snapshot(conn)[0]

    def admit(self, *, before_dispatch=None):
        """One bounded pass. Caller invokes again after readiness or owner changes."""
        with self.serialized() as conn:
            self._snapshot(conn)  # fail closed before owner maintenance
            self.dispatch.dispatch_once(conn, board=self.board, max_spawn=0)
            snapshot, config = self._snapshot(conn)
            for task in self.kb.list_tasks(conn):
                if task.status in {"ready", "todo"}:
                    self._park(conn, task.id)
            results = []
            attempted = set()
            remaining = snapshot["effective_limit"]
            for _ in range(len(snapshot["queue"])):
                if remaining <= 0:
                    break
                snapshot, config = self._snapshot(conn)
                candidate = next((q for q in snapshot["queue"] if q["reason"] is None
                                  and q["task_id"] not in attempted), None)
                if not candidate:
                    break
                task_id = candidate["task_id"]
                attempted.add(task_id)
                if before_dispatch is not None and not before_dispatch(conn, task_id):
                    continue
                self.kb.unblock_task(conn, task_id)
                try:
                    dry, remaining = self._dispatch_selected(
                        conn, task_id, dry_run=True, remaining=remaining)
                    result, remaining = self._dispatch_selected(
                        conn, task_id, dry_run=False, remaining=remaining)
                    results.append({"dry_run": asdict(dry), "dispatch": asdict(result)})
                finally:
                    task = self.kb.get_task(conn, task_id)
                    if task.status in {"ready", "todo"}:
                        self._park(conn, task_id)
            return {**self._snapshot(conn)[0], "passes": results}

    def _dispatch_selected(self, conn, task_id, *, dry_run, remaining):
        # Native dispatch_once also reclaims/promotes unrelated rows before spawn.
        # Use its own single-task path after maintenance to keep selection exact.
        result = self.dispatch.DispatchResult()
        with self.connect._dispatch_tick_lock(self.path) as held:
            if not held:
                result.skipped_locked = True
                return result, remaining
            snapshot, config = self._snapshot(conn)
            candidate = next(q for q in snapshot["queue"] if q["task_id"] == task_id)
            if candidate["reason"]:
                return result, remaining
            allowed, budget = self.dispatch._tick_spawn_budget(
                conn, result, max_spawn=snapshot["effective_limit"],
                max_in_progress=snapshot["host_limit"], board=self.board)
            if not allowed:
                return result, 0
            if budget is not None:
                remaining = min(remaining, budget)
            if remaining <= 0:
                return result, remaining
            row = conn.execute("SELECT id, assignee FROM tasks WHERE id=?", (task_id,)).fetchone()
            if not row["assignee"]:
                result.skipped_unassigned.append(task_id)
                return result, remaining
            running = {r[0]: r[1] for r in conn.execute(
                "SELECT assignee, count(*) FROM tasks WHERE status='running' GROUP BY assignee")}
            self.dispatch._dispatch_lane_task(
                conn, row, row["assignee"], result, lane="ready", dry_run=dry_run,
                ttl_seconds=None, board=self.board, failure_limit=2, spawn_fn=None,
                per_profile_cap=positive(config.get("max_in_progress_per_profile")),
                per_profile_running=running)
        return result, remaining - (len(result.spawned) if not dry_run else 0)
