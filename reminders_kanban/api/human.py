"""Human actions, durable drafts and conservative retries. See human-contract.md."""

import fcntl
import hashlib
import json
import sqlite3
import time
from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, ConfigDict, Field

from reminders_kanban.api.preview import Home, card, operate
from reminders_kanban.claims import claims, classify, holder, mac_name, same_but_claims
from reminders_kanban.links import Links
from reminders_kanban.reminders import helper
from reminders_kanban.reminders.completion import Completion, instructions, same_identity
from reminders_kanban.reminders.edits import WRITE_LOCK
from reminders_kanban.store.preview import PreviewStore
from reminders_kanban.workflow.reconciliation import terminal

router = APIRouter()
DEFAULT_LABELS = {"agent": "[Agent]", "ready": "[Agent · Ready]"}


class Action(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation_id: str = Field(min_length=1, max_length=200)
    action: Literal["create", "edit", "progress", "complete", "reopen", "labels"]
    expected: dict[str, Any] | None = None
    fields: dict[str, Any] = Field(default_factory=dict)


class HumanCompletion(Completion):
    def _reconcile(self, db, row, state, *, rows=None):
        expected = state["expected"]
        if expected["rules"]:
            return super()._reconcile(db, row, state, rows=rows)
        try:
            if rows is None:
                rows = self.call("completion-read", calendarId=expected["calendarId"])
        except Exception:
            return state.get("outcome") or state.get("confirmed") or {
                "status": "needs_reconciliation", "reason": "source_unavailable"
            }
        current = next((r for r in rows if same_identity(r, expected)), None)
        if (
            expected in state["baseline"]
            and not expected["completed"]
            and current
            and current["completed"]
            and not current["rules"]
            and current["due"] == expected["due"]
            and instructions(current) == instructions(expected)
        ):
            result = {
                "status": "completed",
                "history_id": current["id"],
                "result_id": state["result_id"],
                "successor": None,
            }
        else:
            result = {"status": "needs_reconciliation", "reason": "source_not_completed"}
        if result["status"] == "completed":
            state.setdefault("confirmed", result)
        state["outcome"] = result
        db.execute(
            "UPDATE occurrences SET state=?, done=? WHERE id=?",
            (json.dumps(state), int(row["done"] or result["status"] == "completed"), row["id"]),
        )
        db.execute("UPDATE attempts SET state=? WHERE occurrence=?", (result["status"], row["id"]))
        db.commit()
        return result


def created_at(source):
    """A reminder's creation time as epoch seconds; 0 when it has none to compare."""
    try:
        return datetime.fromisoformat(source["created"].replace("Z", "+00:00")).timestamp()
    except (KeyError, AttributeError, ValueError):
        return 0


def patched(current, fields):
    """True when every edited field reads back as saved.

    A due date is stored with more components than a patch names (seconds, leap month, nulls):
    compare the ones the patch set, and an all-day patch must not read back with a time.
    """
    for key, value in fields.items():
        have = current.get(key)
        if key == "due" and isinstance(value, dict) and isinstance(have, dict):
            if any(have.get(part) != wanted for part, wanted in value.items()):
                return False
            if "hour" not in value and have.get("hour") is not None:
                return False
        elif have != value:
            return False
    return True


class Human:
    # How long after a write went unanswered before its helper's absence is trusted.
    grace = 20

    def __init__(self, home, call=helper.run, fixture_token=None, running=helper.still_running,
                 mac=None):
        self.home = home
        # This Mac's name (claims.py): tells a cloned install id's claims from its own.
        self._mac = mac
        self.call = call
        self.running = running
        # Test injection only. No request or environment switch enables fixture edits.
        self.fixture_token = fixture_token
        self.path = home / "reminders-kanban" / "state.sqlite3"
        self.store = PreviewStore(self.path)
        self.completion = HumanCompletion(self.path, call=call)
        with self.store.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS human_operations (
                    id TEXT PRIMARY KEY, request TEXT NOT NULL, outcome TEXT
                );
                CREATE TABLE IF NOT EXISTS human_pending (
                    id TEXT PRIMARY KEY, request TEXT, at REAL, failed REAL, gone REAL
                );
                CREATE TABLE IF NOT EXISTS human_progress (id TEXT PRIMARY KEY, state TEXT);
                CREATE TABLE IF NOT EXISTS human_labels (id INTEGER PRIMARY KEY, state TEXT);
            """)
            # A table made before `gone` existed keeps working.
            if "gone" not in {row[1] for row in db.execute("PRAGMA table_info(human_pending)")}:
                try:
                    db.execute("ALTER TABLE human_pending ADD COLUMN gone REAL")
                except sqlite3.OperationalError:
                    pass  # Another request added it first.

    @staticmethod
    def labels(db):
        row = db.execute("SELECT state FROM human_labels WHERE id=1").fetchone()
        return json.loads(row[0]) if row else DEFAULT_LABELS

    def agent_owned(self, source, labels):
        if any(source["title"].startswith(v) for v in labels.values()) or claims(
                source.get("notes")):
            return True
        path = self.home / "reminders-kanban/delegation.sqlite3"
        if not path.exists():
            return False
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
            return db.execute(
                "SELECT 1 FROM delegated WHERE source=?", (source["id"],)
            ).fetchone() is not None

    def _live(self):
        """Ids of reminders this install's Hermes has work out for (not finished or stopped)."""
        live = set()
        for name in ("delegation.sqlite3", "current-occurrences.sqlite3"):
            path = self.home / "reminders-kanban" / name
            if not path.exists():
                continue
            try:
                with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
                    states = db.execute(
                        "SELECT state FROM delegated "
                        "WHERE json_extract(state, '$.status') != 'done'").fetchall()
            except sqlite3.Error:
                continue
            for (state,) in states:
                row = json.loads(state)
                # Linked work only: a row still trying to claim the reminder holds nothing yet.
                if not terminal(row) and row.get("destination"):
                    live.add((row.get("source") or row["expected"])["id"])
        return live

    def claim_views(self, sources):
        """Each reminder's claims against this install: ({id: kind}, {id: other install's claim}).

        The second holds the reminders another Mac's Hermes has: a foreign claim in the notes and
        no live work for it here. Among several foreign claims the smallest owner id has it, the
        same tie-break the two installs settle by (claims.py).
        """
        links = Links(self.home)
        me, known = links.owner_id(create=False), None
        kinds, elsewhere = {}, {}
        for source in sources:
            if not claims(source.get("notes")):
                continue
            if known is None:
                known = links.known_links()
            view = classify(source.get("notes"), me, known.__contains__,
                            self._mac or mac_name())
            kinds[source["id"]] = view["kind"]
            if view["foreign"]:
                elsewhere[source["id"]] = holder(view["foreign"])
        if elsewhere:
            live = self._live()
            elsewhere = {key: claim for key, claim in elsewhere.items() if key not in live}
        if any(not source.get("completed") for source in sources
               if source["id"] in elsewhere):
            links.mark_foreign()
        return kinds, elsewhere

    @staticmethod
    def reopen_history(db):
        """What this board completed, by the completed reminder's id: [(expected, status)].

        One pass over the completion records. Each record also holds a snapshot of its whole
        list, which is left unparsed: only the two fields a reopen check needs are read.
        """
        history = {}
        for found, expected, status in db.execute(
            "SELECT json_extract(state, '$.outcome.history_id'), "
            "json_extract(state, '$.expected'), json_extract(state, '$.outcome.status') "
            "FROM occurrences"
        ):
            if found is not None:
                history.setdefault(found, []).append((json.loads(expected or "{}"), status))
        return history

    @classmethod
    def reopen_origin(cls, db, source, history=None):
        if source["rules"]:
            return "reopen_recurring_unsupported"
        known_one_off = False
        # history: reopen_history(db), built once by a caller that checks many reminders.
        for expected, status in (cls.reopen_history(db) if history is None else history).get(
                source["id"], ()):
            if expected.get("rules"):
                return "reopen_recurring_unsupported"
            if same_identity(expected, source) and status == "completed":
                known_one_off = True
        return None if known_one_off else "reopen_origin_unverified"

    @staticmethod
    def kept_column(kept, source):
        """To do or In progress for a human reminder. A repeating reminder's progress belongs to
        one date: once it rolls on, it starts over, even if the repeat is removed later. A
        one-off keeps its column when its date is moved. Reads only, so a stale board heals."""
        if not kept:
            return "To do"
        # Rows saved before this was recorded keep the old rule: any date change starts over.
        repeating = kept.get("repeating", True)
        if (repeating or source.get("rules")) and kept.get("due") != source.get("due"):
            return "To do"
        return kept.get("column", "To do")

    @staticmethod
    def keep_progress(db, expected, current):
        """A date moved by hand in the app is not a new occurrence: the column follows it."""
        kept = db.execute(
            "SELECT state FROM human_progress WHERE id=?", (expected["id"],)
        ).fetchone()
        state = json.loads(kept[0]) if kept else None
        if state and state.get("due") == expected.get("due"):
            db.execute(
                "INSERT OR REPLACE INTO human_progress VALUES (?, ?)",
                (expected["id"], json.dumps({**state, "due": current.get("due")})),
            )

    def reconcile_reopen(self, db, expected, fields, outcome):
        current = self.call("read", id=expected["id"])
        ignored = {"completed", "completedAt", "modified"}
        if (
            not expected.get("completed") or expected.get("rules")
            or current.get("completed") is not False or current.get("completedAt") is not None
            or set(current) != set(expected)
            or any(current[k] != v for k, v in expected.items() if k not in ignored)
        ):
            return outcome("uncertain", current=current)
        db.execute(
            "INSERT OR REPLACE INTO human_progress VALUES (?, ?)",
            (
                expected["id"],
                json.dumps(
                    {"column": fields["column"], "due": current.get("due"), "repeating": False,
                     "at": time.time()}
                ),
            ),
        )
        return outcome("ok", current=current, column=fields["column"])

    def confirm(self, db, operation_id, payload, outcome):
        """A complete or reopen that did land: its ok outcome, else None. Reads only."""
        if payload["action"] == "reopen":
            result = self.reconcile_reopen(db, payload["expected"], payload["fields"], outcome)
            return result if result["status"] == "ok" else None
        for row in db.execute("SELECT * FROM occurrences").fetchall():
            state = json.loads(row["state"])
            if state.get("result_id") == operation_id:
                self.completion.call = self.call
                completed = self.completion._reconcile(db, row, state)
                if completed["status"] == "completed":
                    return outcome("ok", completion=completed)
                db.execute(
                    "UPDATE attempts SET state='not_saved' WHERE occurrence=?", (row["id"],)
                )
        return None

    def settle(self, db, operation_id, payload):
        """Resolves an unanswered write by reading Reminders, never by saving again.

        Only once the helper that was launched for it can no longer save: it has exited and the
        grace period has passed. Returns the recorded outcome, or None while that isn't known.
        """
        action, expected, fields = payload["action"], payload["expected"], payload["fields"]
        if action not in {"create", "edit", "complete", "reopen"}:
            return None
        row = db.execute(
            "SELECT request, at, failed, gone FROM human_pending WHERE id=?", (operation_id,)
        ).fetchone()
        launched, at, failed, gone = row if row else (None, None, None, None)
        now = time.time()
        if self.running(launched):
            db.execute("UPDATE human_pending SET gone=NULL WHERE id=?", (operation_id,))
            db.commit()
            return None
        # Grace runs from when the helper was first seen gone, so a save it made on its way out
        # is readable. (An intent from before this table has no row: nothing to wait on.)
        if row and gone is None:
            gone = now
            db.execute("UPDATE human_pending SET gone=? WHERE id=?", (gone, operation_id))
            db.commit()
        if now - max(failed or at or 0, gone or 0) < self.grace:
            return None

        def outcome(status, **extra):
            return {
                "status": status, "operation_id": operation_id, "draft": payload,
                "before": expected, **extra,
            }

        owner = hashlib.sha256(str(self.home).encode()).hexdigest()
        try:
            if action in {"complete", "reopen"}:
                result = self.confirm(db, operation_id, payload, outcome)
                if not result:
                    try:
                        current = self.call("read", id=expected["id"])
                    except helper.HelperError as exc:
                        if exc.code != "not_found":
                            return None
                        result = outcome("not_found")
                    else:
                        # Exactly as it was: the write never happened. Otherwise it changed
                        # under the write, and the fresh copy is what to act on.
                        result = outcome(
                            "not_saved" if current == expected else "conflict", current=current
                        )
            elif action == "edit":
                try:
                    current = self.call("read", id=expected["id"])
                except helper.HelperError as exc:
                    if exc.code != "not_found":
                        return None
                    result = outcome("not_found")
                else:
                    if current == expected:
                        result = outcome("not_saved", current=current)
                    elif patched(current, fields):
                        if "due" in fields:
                            self.keep_progress(db, expected, current)
                        result = outcome("ok", current=current, card=card(current, owner))
                    else:
                        result = outcome("conflict", current=current)
            else:
                rows = self.call("completion-read", calendarId=fields["calendarId"])
                made = [
                    r for r in rows
                    if r.get("title") == fields["title"] and not r.get("completed")
                    and (at is None or created_at(r) >= at - 5)
                ]
                result = (
                    outcome("ok", current=made[0], card=card(made[0], owner))
                    if made else outcome("not_saved")
                )
        except Exception:
            return None
        db.execute(
            "UPDATE human_operations SET outcome=? WHERE id=?", (json.dumps(result), operation_id)
        )
        db.execute("DELETE FROM human_pending WHERE id=?", (operation_id,))
        db.commit()
        return result

    def board(self):
        result = operate(self.home, refresh=True)
        with self.store.locked() as db:
            labels = self.labels(db)
            # Built once: checking each completed card against every record made the board
            # slower with every reminder ever marked done here.
            history = self.reopen_history(db)
            origins = {
                c["source"]["id"]: self.reopen_origin(db, c["source"], history)
                for c in result["cards"] if c["source"]["completed"]
            }
            progress = {
                r[0]: json.loads(r[1]) for r in db.execute("SELECT id, state FROM human_progress")
            }
            # A one-off given a repeat after it was started follows the repeating rule from then
            # on. Only a flag is set, never a row removed, so an out-of-date read costs nothing.
            gained = {
                c["source"]["id"]: c["source"] for c in result["cards"]
                if c["source"].get("rules")
                and progress.get(c["source"]["id"], {}).get("repeating") is False
            }
            for one, source in gained.items():
                # Its progress belongs to the date it has now; the next date starts over.
                progress[one] = {**progress[one], "repeating": True, "due": source.get("due")}
                db.execute(
                    "INSERT OR REPLACE INTO human_progress VALUES (?, ?)",
                    (one, json.dumps(progress[one])),
                )
            if gained:
                db.commit()
        result["title_labels"] = labels
        kinds, elsewhere = self.claim_views([c["source"] for c in result["cards"]])
        for c in result["cards"]:
            source = c["source"]
            ready = source["title"].startswith(labels["ready"])
            agent = ready or source["title"].startswith(labels["agent"])
            c.update(owner="agent" if agent else "human", imported_ready=ready)
            # Apple strips the repeat from a completed copy. One this board checked off as an
            # occurrence of a repeating reminder still counts as repeating for the Repeats filter.
            if origins.get(source["id"]) == "reopen_recurring_unsupported":
                c["recurring"] = True
            c["column"] = (
                "Done"
                if source["completed"]
                else "Ready for Agent"
                if ready
                else "To do"
                if agent
                else self.kept_column(progress.get(source["id"]), source)
            )
            # When you last started it or put it back, so a later Stop is not mistaken for it.
            c["progress_at"] = progress.get(source["id"], {}).get("at")
            c["capabilities"] = {
                "edit": not agent and not source["completed"],
                "edit_fields": ["title", "notes", "priority", "calendarId", "due"],
                "due_modes": {
                    "all_day": not (source.get("start") or {}).get("timeZone"),
                    "clear": not source.get("rules"),
                    "clear_reason": "Repeating reminders need a date" if source.get("rules")
                    else None,
                    "timed": source.get("start") is None
                    or bool(source["start"].get("timeZone")),
                    "time_zone": (source.get("start") or {}).get("timeZone"),
                },
                "notes_mode": "append",
                "complete": not agent,
                "progress": not agent,
                "reopen": source["completed"] and origins.get(source["id"]) is None
                and not self.agent_owned(source, labels),
            }
            if source["id"] in kinds:
                c["claim"] = kinds[source["id"]]
            other = elsewhere.get(source["id"])
            if other and not source["completed"]:
                # Another Mac's Hermes is working on it: shown, never moved or edited from here.
                c.update(owner="agent", column="In progress", imported_ready=False,
                         elsewhere=dict(mac=other["mac"], url=other["url"]))
                c["capabilities"].update(edit=False, complete=False, progress=False)
        result["ready_count"] = sum(
            c["imported_ready"] and c["column"] != "Done" for c in result["cards"]
        )
        return result

    def apply(self, request):
        payload = request.model_dump()
        encoded = json.dumps(payload, sort_keys=True)
        expected, fields, action = request.expected, request.fields, request.action

        def outcome(status, **extra):
            return {
                "status": status,
                "operation_id": request.operation_id,
                "draft": payload,
                "before": expected,
                **extra,
            }

        # Shared adapter lock plus the existing profile store lock, held across calls.
        with WRITE_LOCK.open("a") as lock, self.store.locked() as db:
            fcntl.flock(lock, fcntl.LOCK_EX)
            previous = db.execute(
                "SELECT * FROM human_operations WHERE id=?", (request.operation_id,)
            ).fetchone()
            if previous:
                if previous["request"] != encoded:
                    return outcome("conflict", reason="operation_id_reused")
                if previous["outcome"]:
                    return json.loads(previous["outcome"])
                if action == "reopen":
                    try:
                        result = self.reconcile_reopen(db, expected, fields, outcome)
                    except Exception:
                        return outcome("uncertain")
                    if result["status"] == "ok":
                        db.execute(
                            "UPDATE human_operations SET outcome=? WHERE id=?",
                            (json.dumps(result), request.operation_id),
                        )
                        db.commit()
                        return result
                    return self.settle(db, request.operation_id, payload) or result
                if action == "complete":
                    for row in db.execute("SELECT * FROM occurrences"):
                        state = json.loads(row["state"])
                        if state.get("result_id") == request.operation_id:
                            self.completion.call = self.call
                            completed = self.completion._reconcile(db, row, state)
                            result = outcome(
                                "ok" if completed["status"] == "completed" else "uncertain",
                                completion=completed,
                            )
                            if result["status"] == "ok":
                                db.execute(
                                    "UPDATE human_operations SET outcome=? WHERE id=?",
                                    (json.dumps(result), request.operation_id),
                                )
                                db.commit()
                                return result
                            return self.settle(db, request.operation_id, payload) or result
                return self.settle(db, request.operation_id, payload) or outcome("uncertain")
            # A lost response blocks further writes, including a different operation ID, until
            # that earlier write can be settled from a fresh read.
            pending = db.execute(
                "SELECT id, request FROM human_operations WHERE outcome IS NULL"
            ).fetchone()
            if pending and not self.settle(db, pending[0], json.loads(pending[1])):
                return outcome("uncertain", pending_operation_id=pending[0])
            selected = self.store.read(db)["selected_list_ids"]
            launched = None
            try:
                if action == "labels":
                    if (
                        set(fields) != {"agent", "ready"}
                        or any(not isinstance(v, str) or not v.strip() for v in fields.values())
                        or fields["agent"].startswith(fields["ready"])
                        or fields["ready"].startswith(fields["agent"])
                    ):
                        return outcome("bad_request")
                    db.execute(
                        "INSERT OR REPLACE INTO human_labels VALUES (1, ?)", (json.dumps(fields),)
                    )
                    result = outcome("ok", title_labels=fields)
                else:
                    if action == "create":
                        if expected is not None or fields.get("calendarId") not in selected:
                            return outcome("bad_request", reason="selected_list_required")
                        if not isinstance(fields.get("title"), str) or not fields["title"].strip():
                            return outcome("bad_request")
                    else:
                        if (
                            not expected
                            or expected.get("calendarId") not in selected
                            or not expected.get("id")
                        ):
                            return outcome("bad_request", reason="selected_source_required")
                        current = self.call("read", id=expected["id"])
                        # Before the snapshot check: a claim that arrived since the form opened
                        # is the reason, not "changed in Reminders".
                        other = self.claim_views([current])[1].get(current["id"])
                        if other:
                            # Another Mac's Hermes has it: a change here would end its work.
                            return outcome("conflict", reason="other_mac", mac=other["mac"],
                                           current=current)
                        if current != expected and same_but_claims(current, expected):
                            # Only a claim line came or went since the board read it (one came
                            # off after a Stop): the same reminder, so go on from the fresh copy.
                            expected = current
                        if current != expected or (current["completed"] and action != "reopen"):
                            return outcome("conflict", current=current)
                        labels = self.labels(db)
                        if action == "reopen":
                            if set(fields) != {"column"} or fields["column"] not in {
                                "To do", "In progress"
                            }:
                                return outcome("bad_request")
                            if self.agent_owned(current, labels):
                                return outcome("agent_workflow_required", current=current)
                            if not current["completed"]:
                                return outcome("conflict", current=current)
                            origin = self.reopen_origin(db, current)
                            if origin:
                                return outcome(origin, current=current)
                        if any(current["title"].startswith(v) for v in labels.values()):
                            return outcome("conflict", reason="agent_owned", current=current)
                    if action in {"create", "edit"}:
                        if not fields or not set(fields) <= {
                            "title",
                            "notes",
                            "due",
                            "priority",
                            "calendarId",
                        }:
                            return outcome("gated_field")
                        if "calendarId" in fields and fields["calendarId"] not in selected:
                            return outcome("bad_request", reason="selected_list_required")
                    # A title that starts with an agent label is an agent task, on create and on
                    # edit alike (leading spaces don't change that: Reminders shows it the same).
                    if "title" in fields and isinstance(fields["title"], str) and any(
                        fields["title"].lstrip().startswith(v) for v in self.labels(db).values()
                    ):
                        return outcome("bad_request", reason="human_title_required")
                    if action == "edit" and not self.fixture_token:
                        if not set(fields) <= {"title", "notes", "priority", "calendarId", "due"}:
                            return outcome(
                                "gated_field",
                                reason="opaque_preservation_unproved",
                                current=current,
                            )
                        if "notes" in fields and (
                            not isinstance(fields["notes"], str)
                            or not fields["notes"].startswith(current["notes"] or "")
                        ):
                            return outcome(
                                "gated_field", reason="notes_append_only", current=current
                            )
                    if (action == "edit" and "due" in fields and fields["due"] is None
                            and current.get("rules")):
                        return outcome("gated_field", reason="due_recurring", current=current)
                    if action == "edit" and "due" in fields and current.get("start") is not None:
                        due = fields["due"]
                        if isinstance(due, dict):
                            if (due or {}).get("timeZone") != current["start"].get("timeZone"):
                                return outcome(
                                    "gated_field", reason="due_start_timezone", current=current
                                )
                    if action == "edit" and "calendarId" in fields and len(fields) != 1:
                        return outcome("bad_request", reason="move_separately", current=current)
                    if action == "progress":
                        if fields.get("column") not in {"To do", "In progress"} or set(fields) != {
                            "column"
                        }:
                            return outcome("bad_request")
                        db.execute(
                            "INSERT OR REPLACE INTO human_progress VALUES (?, ?)",
                            (
                                expected["id"],
                                json.dumps({
                                    "column": fields["column"],
                                    "due": expected.get("due"),
                                    "repeating": bool(expected.get("rules")),
                                    "at": time.time(),
                                }),
                            ),
                        )
                        result = outcome("ok", current=current, column=fields["column"])
                    else:
                        if action == "complete" and fields:
                            return outcome("bad_request")
                        # Committed before every external write, including completion.
                        db.execute(
                            "INSERT INTO human_operations VALUES (?, ?, NULL)",
                            (request.operation_id, encoded),
                        )
                        db.execute(
                            "INSERT OR REPLACE INTO human_pending (id, at) VALUES (?, ?)",
                            (request.operation_id, time.time()),
                        )
                        db.commit()
                        if action == "reopen":
                            self.call("human-reopen", id=expected["id"], expected=expected)
                            result = self.reconcile_reopen(db, expected, fields, outcome)
                        elif action == "complete":
                            rows = self.call("completion-read", calendarId=expected["calendarId"])
                            if expected not in rows or (
                                expected["rules"] and Completion._copied(expected, rows)
                            ):
                                result = outcome("conflict", reason="changed_or_ambiguous_source")
                            else:
                                series, occurrence = str(uuid4()), str(uuid4())
                                db.execute(
                                    "INSERT INTO series VALUES (?, ?, ?)",
                                    (series, "human/" + occurrence, json.dumps({"every": False})),
                                )
                                Completion._insert(db, occurrence, series, expected, rows)
                                db.commit()
                                # Reuse completion reconciliation under the held store lock.
                                db.execute(
                                    "INSERT INTO attempts VALUES (?, 'intent')", (occurrence,)
                                )
                                state = {
                                    "expected": expected,
                                    "baseline": rows,
                                    "result_id": request.operation_id,
                                }
                                db.execute(
                                    "UPDATE occurrences SET state=? WHERE id=?",
                                    (json.dumps(state), occurrence),
                                )
                                db.commit()
                                try:
                                    self.call("complete-occurrence", expected=expected)
                                except helper.HelperError as exc:
                                    if exc.code in {
                                        "conflict",
                                        "not_found",
                                        "access_denied",
                                        "bad_request",
                                    }:
                                        db.execute(
                                            "UPDATE attempts SET state=? WHERE occurrence=?",
                                            (exc.code, occurrence),
                                        )
                                        db.commit()
                                        raise
                                except Exception:
                                    pass
                                service = self.completion
                                service.call = self.call
                                row = db.execute(
                                    "SELECT * FROM occurrences WHERE id=?", (occurrence,)
                                ).fetchone()
                                completed = service._reconcile(db, row, state)
                                result = outcome(
                                    "ok" if completed["status"] == "completed" else "uncertain",
                                    completion=completed,
                                )
                        else:
                            current = (
                                self.call("human-create", fields=fields)
                                if action == "create"
                                else self.call(
                                    "human-fixture" if self.fixture_token else "human-edit",
                                    id=expected["id"],
                                    expected=expected,
                                    patch=fields,
                                    proofToken=self.fixture_token,
                                )
                            )
                            if action == "edit" and "due" in fields:
                                self.keep_progress(db, expected, current)
                            owner = hashlib.sha256(str(self.home).encode()).hexdigest()
                            result = outcome("ok", current=current, card=card(current, owner))
            except helper.HelperError as exc:
                launched = exc.request
                result = outcome(
                    exc.code
                    if exc.code in {
                        "access_denied", "conflict", "bad_request", "not_found", "move_refused"
                    }
                    else "uncertain",
                    current=exc.current,
                    reason="move_in_reminders" if exc.code == "move_refused" else None,
                )
            except Exception:
                # Any failure after intent may have followed an external save.
                result = outcome("uncertain")
            if result["status"] == "uncertain":
                # Keep intent unresolved: neither replay nor a new key may write again. A later
                # replay settles it from a fresh read once this helper can no longer save.
                db.execute(
                    "UPDATE human_pending SET request=?, failed=? WHERE id=?",
                    (launched, time.time(), request.operation_id),
                )
                db.commit()
                return result
            db.execute("DELETE FROM human_pending WHERE id=?", (request.operation_id,))
            db.execute(
                "INSERT OR REPLACE INTO human_operations VALUES (?, ?, ?)",
                (request.operation_id, encoded, json.dumps(result)),
            )
            db.commit()
            return result


def service(home: Home):
    return Human(home) if home else None


Service = Annotated[Human | None, Depends(service)]


@router.get("/human/board")
def board(response: Response, human: Service):
    response.headers["Cache-Control"] = "no-store"
    return human.board() if human else {"status": "unavailable_host"}


@router.post("/human/actions")
def apply(request: Action, response: Response, human: Service):
    response.headers["Cache-Control"] = "no-store"
    if not human:
        return {"status": "unavailable_host", "draft": request.model_dump()}
    try:
        return human.apply(request)
    except (OSError, sqlite3.Error):
        return {
            "status": "persistence_failed",
            "draft": request.model_dump(),
            "before": request.expected,
        }
