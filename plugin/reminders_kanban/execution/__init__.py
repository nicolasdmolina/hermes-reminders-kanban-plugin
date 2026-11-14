"""Conservative task controls through the installed Hermes Kanban owner."""

import time
from dataclasses import asdict


class UnsupportedControl(RuntimeError):
    """The installed owner cannot safely establish this control boundary."""


class UnsupportedHost(UnsupportedControl):
    """Board-scoped delegation is unavailable without changing other boards."""


class OperationConflict(ValueError):
    """An operation key was reused with different content."""


def asking_again(task) -> bool:
    """A question asked after an earlier one was answered. Hermes counts a task that blocks
    again for the same kind of reason as a possible loop and files it under triage instead of
    blocked (kanban_db BLOCK_RECURRENCE_LIMIT). For a task waiting on the person's answer that
    is an ordinary follow-up question: it is answered and continued like the first."""
    return task.status == "triage" and task.block_kind == "needs_input"


class TaskControl:
    """One board connection; caller owns its lifetime and profile selection.

    Construct with Hermes' kanban_db module and connect_closing(board=...).
    This object never dispatches, resumes a transcript, or changes host config.
    """

    def __init__(self, connection, backend):
        self.connection = connection
        self.backend = backend

    def create(self, key: str, title: str, body: str, *, assignee: str,
               model_override: str | None = None, provider_override: str | None = None,
               reasoning_effort: str | None = None) -> str:
        if not all(value.strip() for value in (key, title, body, assignee)):
            raise ValueError("key, title, body, and assignee are required")
        title = title.strip()
        kb, conn = self.backend, self.connection
        # Hermes explicitly supports nested create/comment composition. An outer
        # write transaction makes lookup plus insertion atomic across callers.
        with kb.write_txn(conn):
            matches = [t for t in kb.list_tasks(conn, include_archived=True)
                       if t.idempotency_key == key]
            if len(matches) > 1:
                raise OperationConflict("multiple tasks already share this key")
            if matches:
                task = matches[0]
                if (task.title, task.body) != (title, body):
                    raise OperationConflict("creation key has different instructions")
                # Replay preserves the original task overrides, including legacy NULLs.
                return task.id
            return kb.create_task(
                conn, title=title, body=body, assignee=assignee, idempotency_key=key,
                workspace_kind="scratch", max_retries=1,
                model_override=model_override, provider_override=provider_override,
                reasoning_effort=reasoning_effort,
            )

    def set_model_choice(self, task_id, choice):
        """Apply next-run settings through Hermes while the task is parked."""
        kb, conn = self.backend, self.connection
        task = kb.get_task(conn, task_id)
        if task is None or not (task.status in {"blocked", "review", "scheduled"}
                                or asking_again(task)):
            raise UnsupportedControl("model choice requires a parked task")
        if not kb.set_model_override(conn, task_id, choice.model, choice.provider):
            raise UnsupportedControl("owner refused model choice")
        if not kb.set_reasoning_effort(conn, task_id, choice.effort):
            raise UnsupportedControl("owner refused reasoning choice")

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
            if task is None or not (task.status in {"blocked", "review", "scheduled"}
                                    or asking_again(task)):
                raise UnsupportedControl("input requires a parked task")
            return kb.add_comment(conn, task_id, author, text)

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
        elif asking_again(task):
            state = "question"
        return {
            "task_id": task.id, "state": state, "host_status": task.status,
            "task": asdict(task),
            "comments": [asdict(c) for c in kb.list_comments(conn, task_id)],
            "runs": [asdict(r) for r in kb.list_runs(conn, task_id)],
            "summary": kb.latest_summary(conn, task_id),
        }

    def _worker_records(self, task_id: str):
        return self.connection.execute(
            "SELECT worker_pid, worker_started_at, claim_lock FROM task_runs WHERE task_id=?",
            (task_id,),
        ).fetchall()

    def _workers_stopped(self, task_id: str) -> bool:
        kb, conn = self.backend, self.connection
        for run in self._worker_records(task_id):
            if kb._worker_alive(run["worker_pid"], run["worker_started_at"]):
                return False
        for event in kb.list_events(conn, task_id):
            if event.kind == "worker_bound":
                data = event.payload
                if kb._worker_alive(data["pid"], data["started_at"]):
                    return False
        return True

    def _await_stopped(self, task_id: str) -> bool:
        deadline = time.monotonic() + 5
        while not self._workers_stopped(task_id):
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.1)
        return True

    def pause(self, task_id: str) -> dict:
        """Park durably before ending the captured worker through Hermes' own helper."""
        kb, conn = self.backend, self.connection
        task = kb.get_task(conn, task_id)
        if task is None:
            raise KeyError(task_id)
        if task.status == "review":
            # Native schedule excludes review and native reopen does not compose.
            # Park this exact settled review directly under the owner's write lock.
            with kb.write_txn(conn):
                events = [e for e in kb.list_events(conn, task_id)
                          if e.kind == "review_requested"]
                implementer = events[-1].payload.get("implementer") if events else None
                changed = conn.execute(
                    "UPDATE tasks SET status='scheduled', assignee=COALESCE(?, assignee) "
                    "WHERE id=? AND status='review' AND current_run_id IS NULL",
                    (implementer, task_id),
                ).rowcount
                if changed != 1:
                    raise UnsupportedControl("task changed before review pause")
                kb._append_event(conn, task_id, "scheduled", {
                    "reason": "Source instructions changed during review", "source": "review",
                })
        elif task.status != "scheduled":
            if not kb.schedule_task(
                conn, task_id, reason="Instructions changed; explicit resume required",
                expected_run_id=task.current_run_id,
            ):
                raise UnsupportedControl("task changed before pause; observe it again")
        # A lost response can retry against the retained run identity. Never
        # reclaim: it makes the task dispatchable before a following block.
        for run in self._worker_records(task_id):
            if run["worker_pid"]:
                kb._terminate_reclaimed_worker(
                    run["worker_pid"], run["claim_lock"], started_at=run["worker_started_at"],
                )
        result = self.observe(task_id)
        result["worker_stop_verified"] = self._await_stopped(task_id)
        return result

    def resume(self, task_id: str) -> bool:
        """Explicit owner unblock; never overlap a previous interpreter."""
        if not self._workers_stopped(task_id):
            raise UnsupportedControl("previous worker has not stopped")
        task = self.backend.get_task(self.connection, task_id)
        if task is not None and asking_again(task):
            # Hermes' own way out of triage: back to the pool, nothing about the task changed.
            return self.backend.specify_triage_task(self.connection, task_id)
        return self.backend.unblock_task(self.connection, task_id)

    def request_changes(self, task_id: str, key: str, text: str) -> bool:
        self.comment(task_id, key, text)
        if not self._workers_stopped(task_id):
            raise UnsupportedControl("previous worker has not stopped")
        return self.backend.reopen_review_task(self.connection, task_id)

    def accept(self, task_id: str) -> bool:
        """Accept a parked result using the host's manual-review operation.

        As with native operator controls, callers serialize task lifecycle actions.
        """
        task = self.backend.get_task(self.connection, task_id)
        if task is None or task.status != "review" or not self._workers_stopped(task_id):
            raise UnsupportedControl("accept requires a settled review result")
        return self.backend.complete_task(self.connection, task_id)

    def stop(self, task_id: str) -> dict:
        """Archive via the owner; expose termination evidence without claiming success."""
        self.backend.archive_task(self.connection, task_id)
        # Archive commits before signaling; replay must finish interrupted termination.
        for run in self._worker_records(task_id):
            if run["worker_pid"]:
                self.backend._terminate_reclaimed_worker(
                    run["worker_pid"], run["claim_lock"], started_at=run["worker_started_at"],
                )
        observation = self.observe(task_id)
        observation["termination_events"] = [
            asdict(e) for e in self.backend.list_events(self.connection, task_id)
            if e.kind == "archive_worker_termination"
        ]
        observation["worker_stop_verified"] = self._await_stopped(task_id)
        return observation
