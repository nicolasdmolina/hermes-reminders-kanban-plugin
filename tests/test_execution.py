"""Behavior tests; the live test separately checks the installed host contract."""

import sqlite3
import sys
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from reminders_kanban.execution import OperationConflict, TaskControl, UnsupportedControl


@dataclass
class Task:
    id: str
    title: str
    body: str
    idempotency_key: str
    status: str = "blocked"
    block_kind: str | None = "needs_input"


class Backend:
    """SQLite test double for the two composition APIs used by the bridge."""

    @staticmethod
    @contextmanager
    def write_txn(c):
        c.execute("BEGIN IMMEDIATE")
        try:
            yield
            c.commit()
        except Exception:
            c.rollback()
            raise

    @staticmethod
    def list_tasks(c, *, include_archived):
        assert include_archived
        return [Task(*r) for r in c.execute("SELECT * FROM tasks")]

    @staticmethod
    def create_task(c, *, title, body, idempotency_key, **kwargs):
        c.execute("INSERT INTO tasks VALUES ('t_1', ?, ?, ?, 'blocked', 'needs_input')",
                  (title, body, idempotency_key))
        return "t_1"

    @staticmethod
    def get_task(c, task_id):
        row = c.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        return Task(*row) if row else None

    @staticmethod
    def list_comments(c, task_id):
        return [SimpleNamespace(id=r[0], author=r[1], body=r[2]) for r in c.execute(
            "SELECT id,author,body FROM comments WHERE task_id=?", (task_id,))]

    @staticmethod
    def add_comment(c, task_id, author, body):
        return c.execute("INSERT INTO comments(task_id,author,body) VALUES (?,?,?)",
                         (task_id, author, body.strip())).lastrowid


@pytest.fixture
def control():
    c = sqlite3.connect(":memory:")
    c.executescript("""
        CREATE TABLE tasks(id, title, body, idempotency_key, status, block_kind);
        CREATE TABLE comments(id INTEGER PRIMARY KEY, task_id, author, body);
    """)
    yield TaskControl(c, Backend)
    c.close()


def test_create_recovers_lost_result_even_after_archive(control):
    control.create("op", " title ", "body", assignee="default")
    control.connection.execute("UPDATE tasks SET status='archived'")
    control.connection.commit()
    assert control.create("op", "title", "body", assignee="default") == "t_1"
    assert len(Backend.list_tasks(control.connection, include_archived=True)) == 1
    with pytest.raises(OperationConflict):
        control.create("op", "different", "body", assignee="default")


def test_reply_recovers_lost_result_without_duplicate(control):
    control.create("op", "title", "body", assignee="default")
    assert control.comment("t_1", "reply ", " blue ") == 1
    assert control.comment("t_1", "reply", "blue") == 1
    with pytest.raises(OperationConflict):
        control.comment("t_1", "reply", "red")
    assert len(Backend.list_comments(control.connection, "t_1")) == 1


def test_input_refuses_active_worker_and_unknown_task(control):
    control.create("op", " title ", "body", assignee="default")
    control.connection.execute("UPDATE tasks SET status='running'")
    control.connection.commit()
    for task in ("t_1", "missing"):
        with pytest.raises(UnsupportedControl):
            control.comment(task, "reply", "blue")
    assert Backend.list_comments(control.connection, "t_1") == []


def test_resume_refuses_a_surviving_worker(control, monkeypatch):
    monkeypatch.setattr(control, "_workers_stopped", lambda _: False)
    with pytest.raises(UnsupportedControl, match="previous worker"):
        control.resume("t_1")


def test_accept_refuses_active_or_missing_result(control):
    control.create("op", "title", "body", assignee="default")
    with pytest.raises(UnsupportedControl, match="settled review"):
        control.accept("t_1")


def test_bound_interpreter_must_exit_after_submitter(control, monkeypatch):
    monkeypatch.setattr(control, "_worker_records", lambda _: [
        {"worker_pid": 10, "worker_started_at": "old"},
    ])
    monkeypatch.setattr(Backend, "list_events", lambda *_: [
        SimpleNamespace(kind="worker_bound", payload={"pid": 20, "started_at": "bound"}),
    ], raising=False)
    monkeypatch.setattr(Backend, "_worker_alive", lambda pid, stamp: pid == 20,
                        raising=False)
    assert not control._workers_stopped("t_1")
    monkeypatch.setattr(Backend, "_worker_alive", lambda *_: False)
    assert control._workers_stopped("t_1")


def test_stop_recovers_archive_commit_before_termination(control, monkeypatch):
    control.create("op", "title", "body", assignee="default")
    alive = [True]
    terminations = []

    def archived(c, task):
        # Simulate an earlier archive commit with no signal sent.
        c.execute("UPDATE tasks SET status='archived' WHERE id=?", (task,))
        c.commit()
        return False

    def terminate(pid, claim, *, started_at):
        terminations.append((pid, claim, started_at))
        alive[0] = False

    monkeypatch.setattr(Backend, "archive_task", archived, raising=False)
    monkeypatch.setattr(Backend, "_terminate_reclaimed_worker", terminate, raising=False)
    monkeypatch.setattr(Backend, "list_events", lambda *_: [], raising=False)
    monkeypatch.setattr(control, "observe", lambda _: {"state": "stopped"})
    monkeypatch.setattr(control, "_worker_records", lambda _: [
        {"worker_pid": 123, "claim_lock": "owned", "worker_started_at": "birth"},
    ])
    monkeypatch.setattr(control, "_await_stopped", lambda _: not alive[0])
    assert control.stop("t_1")["worker_stop_verified"]
    assert terminations == [(123, "owned", "birth")]


def test_a_follow_up_question_filed_under_triage_is_answered_and_continued(control, monkeypatch):
    control.create("op", "title", "body", assignee="default")
    control.connection.execute("UPDATE tasks SET status='triage'")
    control.connection.commit()
    assert control.comment("t_1", "second", "navy") == 1
    monkeypatch.setattr(control, "_workers_stopped", lambda _: True)
    moved = []
    monkeypatch.setattr(Backend, "specify_triage_task",
                        staticmethod(lambda c, task: moved.append(task) or True), raising=False)
    monkeypatch.setattr(Backend, "unblock_task",
                        staticmethod(lambda c, task: pytest.fail("not blocked")), raising=False)
    assert control.resume("t_1") and moved == ["t_1"]
    # Triage for any other reason is not a question: no reply is taken.
    control.connection.execute("UPDATE tasks SET block_kind='capability'")
    control.connection.commit()
    with pytest.raises(UnsupportedControl):
        control.comment("t_1", "third", "x")
