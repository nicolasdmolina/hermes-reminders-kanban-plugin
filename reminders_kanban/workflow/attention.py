"""Supervised input and an owner-local replayable attention journal."""

import json
import logging
from contextlib import nullcontext
from uuid import uuid4

from reminders_kanban.execution import OperationConflict, UnsupportedControl

logger = logging.getLogger(__name__)


class NoDelegatedTask(ValueError):
    """No delegated row carries the task a submission names."""


class Attention:
    def __init__(self, delegation):
        self.owner = delegation
        self.owners = [delegation]
        from reminders_kanban.workflow.occurrence import OccurrenceDelegation

        if not isinstance(delegation, OccurrenceDelegation):
            self.owners.append(OccurrenceDelegation(
                delegation.home, delegation.admission, profile=delegation.profile,
                origin=delegation.origin, call=delegation.call,
                control_factory=delegation.control_factory,
                write_link=lambda expected, notes: delegation.call(
                    "occurrence-link", id=expected["id"], expected=expected, notes=notes),
                write_other=delegation.write_link,
            ))
        with delegation.store.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS attention_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE, body TEXT
                );
                CREATE TABLE IF NOT EXISTS attention_submissions (
                    key TEXT PRIMARY KEY, request TEXT, receipt TEXT
                );
            """)

    def _capture(self, db, row, conn, owner=None):
        owner = owner or self.owner
        if owner.settled(row):
            title = (row.get("source") or row["expected"])["title"]
            # Finished for good: no question or result of its can still be waiting, and reading
            # every finished task on every poll grew without bound.
            return dict(owner.task_view(row, conn), task_id=row["task_id"],
                        occurrence_id=row["key"], guard=row.get("guard", {}), attention=None,
                        # Its name, for a dialog opened without a board card.
                        history={"task": {"title": title}},
                        destination=row.get("destination"),
                        transcript_mode="read_only")
        control = owner.control_factory(conn, owner.admission.kb)
        observed = control.observe(row["task_id"])
        current = None
        for event in owner.admission.kb.list_events(conn, row["task_id"]):
            kind = None
            if event.kind == "review_requested":
                kind = "result"
            elif (event.kind in {"blocked", "block_loop_detected"}  # The second: asked again.
                  and (event.payload or {}).get("kind") == "needs_input"):
                kind = "question"
            if not kind:
                continue
            token = f'{row["key"]}:{event.id}'
            body = dict(token=token, kind=kind, task_id=row["task_id"],
                        occurrence_id=row["key"], destination=row.get("destination"),
                        run_id=event.run_id, payload=event.payload)
            db.execute("INSERT OR IGNORE INTO attention_events(token, body) VALUES (?, ?)",
                       (token, json.dumps(body)))
            current = body
        db.commit()
        view = owner.task_view(row, conn, observed)
        state = view["state"]
        return dict(view, task_id=row["task_id"], occurrence_id=row["key"],
                    guard=row.get("guard", {}),
                    attention=current if current and current["kind"] == state else None,
                    history=observed, destination=row.get("destination"),
                    transcript_mode="read_only")

    def recover(self):
        """Finishes submissions that were interrupted after their comment was saved.

        Each one is settled from Hermes' own task events, so a reply is never applied to a later
        question: see `_recover`. Runs with every feed read, like the owner tick that recovers
        queued work. One that can never settle (its task is gone) is marked `abandoned` so it is
        not tried again.
        """
        with self.owner.store.connection() as db:
            pending = [
                (row["key"], json.loads(row["request"]))
                for row in db.execute("SELECT key, request, receipt FROM attention_submissions")
                if json.loads(row["receipt"]).get("status") == "needs_reconciliation"
            ]
        for key, request in pending:
            try:
                self.submit(key=key, **request)
            except NoDelegatedTask:
                # Nothing left to continue. Only a receipt still unsettled is changed.
                with self.owner.store.locked() as db:
                    row = db.execute(
                        "SELECT receipt FROM attention_submissions WHERE key=?", (key,)).fetchone()
                    current = json.loads(row["receipt"]) if row else {}
                    if current.get("status") == "needs_reconciliation":
                        db.execute("UPDATE attention_submissions SET receipt=? WHERE key=?",
                                   (json.dumps(dict(current, status="abandoned")), key))
                        db.commit()
            except Exception:
                logger.warning("attention submission %s not settled yet", key, exc_info=True)

    def _recover(self, db, owner, row, receipt, request):
        """Settles an interrupted submission: "submitted", "abandoned", or None (not yet).

        The token names the question or result it answered. If Hermes recorded the continuation
        after that event, it happened: only the bookkeeping was lost. If not, and that same
        question or result is still the current one with no worker alive, the continuation is
        applied now. A task that is gone or finished without one is abandoned. Anything else (a
        later attempt has since asked again) is left alone.
        """
        task_id, action = receipt["task_id"], receipt["action"]
        moved = {"unblocked"} if action == "reply" else {"review_reopened"}
        try:
            asked = int(str(receipt["token"]).rsplit(":", 1)[1])
        except (IndexError, ValueError):
            return "abandoned"

        def continued(conn):
            return any(event.kind in moved and event.id > asked
                       for event in owner.admission.kb.list_events(conn, task_id))

        def status(conn):
            task = owner.admission.kb.get_task(conn, task_id)
            return None if task is None else getattr(task, "status", "")

        # The common case needs no exclusive lock: Hermes already recorded the continuation.
        with owner.admission.reading() as conn:
            done, state = continued(conn), status(conn)
        if not done:
            if state is None or state in {"archived", "done"}:
                return "abandoned"
            with owner.admission.serialized() as conn:
                if not continued(conn):
                    control = owner.control_factory(conn, owner.admission.kb)
                    view = self._capture(db, row, conn, owner)
                    if (view["state"] != ("question" if action == "reply" else "result")
                            or not view["attention"]
                            or view["attention"]["token"] != receipt["token"]
                            or not control._workers_stopped(task_id)):
                        return None
                    changed = (
                        control.resume(task_id) if action == "reply"
                        else control.request_changes(
                            task_id, receipt["comment_key"], request["text"])
                    )
                    if not changed:
                        return None
        try:
            owner.admission.ready(task_id, resources=row["resources"])
        except UnsupportedControl:
            # Past the queue already (running, or parked on a later question or result) is fine.
            # Still waiting to be queued is not: leave it for the next read.
            with owner.admission.reading() as conn:
                if status(conn) in {"ready", "todo"}:
                    return None
        return "submitted"

    def feed(self, after=0):
        self.recover()
        owner = self.owner
        tasks = []
        for workflow in self.owners:
            with workflow.store.connection() as rows_db:
                journal = (nullcontext(rows_db) if workflow is owner
                           else owner.store.connection())
                with journal as db, workflow.admission.reading() as conn:
                    for row in workflow._rows(rows_db):
                        if row.get("task_id"):
                            tasks.append(self._capture(db, row, conn, workflow))
        with owner.store.connection() as db:
            # Cursor and events must describe one snapshot during concurrent polling.
            db.execute("BEGIN")
            events = []
            for entry in db.execute("SELECT id, body FROM attention_events WHERE id>? ORDER BY id",
                                    (after,)):
                events.append(dict(json.loads(entry["body"]), id=entry["id"]))
            submissions = [json.loads(r[0]) for r in db.execute(
                "SELECT receipt FROM attention_submissions")]
            cursor = db.execute("SELECT COALESCE(MAX(id),0) FROM attention_events").fetchone()[0]
            return dict(status="ok", cursor=cursor, events=events, tasks=tasks,
                        submissions=submissions,
                        needs_you_count=sum(t["required_action"] is not None for t in tasks))

    def submit(self, *, key, task_id, token, action, text):
        if action not in {"reply", "request_changes"} or not key.strip() or not text.strip():
            raise ValueError("action, submission key and text required")
        request = dict(task_id=task_id, token=token, action=action, text=text.strip())
        encoded = json.dumps(request, sort_keys=True)
        for owner in self.owners:
            with owner.store.locked() as rows_db:
                row = next((r for r in owner._rows(rows_db) if r["task_id"] == task_id), None)
                if row is None:
                    continue
                journal = (nullcontext(rows_db) if owner is self.owner
                           else self.owner.store.locked())
                with journal as db:
                    receipt, tick = self._submit(
                        db, rows_db, owner, row, key, task_id, token, action, text, encoded)
                if tick:
                    owner._tick(rows_db)
                return receipt
        raise NoDelegatedTask("task is not an actionable delegated occurrence")

    def _submit(self, db, rows_db, owner, row, key, task_id, token, action, text, encoded):
        old = db.execute("SELECT * FROM attention_submissions WHERE key=?", (key,)).fetchone()
        if old and old["request"] != encoded:
            raise OperationConflict("submission key has different content")
        if not old:
            for other in db.execute("SELECT request, receipt FROM attention_submissions"):
                prior = json.loads(other["request"])
                if prior["task_id"] == task_id and prior["token"] == token:
                    return dict(status="conflict", reason="attention_already_submitted",
                                submission=json.loads(other["receipt"])), False
        receipt = (json.loads(old["receipt"]) if old else
                   dict(status="pending", comment_key=str(uuid4()), key=key,
                        task_id=task_id, token=token, action=action))
        def save():
            db.execute("INSERT OR REPLACE INTO attention_submissions VALUES (?, ?, ?)",
                       (key, encoded, json.dumps(receipt)))
            db.commit()

        if receipt["status"] == "submitted":
            return receipt, False
        if receipt["status"] == "needs_reconciliation":
            settled = self._recover(db, owner, row, receipt, json.loads(encoded)) if row else None
            if settled:
                receipt.update(status=settled)
                save()
            return receipt, settled == "submitted"
        if not row or row["status"] in {"preparing", "preparation_attention", "done"}:
            raise ValueError("task is not an actionable delegated occurrence")

        with owner.admission.serialized() as conn:
            control = owner.control_factory(conn, owner.admission.kb)
            guard = owner.submission_guard(rows_db, row, control)
            row["guard"] = guard
            owner._save(rows_db, row)
            state = self._capture(db, row, conn, owner)
            expected = "question" if action == "reply" else "result"
            if guard["status"] != "active":
                return dict(status="attention", reason="source_veto", task=state), False
            if (state["state"] != expected or not state["attention"]
                    or state["attention"]["token"] != token):
                return dict(status="conflict", reason="attention_changed", task=state), False
            if not control._workers_stopped(task_id):
                return dict(status="attention", reason="worker_still_alive", task=state), False
            save()
            # Comment has its own durable host idempotency key. A failed response
            # here may safely replay before any lifecycle transition is attempted.
            receipt["comment_id"] = control.comment(task_id, receipt["comment_key"], text)
            receipt["status"] = "needs_reconciliation"
            save()
            # Persist uncertainty before commands that cannot be safely replayed
            # across a later question or result, even if the response disappears.
            changed = (control.resume(task_id) if action == "reply" else
                       control.request_changes(task_id, receipt["comment_key"], text))
            if not changed:
                raise UnsupportedControl("owner refused continuation")
        owner.admission.ready(task_id, resources=row["resources"])
        receipt.update(status="submitted", task_id=task_id, token=token, action=action)
        save()
        # Admission rereads source immediately before dispatch. Replays of this
        # receipt never dispatch again; owner ticks recover queued work.
        return receipt, True
