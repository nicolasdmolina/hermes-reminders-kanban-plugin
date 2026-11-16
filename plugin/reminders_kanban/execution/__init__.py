"""Conservative task controls over the plugin's own task store (``board.py``)."""

import time
from dataclasses import asdict


class UnsupportedControl(RuntimeError):
    """The installed owner cannot safely establish this control boundary."""


class OperationConflict(ValueError):
    """An operation key was reused with different content."""


class TaskControl:
    """One store connection; caller owns its lifetime and holds the admission lock.

    Construct with a ``runner.Backend`` (the store plus the runner that stops its jobs).
    This object never starts a run; ``Admission`` does.
    """

    def __init__(self, connection, backend):
        self.connection = connection
        self.backend = backend

    def create(self, key: str, title: str, body: str, *, assignee: str) -> str:
        if not all(value.strip() for value in (key, title, body, assignee)):
            raise ValueError("key, title, body, and assignee are required")
        title = title.strip()
        kb, conn = self.backend, self.connection
        # An outer write transaction makes lookup plus insertion atomic across callers.
        with kb.write_txn(conn):
            matches = [t for t in kb.list_tasks(conn, include_archived=True)
                       if t.idempotency_key == key]
            if len(matches) > 1:
                raise OperationConflict("multiple tasks already share this key")
            if matches:
                task = matches[0]
                if (task.title, task.body) != (title, body):
                    raise OperationConflict("creation key has different instructions")
                return task.id
            return kb.create_task(
                conn, title=title, body=body, assignee=assignee, idempotency_key=key,
                workspace_kind="scratch", max_retries=1,
            )

    def comment(self, task_id: str, key: str, text: str) -> int:
        """Append exactly one reply per key, including after a lost response.

        This records input only. Resume is a separate deliberate action, so an
        uncertain reply never automatically starts another attempt.
        """
        if not key.strip() or not text.strip():
            raise ValueError("reply key and text are required")
        kb, conn = self.backend, self.connection
        author = f"reminders-kanban:{key.strip()}"
        with kb.write_txn(conn):
            matches = [c for c in kb.list_comments(conn, task_id) if c.author == author]
            if len(matches) > 1:
                raise OperationConflict("multiple replies already share this key")
            if matches:
                if matches[0].body != text.strip():
                    raise OperationConflict("reply key has different content")
                return matches[0].id
            task = kb.get_task(conn, task_id)
            if task is None or task.status not in {"blocked", "review", "scheduled"}:
                raise UnsupportedControl("input requires a parked task")
            return kb.add_comment(conn, task_id, author, text.strip())

    def observe(self, task_id: str) -> dict:
        kb, conn = self.backend, self.connection
        task = kb.get_task(conn, task_id)
        if task is None:
            raise KeyError(task_id)
        state = {
            "running": "active", "review": "result", "archived": "stopped",
            "scheduled": "paused", "ready": "ready", "todo": "ready", "done": "done",
        }.get(task.status, "failed")
        if task.status == "blocked":
            state = "question" if task.block_kind == "needs_input" else "failed"
        return {
            "task_id": task.id, "state": state, "host_status": task.status,
            "task": asdict(task),
            "comments": [asdict(c) for c in kb.list_comments(conn, task_id)],
            "runs": [asdict(r) for r in kb.list_runs(conn, task_id)],
            "summary": kb.latest_summary(conn, task_id),
        }

    def _workers_stopped(self, task_id: str) -> bool:
        kb, conn = self.backend, self.connection
        return not any(kb.run_in_flight(conn, run.id) for run in kb.list_runs(conn, task_id)
                       if run.job_id)

    def _await_stopped(self, task_id: str) -> bool:
        deadline = time.monotonic() + 5
        while not self._workers_stopped(task_id):
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.1)
        return True

    def _stop_jobs(self, task_id, reason, current=None):
        """Cancel the attempt that was running, and any job still being waited on."""
        kb, conn = self.backend, self.connection
        for run in kb.list_runs(conn, task_id):
            if run.job_id and (run.id == current or kb.run_in_flight(conn, run.id)):
                kb.runner.stop(conn, run, reason)

    def pause(self, task_id: str) -> dict:
        """Park durably, then stop the attempt's Hermes job."""
        kb, conn = self.backend, self.connection
        task = kb.get_task(conn, task_id)
        if task is None:
            raise KeyError(task_id)
        if task.status == "review":
            if not kb.park_review(conn, task_id, "Source instructions changed during review"):
                raise UnsupportedControl("task changed before review pause")
        elif task.status != "scheduled":
            if not kb.schedule_task(
                conn, task_id, reason="Instructions changed; explicit resume required",
                expected_run_id=task.current_run_id,
            ):
                raise UnsupportedControl("task changed before pause; observe it again")
        # Replays stop a job that is still winding down, never start one.
        self._stop_jobs(task_id, "Paused from Reminders", task.current_run_id)
        result = self.observe(task_id)
        result["worker_stop_verified"] = self._await_stopped(task_id)
        return result

    def resume(self, task_id: str) -> bool:
        """Explicit unblock; never overlap a previous run."""
        if not self._workers_stopped(task_id):
            raise UnsupportedControl("previous worker has not stopped")
        return self.backend.unblock_task(self.connection, task_id)

    def request_changes(self, task_id: str, key: str, text: str) -> bool:
        self.comment(task_id, key, text)
        if not self._workers_stopped(task_id):
            raise UnsupportedControl("previous worker has not stopped")
        return self.backend.reopen_review_task(self.connection, task_id)

    def accept(self, task_id: str) -> bool:
        """Accept a parked result. Callers serialize task lifecycle actions."""
        task = self.backend.get_task(self.connection, task_id)
        if task is None or task.status != "review" or not self._workers_stopped(task_id):
            raise UnsupportedControl("accept requires a settled review result")
        return self.backend.complete_task(self.connection, task_id)

    def stop(self, task_id: str) -> dict:
        """Archive, then stop the job; expose stop evidence without claiming success."""
        task = self.backend.get_task(self.connection, task_id)
        self.backend.archive_task(self.connection, task_id)
        # Archive commits before stopping; a replay finishes an interrupted stop.
        self._stop_jobs(task_id, "Stopped from Reminders", task.current_run_id if task else None)
        observation = self.observe(task_id)
        observation["worker_stop_verified"] = self._await_stopped(task_id)
        return observation
