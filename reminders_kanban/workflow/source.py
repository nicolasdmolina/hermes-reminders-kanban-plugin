"""Durable source veto for an explicitly associated, supervised occurrence."""

import json

from reminders_kanban.claims import strip_claims
from reminders_kanban.execution import UnsupportedControl
from reminders_kanban.reminders import helper
from reminders_kanban.store import CompletionStore
from reminders_kanban.workflow.reconciliation import IDENTITY_ERRORS


def instructions(source):
    # Without claim lines (claims.py): who has the reminder is not part of what it asks for.
    return {"title": source.get("title"), "notes": strip_claims(source.get("notes")) or None}


class SourceGuard:
    def __init__(self, path, control, read=None, validate=None):
        self.store = CompletionStore(path)
        self.control = control
        self.validate = validate
        self.read = read or (lambda identity: helper.run("read", id=identity))
        with self.store.locked() as db:
            db.execute("CREATE TABLE IF NOT EXISTS source_guards "
                       "(task TEXT PRIMARY KEY, source TEXT UNIQUE, state TEXT NOT NULL)")
            db.commit()

    def _save(self, db, state):
        db.execute("UPDATE source_guards SET state=? WHERE task=?",
                   (json.dumps(state), state["task_id"]))
        db.commit()
        return dict(state)

    def _load(self, db, task):
        row = db.execute("SELECT state FROM source_guards WHERE task=?", (task,)).fetchone()
        if row is None:
            raise KeyError(task)
        return json.loads(row[0])

    def bind(self, task, expected):
        """Caller supplies explicit occurrence authority, never infer it from a label."""
        with self.store.locked() as db:
            row = db.execute("SELECT state FROM source_guards WHERE task=?", (task,)).fetchone()
            if row:
                state = json.loads(row[0])
                if state["source_id"] != expected["id"]:
                    raise ValueError("task already associated")
                return state
            fresh = self.read(expected["id"])
            if fresh != expected or fresh["completed"]:
                raise ValueError("source changed before association")
            state = dict(task_id=task, source_id=fresh["id"], source=fresh,
                         instruction_version=1, status="active", reason=None,
                         worker_stop_verified=False, reconciliation="not_required",
                         evidence=None, resume_pending=False, hidden=False)
            db.execute("INSERT INTO source_guards VALUES (?,?,?)",
                       (task, fresh["id"] + "/" + task, json.dumps(state)))
            db.commit()
            return state

    def _observe(self, db, state):
        reason = None
        fresh = None
        try:
            if self.validate:
                self.validate(state["source"])
            fresh = self.read(state["source_id"])
        except helper.HelperError as error:
            reason = ("deleted" if error.code == "not_found" else
                      error.code if error.code in IDENTITY_ERRORS | {"source_ineligible"}
                      else "source_unavailable")
        if reason == "source_unavailable":
            # Availability is an admission veto, not a source change. Preserve
            # the running attempt, question or review while source reads fail.
            state["source_wait"] = True
            if state["status"] == "active":
                self._save(db, state)
                return dict(state, status="waiting_source", reason="source_unavailable")
            reason = state["reason"]
        else:
            state["source_wait"] = False
        if fresh is not None:
            if fresh["completed"]:
                reason = "completed"
            elif fresh.get("externalId") != state["source"].get("externalId"):
                reason = "identity_changed"
            elif fresh.get("due") != state["source"].get("due"):
                reason = "occurrence_changed"
            elif instructions(fresh) != instructions(state["source"]):
                reason = "instructions_changed"
                state["instruction_version"] += 1
                state.pop("resume_message", None)
        if (state["status"] == "deleted"
                or (state["status"] == "stopped" and reason != "deleted")
                or (state["reason"] in IDENTITY_ERRORS | {"identity_changed", "occurrence_changed"}
                    and reason not in {"completed", "deleted"})):
            reason = state["reason"]
        if reason:
            status = {"deleted": "deleted", "completed": "stopped"}.get(reason, "paused")
            changed = reason != state["reason"] or (
                fresh is not None and instructions(fresh) != instructions(state["source"]))
            if changed:
                state.update(worker_stop_verified=False, reconciliation="required", evidence=None)
            state.update(status=status, reason=reason, resume_pending=False,
                         hidden=status == "deleted")
        if fresh is not None:
            state["source"] = fresh
        if state["resume_pending"] and not reason:
            host = self.control.observe(state["task_id"])
            if host["state"] not in {"ready", "active", "question", "result", "done"}:
                state.update(status="paused", reason="resume_uncertain",
                             reconciliation="required", worker_stop_verified=False)
            state["resume_pending"] = False
        # Persist the veto before touching the host. A crash retries only termination.
        self._save(db, state)
        if state["status"] != "active":
            observation = self.control.observe(state["task_id"])
            parked = "stopped" if state["status"] in {"stopped", "deleted"} else "paused"
            if not state["worker_stop_verified"] or observation["state"] != parked:
                state.update(worker_stop_verified=False, reconciliation="required", evidence=None)
                self._save(db, state)
                action = self.control.stop if parked == "stopped" else self.control.pause
                for _ in range(2):
                    try:
                        result = action(state["task_id"])
                        state["worker_stop_verified"] = result["worker_stop_verified"]
                        break
                    except UnsupportedControl:
                        # A worker may enter review between observation and schedule.
                        # Retain the durable veto even if another observation is needed.
                        continue
            return self._save(db, state)
        return state

    def observe(self, task):
        with self.store.locked() as db:
            return self._observe(db, self._load(db, task))

    def reconcile(self, task, *, instruction_version, evidence):
        """Trusted owner supplies inspected effects, never a frontend 'retry anyway'."""
        if not isinstance(evidence, str) or not evidence.strip():
            raise ValueError("verified external outcomes and history evidence required")
        with self.store.locked() as db:
            state = self._observe(db, self._load(db, task))
            if (state["instruction_version"] != instruction_version
                    or not state["worker_stop_verified"]):
                raise ValueError("stale reconciliation or worker still running")
            state.update(reconciliation="resolved", evidence=evidence)
            return self._save(db, state)

    def resume(self, task, *, instruction_version):
        with self.store.locked() as db:
            state = self._load(db, task)
            # A fresh read is mandatory even for a lost resume response.
            state = self._observe(db, state)
            if state["instruction_version"] != instruction_version:
                return state
            if state["status"] == "active":
                return state
            if (state["status"] != "paused"
                    or state["reason"] not in {
                        "instructions_changed", "resume_uncertain", "source_unavailable"}
                    or state["reconciliation"] != "resolved"
                    or not state["worker_stop_verified"]):
                return state
            state.setdefault("resume_message", "Use these updated source instructions:\n" +
                                 json.dumps(instructions(state["source"]), ensure_ascii=False) +
                                 "\nReconciled previous effects:\n" + state["evidence"])
            self._save(db, state)
            self.control.comment(task, f"source-version-{instruction_version}",
                                 state["resume_message"])
            # Commit before unblock. Recovery never blindly unblocks a second attempt.
            state.update(status="active", reason=None, resume_pending=True)
            self._save(db, state)
            resumed = self.control.resume(task)
            if not resumed:
                state.update(status="paused", reason="resume_uncertain",
                             reconciliation="required", worker_stop_verified=False)
            state["resume_pending"] = False
            return self._save(db, state)
