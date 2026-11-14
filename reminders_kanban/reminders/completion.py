"""Occurrence completion and conservative recovery. See completion.md."""

import json
from uuid import uuid4

from reminders_kanban.claims import strip_claims
from reminders_kanban.reminders import helper
from reminders_kanban.store import CompletionStore


def instructions(snapshot):
    """What the agent was asked to do. A claim line says who has the reminder, not what to do:
    it is left out, so adding, replacing or removing one is never an instruction change."""
    found = {key: snapshot.get(key) for key in ("title", "notes", "url")}
    found["notes"] = strip_claims(found["notes"]) or None
    return found


def same_identity(a, b):
    return all(a.get(k) and a[k] == b.get(k) for k in ("id", "externalId", "calendarId"))


class Completion:
    def __init__(self, path, call=helper.run):
        self.store = CompletionStore(path)
        self.call = call

    def authorize(self, expected, *, every_occurrence=False, explicit=False):
        """Called only for a deliberate delegation action, never import/link discovery."""
        if not explicit:
            raise ValueError("Explicit delegation required")
        if expected["completed"] or not expected["due"] or not same_identity(expected, expected):
            raise ValueError("Pending dated occurrence with full identity required")
        with self.store.locked() as db:
            rows = self.call("completion-read", calendarId=expected["calendarId"])
            if expected not in rows or self._copied(expected, rows):
                raise ValueError("Changed or ambiguous source")
            series, occurrence = str(uuid4()), str(uuid4())
            state = {
                "expected": expected,
                "every": every_occurrence,
                "instructions": instructions(expected),
            }
            db.execute(
                "INSERT INTO series VALUES (?, ?, ?)",
                (series, expected["calendarId"] + "/" + expected["id"], json.dumps(state)),
            )
            self._insert(db, occurrence, series, expected, rows)
            db.commit()
            return occurrence

    @staticmethod
    def _insert(db, occurrence, series, expected, rows):
        db.execute(
            "INSERT INTO occurrences VALUES (?, ?, ?, 0)",
            (occurrence, series, json.dumps({"expected": expected, "baseline": rows})),
        )

    @staticmethod
    def _copied(expected, rows):
        return any(
            not r["completed"]
            and r["id"] != expected["id"]
            and (
                (expected.get("url") and r.get("url") == expected["url"])
                or (expected.get("notes") and r.get("notes") == expected["notes"])
            )
            for r in rows
        )

    def accept(self, occurrence, result_id, *, interrupt=None, baseline=None):
        """Persist acceptance, write at most once, then reconcile; interrupt is a test hook."""
        with self.store.locked() as db:
            row = db.execute("SELECT * FROM occurrences WHERE id=?", (occurrence,)).fetchone()
            if row is None:
                raise KeyError(occurrence)
            state = json.loads(row["state"])
            attempt = db.execute(
                "SELECT state FROM attempts WHERE occurrence=?", (occurrence,)
            ).fetchone()
            written_rows = None
            if attempt is None:
                state["result_id"] = result_id
                db.execute(
                    "UPDATE occurrences SET state=? WHERE id=?", (json.dumps(state), occurrence)
                )
                db.execute("INSERT INTO attempts VALUES (?, ?)", (occurrence, "intent"))
                db.commit()
                if interrupt == "before_save":
                    raise InterruptedError("before save")
                rows = (baseline if baseline is not None else
                        self.call("completion-read", calendarId=state["expected"]["calendarId"]))
                if state["expected"] in rows and not self._copied(state["expected"], rows):
                    try:
                        receipt = self.call("complete-occurrence", expected=state["expected"])
                        if isinstance(receipt, dict):
                            written_rows = receipt.get("rows")
                        state["write_confirmed"] = True
                        db.execute("UPDATE occurrences SET state=? WHERE id=?",
                                   (json.dumps(state), occurrence))
                        db.commit()
                    except Exception:
                        # Intent remains durable even if the helper saved before its error.
                        pass
                if interrupt == "after_save":
                    raise InterruptedError("after save, before response")
            outcome = self._reconcile(db, row, state, rows=written_rows)
            if (state.get("write_confirmed")
                    and outcome.get("reason") == "source_unavailable"):
                outcome = self._reconcile(db, row, state)
            return outcome

    def _reconcile(self, db, row, state, *, propagate_errors=False, rows=None):
        expected = state["expected"]
        try:
            if rows is None:
                rows = self.call("completion-read", calendarId=expected["calendarId"])
        except Exception:
            if propagate_errors:
                raise
            return state.get("outcome") or state.get("confirmed") or {
                "status": "needs_reconciliation", "reason": "source_unavailable"
            }
        current = next((r for r in rows if same_identity(r, expected)), None)
        history = [
            r
            for r in rows
            if r["completed"]
            and r["due"] == expected["due"]
            and instructions(r) == instructions(expected)
        ]
        baseline_ids = {r["id"] for r in state["baseline"] if r["completed"]}
        valid = [r for r in history if r["id"] not in baseline_ids]
        reason = None
        if self._copied(expected, rows):
            reason = "copied_link"
        elif current is None:
            reason = "missing_identity"
        elif instructions(current) != instructions(expected):
            reason = "changed_instructions"
        elif len(history) != 1 or len(valid) != 1:
            reason = "conflicting_or_missing_history"
        elif not current["completed"] and current["due"] == expected["due"]:
            reason = "source_not_advanced"
        if reason:
            outcome = {"status": "needs_reconciliation", "reason": reason}
        else:
            outcome = {
                "status": "completed",
                "history_id": valid[0]["id"],
                "result_id": state["result_id"],
                "successor": current if not current["completed"] else None,
            }
            # Keep the first observed successor, so later replays cannot authorize a later date.
            state.setdefault("confirmed", outcome)
            outcome = state["confirmed"]
        state["outcome"] = outcome
        db.execute(
            "UPDATE occurrences SET state=?, done=? WHERE id=?",
            (json.dumps(state), int(row["done"] or outcome["status"] == "completed"), row["id"]),
        )
        db.execute("UPDATE attempts SET state=? WHERE occurrence=?", (outcome["status"], row["id"]))
        db.commit()
        return outcome

    def carry_forward(self, occurrence):
        """Create a pending local occurrence only from a verified, authorized successor."""
        with self.store.locked() as db:
            row = db.execute("SELECT * FROM occurrences WHERE id=?", (occurrence,)).fetchone()
            state = json.loads(row["state"])
            # An existing identity is a replay result, not permission to create more work.
            if state.get("next"):
                return state["next"]
            series = json.loads(
                db.execute("SELECT state FROM series WHERE id=?", (row["series"],)).fetchone()[0]
            )
            outcome = self._reconcile(db, row, state, propagate_errors=True)
            successor = outcome.get("successor")
            if not series["every"] or outcome["status"] != "completed" or not successor:
                raise ValueError(outcome.get("reason", "No authorized successor"))
            rows = self.call("completion-read", calendarId=successor["calendarId"])
            if (
                successor not in rows
                or self._copied(successor, rows)
                or instructions(successor) != instructions(series["instructions"])
            ):
                raise ValueError("Successor needs reconciliation")
            next_id = str(uuid4())
            self._insert(db, next_id, row["series"], successor, rows)
            state["next"] = next_id
            db.execute("UPDATE occurrences SET state=? WHERE id=?", (json.dumps(state), occurrence))
            db.commit()
            return next_id
