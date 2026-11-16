"""The plugin's own task store: one SQLite file per profile, under the plugin's directory.

It keeps the few Kanban states, runs, comments and events the workflow reads, with the
event kinds and run outcomes Hermes Kanban uses, so a task reads the same whichever owner
recorded it. Agent work is started and stopped through ``runner.Cron`` (Hermes' public
scheduled-job tool); results arrive through the plugin's own tools (``tools.py``).
"""

import fcntl
import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, assignee TEXT, status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0, created_at INTEGER, started_at INTEGER,
    completed_at INTEGER, workspace_kind TEXT NOT NULL DEFAULT 'scratch', workspace_path TEXT,
    result TEXT, idempotency_key TEXT UNIQUE, current_run_id INTEGER, block_kind TEXT,
    max_retries INTEGER
);
CREATE TABLE IF NOT EXISTS task_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, profile TEXT,
    status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, outcome TEXT,
    summary TEXT, metadata TEXT, error TEXT, job_id TEXT, job_removed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS task_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, author TEXT NOT NULL,
    body TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id INTEGER,
    kind TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_runs_job ON task_runs(job_id);
"""


@dataclass
class Task:
    id: str
    title: str
    body: str | None
    assignee: str | None
    status: str
    priority: int
    created_at: int | None
    started_at: int | None
    completed_at: int | None
    workspace_kind: str
    workspace_path: str | None
    result: str | None
    idempotency_key: str | None
    current_run_id: int | None
    block_kind: str | None
    max_retries: int | None


@dataclass
class Run:
    id: int
    task_id: str
    profile: str | None
    status: str
    started_at: int
    ended_at: int | None
    outcome: str | None
    summary: str | None
    metadata: dict | None
    error: str | None
    job_id: str | None


@dataclass
class Comment:
    id: int
    task_id: str
    author: str
    body: str
    created_at: int


@dataclass
class Event:
    id: int
    task_id: str
    kind: str
    payload: dict | None
    created_at: int
    run_id: int | None = None


def _task(row):
    return Task(**{k: row[k] for k in Task.__dataclass_fields__})


def _run(row):
    fields = {k: row[k] for k in Run.__dataclass_fields__ if k != "metadata"}
    return Run(**fields, metadata=json.loads(row["metadata"]) if row["metadata"] else None)


def path_for(home) -> Path:
    return Path(home) / "reminders-kanban" / "tasks.sqlite3"


def connect(path) -> sqlite3.Connection:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.executescript(SCHEMA)
    return conn


@contextmanager
def connect_closing(path):
    conn = connect(path)
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def write_txn(conn):
    """One write transaction; joins an enclosing one (create/comment composition)."""
    if conn.in_transaction:
        yield
        return
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


def now():
    return int(time.time())


def append_event(conn, task_id, kind, payload=None, *, run_id=None):
    return conn.execute(
        "INSERT INTO task_events(task_id, run_id, kind, payload, created_at) VALUES (?,?,?,?,?)",
        (task_id, run_id, kind, json.dumps(payload) if payload is not None else None, now()),
    ).lastrowid


def create_task(conn, *, title, body, assignee, idempotency_key, workspace_kind="scratch",
                max_retries=1, **_ignored):
    task_id = "t_" + uuid.uuid4().hex[:12]
    with write_txn(conn):
        conn.execute(
            "INSERT INTO tasks(id, title, body, assignee, status, created_at, workspace_kind, "
            "idempotency_key, max_retries) VALUES (?,?,?,?, 'ready', ?,?,?,?)",
            (task_id, title, body, assignee, now(), workspace_kind, idempotency_key, max_retries),
        )
        append_event(conn, task_id, "created", {"assignee": assignee})
    return task_id


def get_task(conn, task_id):
    row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    return _task(row) if row else None


def list_tasks(conn, *, include_archived=False):
    sql = "SELECT * FROM tasks" + ("" if include_archived else " WHERE status != 'archived'")
    return [_task(r) for r in conn.execute(sql + " ORDER BY created_at, id")]


def add_comment(conn, task_id, author, body):
    with write_txn(conn):
        comment = conn.execute(
            "INSERT INTO task_comments(task_id, author, body, created_at) VALUES (?,?,?,?)",
            (task_id, author, body, now()),
        ).lastrowid
        append_event(conn, task_id, "commented", {"author": author})
    return comment


def list_comments(conn, task_id):
    return [Comment(**dict(r)) for r in conn.execute(
        "SELECT id, task_id, author, body, created_at FROM task_comments WHERE task_id=? "
        "ORDER BY id", (task_id,))]


def list_events(conn, task_id):
    return [Event(id=r["id"], task_id=r["task_id"], kind=r["kind"],
                  payload=json.loads(r["payload"]) if r["payload"] else None,
                  created_at=r["created_at"], run_id=r["run_id"])
            for r in conn.execute("SELECT * FROM task_events WHERE task_id=? ORDER BY id",
                                  (task_id,))]


def list_runs(conn, task_id):
    return [_run(r) for r in conn.execute(
        "SELECT * FROM task_runs WHERE task_id=? ORDER BY id", (task_id,))]


def get_run(conn, run_id):
    row = conn.execute("SELECT * FROM task_runs WHERE id=?", (run_id,)).fetchone()
    return _run(row) if row else None


def open_runs(conn):
    return [_run(r) for r in conn.execute(
        "SELECT * FROM task_runs WHERE ended_at IS NULL AND status='running' ORDER BY id")]


def latest_summary(conn, task_id):
    row = conn.execute(
        "SELECT summary FROM task_runs WHERE task_id=? AND summary IS NOT NULL "
        "ORDER BY id DESC LIMIT 1", (task_id,)).fetchone()
    return row[0] if row else None


def unsatisfied_parents(conn, task_id):
    return []  # Delegated reminders have no dependencies.


def _end_run(conn, task_id, *, outcome, status, summary=None, error=None, metadata=None,
             synthesize=False, profile=None):
    """End the task's open run, or record one that never had a worker (Hermes' synthetic run)."""
    task = get_task(conn, task_id)
    if task and task.current_run_id:
        conn.execute(
            "UPDATE task_runs SET status=?, ended_at=?, outcome=?, summary=?, error=?, "
            "metadata=coalesce(?, metadata) WHERE id=? AND ended_at IS NULL",
            (status, now(), outcome, summary, error,
             json.dumps(metadata) if metadata else None, task.current_run_id),
        )
        return task.current_run_id
    if not synthesize:
        return None
    return conn.execute(
        "INSERT INTO task_runs(task_id, profile, status, started_at, ended_at, outcome, summary, "
        "metadata, error) VALUES (?,?,?,?,?,?,?,?,?)",
        (task_id, profile or (task.assignee if task else None), status, now(), now(), outcome,
         summary, json.dumps(metadata) if metadata else None, error),
    ).lastrowid


def start_run(conn, task_id, profile):
    """``ready`` -> ``running`` with a new open run; the caller starts the job for it."""
    with write_txn(conn):
        if conn.execute("UPDATE tasks SET status='running', started_at=coalesce(started_at, ?) "
                        "WHERE id=? AND status IN ('ready', 'todo')",
                        (now(), task_id)).rowcount != 1:
            return None
        run_id = conn.execute(
            "INSERT INTO task_runs(task_id, profile, status, started_at) VALUES (?,?,'running',?)",
            (task_id, profile, now())).lastrowid
        conn.execute("UPDATE tasks SET current_run_id=? WHERE id=?", (run_id, task_id))
        append_event(conn, task_id, "claimed", None, run_id=run_id)
    return run_id


def bind_job(conn, run_id, job_id):
    with write_txn(conn):
        conn.execute("UPDATE task_runs SET job_id=? WHERE id=?", (job_id, run_id))


def run_for_job(conn, job_id):
    row = conn.execute("SELECT * FROM task_runs WHERE job_id=? ORDER BY id DESC LIMIT 1",
                       (job_id,)).fetchone()
    return _run(row) if row else None


def request_review(conn, run_id, summary):
    """The agent's handed-back result: its open run ends and the task waits for the person."""
    with write_txn(conn):
        run = get_run(conn, run_id)
        task = get_task(conn, run.task_id) if run else None
        if not task or task.status != "running" or task.current_run_id != run_id:
            return False
        conn.execute("UPDATE task_runs SET status='review', ended_at=?, "
                     "outcome='review_requested', summary=? WHERE id=?", (now(), summary, run_id))
        conn.execute("UPDATE tasks SET status='review', result=?, current_run_id=NULL WHERE id=?",
                     (summary, task.id))
        append_event(conn, task.id, "review_requested",
                     {"summary": summary[:400], "implementer": run.profile}, run_id=run_id)
    return True


def block_task(conn, run_id, *, kind, reason, error=None):
    """The open run ends blocked: a question for the person, or a failed attempt."""
    with write_txn(conn):
        run = get_run(conn, run_id)
        task = get_task(conn, run.task_id) if run else None
        if not task or task.status != "running" or task.current_run_id != run_id:
            return False
        asked = kind == "needs_input"
        outcome = "blocked" if asked else "crashed"
        conn.execute("UPDATE task_runs SET status=?, ended_at=?, outcome=?, summary=?, error=? "
                     "WHERE id=?", (outcome, now(), outcome, reason if asked else None, error,
                                    run_id))
        conn.execute("UPDATE tasks SET status='blocked', block_kind=?, current_run_id=NULL "
                     "WHERE id=?", (kind, task.id))
        append_event(conn, task.id, "blocked", {"kind": kind, "reason": reason}, run_id=run_id)
    return True


def schedule_task(conn, task_id, *, reason=None, expected_run_id=None):
    """Park in ``scheduled`` until ``unblock_task``; a running attempt ends as ``scheduled``."""
    with write_txn(conn):
        task = get_task(conn, task_id)
        if (not task or task.status not in {"todo", "ready", "running", "blocked"}
                or (expected_run_id is not None and task.current_run_id != expected_run_id)):
            return False
        run_id = _end_run(conn, task_id, outcome="scheduled", status="scheduled", summary=reason,
                          synthesize=bool(reason))
        conn.execute("UPDATE tasks SET status='scheduled', current_run_id=NULL WHERE id=?",
                     (task_id,))
        append_event(conn, task_id, "scheduled", {"reason": reason}, run_id=run_id)
    return True


def park_review(conn, task_id, reason):
    """A settled result whose instructions changed: parked for an explicit resume."""
    with write_txn(conn):
        if conn.execute("UPDATE tasks SET status='scheduled' WHERE id=? AND status='review' "
                        "AND current_run_id IS NULL", (task_id,)).rowcount != 1:
            return False
        append_event(conn, task_id, "scheduled", {"reason": reason, "source": "review"})
    return True


def unblock_task(conn, task_id):
    with write_txn(conn):
        if conn.execute("UPDATE tasks SET status='ready', current_run_id=NULL WHERE id=? "
                        "AND status IN ('blocked', 'scheduled')", (task_id,)).rowcount != 1:
            return False
        append_event(conn, task_id, "unblocked", None)
    return True


def reopen_review_task(conn, task_id):
    with write_txn(conn):
        if conn.execute("UPDATE tasks SET status='ready' WHERE id=? AND status='review'",
                        (task_id,)).rowcount != 1:
            return False
        append_event(conn, task_id, "review_reopened", None)
    return True


def complete_task(conn, task_id):
    """A person accepts the result in review."""
    with write_txn(conn):
        task = get_task(conn, task_id)
        if not task or task.status != "review":
            return False
        conn.execute("UPDATE tasks SET status='done', completed_at=?, block_kind=NULL WHERE id=?",
                     (now(), task_id))
        run_id = _end_run(conn, task_id, outcome="completed", status="done",
                          metadata={"approval": "manual"}, synthesize=True)
        append_event(conn, task_id, "completed", None, run_id=run_id)
    return True


def archive_task(conn, task_id):
    with write_txn(conn):
        task = get_task(conn, task_id)
        if not task or task.status == "archived":
            return False
        _end_run(conn, task_id, outcome="reclaimed", status="reclaimed",
                 error="Stopped from Reminders")
        conn.execute("UPDATE tasks SET status='archived', current_run_id=NULL WHERE id=?",
                     (task_id,))
        append_event(conn, task_id, "archived", None)
    return True


# Liveness: a run's job is in flight while its runner holds the run's lock. The lock is a
# file lock, so it lapses when the process ends and is seen from any process on the Mac.

def lock_path(conn, run_id) -> Path:
    db = Path(conn.execute("PRAGMA database_list").fetchone()["file"])
    return db.parent / "runs" / f"{run_id}.lock"


@contextmanager
def hold_run(conn, run_id):
    path = lock_path(conn, run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def run_in_flight(conn, run_id) -> bool:
    path = lock_path(conn, run_id)
    if not path.exists():
        return False
    with path.open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(handle, fcntl.LOCK_UN)
    return False
