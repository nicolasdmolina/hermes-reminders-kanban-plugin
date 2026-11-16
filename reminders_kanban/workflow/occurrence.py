"""Explicit current-occurrence delegation; no successor pickup authority."""

import fcntl
import json
import time
from datetime import UTC, datetime
from uuid import uuid4

from reminders_kanban.claims import claims, holder, short
from reminders_kanban.execution import UnsupportedControl
from reminders_kanban.execution.recovery import Recovery
from reminders_kanban.links import page_url
from reminders_kanban.reminders import helper
from reminders_kanban.reminders.completion import Completion, instructions, same_identity
from reminders_kanban.reminders.edits import WRITE_LOCK
from reminders_kanban.store import CompletionStore
from reminders_kanban.workflow.delegation import Delegation, Elsewhere
from reminders_kanban.workflow.reconciliation import (
    IDENTITY_ERRORS,
    check_identity,
    completion_sources,
    fresh_source,
    limit_source,
    read_identity,
    selected_sources,
    terminal,
)

OWNER_CLOCKS = {}


def owner_clock():
    """Shared wall clock for route owners and trusted recovery owners."""
    return time.time()


class OccurrenceDelegation(Delegation):
    def __init__(self, *args, clock=None, **kwargs):
        super().__init__(*args, **kwargs)
        if clock is not None:
            self.clock = clock
        self.activation_store = self.store
        self.store = CompletionStore(self.home / "reminders-kanban/current-occurrences.sqlite3")
        self.completion = Completion(
            self.home / "reminders-kanban/current-completion.sqlite3", call=self.call
        )
        with self.store.connection() as db:
            db.execute("CREATE TABLE IF NOT EXISTS delegated (source TEXT PRIMARY KEY, state TEXT)")
            db.execute("CREATE TABLE IF NOT EXISTS observation "
                       "(id INTEGER PRIMARY KEY, state TEXT)")
            db.commit()

    @property
    def clock(self):
        return OWNER_CLOCKS.get(self.home.resolve(), owner_clock)

    @clock.setter
    def clock(self, value):
        OWNER_CLOCKS[self.home.resolve()] = value

    def submission_guard(self, db, row, control):
        # Conversation input cannot accept a source check-off or advance a series.
        if row.get("stop_intent") or row.get("accept_intent") or row.get("accepted"):
            return {"status": "paused"}
        try:
            fresh = read_identity(self, row["source"])
            baseline = completion_sources(self, row["source"]["calendarId"])
        except helper.HelperError as exc:
            return {"status": "paused", "reason": exc.code}
        if (fresh["calendarId"] not in self._selected()
                or fresh["completed"] or not self._completion_matches(row, fresh)
                or Completion._copied(row["source"], baseline)
                or row["status"] == "needs_reconciliation"):
            return {"status": "paused"}
        return {"status": "active"}

    def _active(self, db):
        # Pickup's on/off lives in the one-off workflow's store. Everything else takes that
        # store's lock before the admission lock; a pass here may already hold admission, so it
        # never waits for the store. When an action holds it, read the last committed value.
        try:
            with self.activation_store.locked(wait=False) as activation:
                return super()._active(activation)
        except BlockingIOError:
            with self.activation_store.connection() as activation:
                return super()._active(activation)

    def _active_to_dispatch(self, db):
        # Starting a worker needs the settled answer. While an action holds the store (it may be
        # turning pickup off), skip this start: the next pass decides.
        try:
            with self.activation_store.locked(wait=False) as activation:
                return super()._active(activation)
        except BlockingIOError:
            return False

    def _save(self, db, row):
        # However a row came to be stopped (the Stop button, a task archived in Hermes, a reminder
        # checked off and reopened), remember when it was first seen so. `stopped_at` stays the
        # verified Stop's own time (delegation-contract.md).
        seen = row.get("stopped_at") or row.get("stopped_seen_at")
        if row.get("status") == "stopped" and not seen:
            row["stopped_seen_at"] = datetime.now(UTC).isoformat()
        db.execute("INSERT INTO delegated VALUES (?, ?) "
            "ON CONFLICT(source) DO UPDATE SET state=excluded.state", (row["key"], json.dumps(row)))
        db.commit()
        return row

    def preview(self):
        # Lifecycle locks span EventKit calls. Display only committed state.
        with self.store.connection() as db:
            return self._preview(db)

    def _preview(self, db):
        with self.setup.connection() as setup:
            state = self.setup.read(setup)
        selected = state["selected_list_ids"]
        saved = db.execute("SELECT state FROM observation WHERE id=1").fetchone()
        observation = json.loads(saved[0]) if saved else {}
        sources = observation.get("current", [])
        observed_at = observation.get("observed_at")
        if (state.get("observed_at") or "") > (observed_at or ""):
            sources = [card["source"] for card in state["cards"]]
            observed_at = state["observed_at"]
        with self.activation_store.connection() as activation:
            active = super()._active(activation)
        return dict(
            status="ok", pickup_enabled=active, selected_list_ids=selected,
            limits=self.admission.observe(), eligible=[], tasks=self._task_views(db),
            current=[s for s in sources if s["calendarId"] in selected
                     and s["rules"] and not s["completed"]],
            observed_at=observed_at,
        )

    def _advance_question(self, db, row):
        if (row.get("advance_resolution") or row.get("accept_intent") or row.get("accepted")
                or row.get("completion", {}).get("reason") != "conflicting_or_missing_history"):
            return
        try:
            fresh = read_identity(self, row["source"])
        except helper.HelperError:
            return
        if (fresh["completed"] or fresh["due"] == row["source"]["due"]
                or instructions(fresh) != instructions(row["source"])
                or fresh["rules"] != row["source"]["rules"]):
            return
        if row.get("advance_snapshot") != fresh:
            row["source_accept_intent"] = str(uuid4())
        row.update(owner_question="checked_off_or_moved", advance_snapshot=fresh,
                   old_due=row["source"]["due"], new_due=fresh["due"])
        self._save(db, row)

    def _task_views(self, db):
        tasks = self._rows(db)
        with self.admission.reading() as conn:
            for row in tasks:
                if row.get("task_id"):
                    row.update(self.task_view(row, conn))
        return tasks

    @staticmethod
    def settled(row):
        # An accepted occurrence is done whatever its guard says (see task_view below).
        return row.get("status") == "done"

    def task_view(self, row, conn, observed=None):
        if observed is None and self.settled(row):
            return dict(self.settled_view(row), history=None, review_available=False)
        observed = observed or self.control_factory(conn, self.admission.kb).observe(row["task_id"])
        view = super().task_view(row, conn, observed)
        if row["status"] == "done":
            view.update(state="done", required_action=None, waiting=False)
        view["history"] = observed
        view["review_available"] = view["state"] == "result"
        return view

    @fresh_source()
    def _prepare(self, db, source, resources=(), *, every=False, rerun_of=None, takeover=False):
        """takeover: the person chose Take over here, so another install's claim is replaced.
        Without it a deliberate choice on a reminder another install has raises Elsewhere."""
        limit_source(source)
        rows = self._rows(db)

        def known(snapshot):
            return next(
                (
                    r
                    for r in reversed(rows)
                    if (r["expected"] == snapshot or r.get("source") == snapshot)
                    and (rerun_of is None or r.get("rerun_of") == rerun_of["key"])
                ),
                None,
            )

        prior = known(source)
        if prior is None:
            # A snapshot that differs from the reminder only by a claim line is the reminder.
            source = self._adopt_current(source)
            prior = known(source)
        view = self._claims(source)
        if prior and prior.get("released") and takeover:
            prior = None  # Taking it back: a new task, with the released one as its history.
        if prior and every and prior["scope"] != "every_occurrence":
            raise ValueError("current occurrence already delegated with different scope")
        if prior and prior["status"] not in {"preparing", "preparation_attention"}:
            return prior
        if prior:
            row = prior
        else:
            if view["foreign"] and not takeover:
                if rerun_of:
                    raise ValueError("another Mac has this reminder")
                if not any(r["expected"]["id"] == source["id"] and r["status"] != "done"
                           and not terminal(r) and not r.get("released") for r in rows):
                    raise Elsewhere(holder(view["foreign"]))
            if (
                source["completed"]
                or not source["rules"]
                or not source["due"]
                or source["calendarId"] not in self._selected()
                or not same_identity(source, source)
            ):
                raise ValueError(
                    "selected pending recurring occurrence with full identity required"
                )
            baseline = self.call("completion-read", calendarId=source["calendarId"])
            if source not in baseline or Completion._copied(source, baseline):
                raise ValueError("changed or ambiguous source")
            related = [r for r in rows if r["expected"]["id"] == source["id"]]
            if rerun_of:
                series = str(uuid4())
            elif related:
                latest = related[-1]
                # A row another Mac took from here is history whatever its stop came to; with
                # take over, so is one the person stopped here.
                if (latest.get("series_state") == "authorization_ended" or latest.get("released")
                        or (takeover and latest["status"] == "stopped")):
                    fresh = read_identity(self, latest["source"])
                    if fresh != source or not same_identity(fresh, latest["source"]):
                        raise ValueError("changed or ambiguous source")
                    return self._prepare(db, source, resources, every=every, rerun_of=latest,
                                         takeover=takeover)
                if latest["scope"] == "every_occurrence":
                    raise ValueError("ongoing series advances only through owner tick")
                if latest["status"] != "done":
                    raise ValueError("successor needs reconciliation")
                if not self._same_but_claims(latest["completion"].get("successor"), source):
                    # The reminder moved on since that occurrence was accepted (edited, or a
                    # later occurrence checked off by hand). It is still the same reminder, so
                    # this is a fresh delegation that keeps the earlier one as its history,
                    # not a dead end.
                    fresh = read_identity(self, latest["source"])
                    if fresh != source or not same_identity(fresh, latest["source"]):
                        raise ValueError("changed or ambiguous source")
                    return self._prepare(db, source, resources, every=every, rerun_of=latest)
                series = latest["authorization_id"]
            else:
                if view["mine"] or view["unknown"]:
                    raise ValueError("unrecognized inherited link needs reconciliation")
                series = str(uuid4())
            row = dict(
                expected=source,
                key=str(uuid4()),
                authorization_id=series,
                scope="every_occurrence" if every else "this_occurrence",
                instruction_version=1,
                resources=list(resources),
                status="preparing",
                task_id=None,
                accepted=False,
                takeover=takeover,
            )
            if rerun_of:
                row.update(
                    rerun_of=rerun_of["key"],
                    link_authorization_id=rerun_of.get(
                        "link_authorization_id", rerun_of["authorization_id"]
                    ),
                    prior_effects=rerun_of.get("rerun_reconciliation", {}).get("evidence"),
                )
            elif related and related[-1].get("link_authorization_id"):
                row["link_authorization_id"] = related[-1]["link_authorization_id"]
            self._save(db, row)
        original = row["expected"]
        with self.admission.serialized() as conn:
            control = self.control_factory(conn, self.admission.kb)
            task = control.create(
                row["key"],
                original["title"],
self._body_notes(original) + "\nNever complete the source reminder."
                + (
                    "\nPrior run reconciliation; inspect before repeating actions:\n"
                    + row["prior_effects"]
                    if row.get("prior_effects")
                    else ""
                ),
                assignee=self.profile,
            )
            self.admission.hold(conn, task)
            row["task_id"] = task
            self._save(db, row)
        owner, link = self.links.bind(
            row.get("link_authorization_id", row["authorization_id"]),
            row["key"],
            self.admission.board,
            task,
            self.profile,
        )
        current = self.call("read", id=original["id"])
        try:
            if "claim_start" not in row:
                row["claim_start"] = int(self.now())
                self._save(db, row)
            target, line, url = self._claim_plan(
                original.get("notes"), owner, link, takeover=row.get("takeover"),
                start=row["claim_start"])
            if not self.write_link and not url:
                target, line = original.get("notes") or "", None  # No writer: no claim line.
            if line:  # A line already in the notes keeps the start it was written with.
                row["claim_start"] = next(c["start"] for c in claims(line))
            written = self._claim_landed(current, link, target, takeover=row.get("takeover"))
        except Elsewhere as other:
            return self._release(db, row, reason="taken_over", claim=other.claim)
        if current != original:
            comparison = dict(
                current, notes=original.get("notes"), modified=original.get("modified")
            )
            if not written or comparison != original:
                row["status"] = "preparation_attention"
                return self._save(db, row)
            row.setdefault("claimed_at", self.now())
        elif not written:
            if row.get("link_intent"):
                row["status"] = "preparation_attention"
                return self._save(db, row)
            row["link_intent"] = True
            self._save(db, row)
            with WRITE_LOCK.open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                current = self.write_link(original, target)
            row["claimed_at"] = self.now()
        else:
            # Inherited from the last occurrence: it has been in the notes all along.
            row.setdefault("claimed_at", 0)
        row.update(source=current, claim=line,
                   destination=dict(owner_id=owner, link_id=link, url=page_url(url)))
        baseline = self.call("completion-read", calendarId=current["calendarId"])
        if current not in baseline or Completion._copied(current, baseline):
            raise ValueError("changed or ambiguous source")
        with self.completion.store.locked() as completion:
            if not completion.execute(
                "SELECT id FROM occurrences WHERE id=?", (row["key"],)
            ).fetchone():
                completion.execute(
                    "INSERT OR IGNORE INTO series VALUES (?, ?, ?)",
                    (
                        row["authorization_id"],
                        original["calendarId"]
                        + "/"
                        + original["id"]
                        + ("/" + row["key"] if row.get("rerun_of") else ""),
                        json.dumps(
                            dict(
                                every=True,
                                instructions=instructions(current),
                                instruction_version=1,
                            )
                        )
                        if row["scope"] == "every_occurrence"
                        else '{"every":false}',
                    ),
                )
                if row["scope"] == "every_occurrence":
                    authorization = json.loads(
                        completion.execute(
                            "SELECT state FROM series WHERE id=?", (row["authorization_id"],)
                        ).fetchone()[0]
                    )
                    if not authorization["every"]:
                        completion.execute(
                            "UPDATE series SET state=? WHERE id=?",
                            (
                                json.dumps(
                                    dict(
                                        every=True,
                                        instructions=instructions(current),
                                        instruction_version=1,
                                    )
                                ),
                                row["authorization_id"],
                            ),
                        )
                self.completion._insert(
                    completion, row["key"], row["authorization_id"], current, baseline
                )
                completion.commit()
        with self.admission.serialized() as conn:
            self.control_factory(conn, self.admission.kb).resume(task)
        self.admission.ready(task, resources=row["resources"])
        row["status"] = "ready"
        return self._save(db, row)

    def _successor_taken(self, row):
        """Between occurrences of an Every series: another install's claim that keeps the
        reminder now (claims.holder), or None."""
        try:
            current = self.call("read", id=row["source"]["id"])
        except helper.HelperError:
            return None
        view = self._claims(current)
        own = [c for c in view["mine"] if c["link"] == short((row.get("destination") or {}).get(
            "link_id"))]
        if not view["foreign"] or current.get("completed"):
            return None
        keeper = holder(own + view["foreign"])
        return None if any(keeper is c for c in own) else keeper

    @staticmethod
    def _same_but_claims(successor, source):
        """The successor Apple made, give or take a claim line: releasing this install's claim
        after an accepted occurrence (release_claims) is not the reminder moving on."""
        if not successor:
            return False
        plain = dict(successor, modified=None, **instructions(successor))
        return plain == dict(source, modified=None, **instructions(source))

    def _source_accept(self, db, row, control):
        # Observed check-off is read-only recovery. Never send a native completion.
        with self.completion.store.locked() as completion:
            occurrence = completion.execute(
                "SELECT * FROM occurrences WHERE id=?", (row["key"],)
            ).fetchone()
            state = json.loads(occurrence["state"])
            state.setdefault("result_id", row["key"])
            completion.execute(
                "UPDATE occurrences SET state=? WHERE id=?", (json.dumps(state), row["key"])
            )
            completion.execute(
                "INSERT OR IGNORE INTO attempts VALUES (?, ?)", (row["key"], "source_accept_intent")
            )
            completion.commit()
            outcome = self.completion._reconcile(completion, occurrence, state)
        row["completion"] = outcome
        if outcome.get("reason") == "conflicting_or_missing_history":
            row.setdefault("source_accept_intent", str(uuid4()))
            row["owner_question"] = "checked_off_or_moved"
            row["old_due"] = row["source"]["due"]
            row["advance_snapshot"] = self.call("read", id=row["source"]["id"])
            row["new_due"] = row["advance_snapshot"]["due"]
        if outcome["status"] != "completed":
            return False
        row.update(accept_intent=True, guard={"status": "paused"})
        self._save(db, row)
        try:
            control.accept(row["task_id"])
        except UnsupportedControl:
            # Review may be published before the worker exits. Reobserve on the next tick.
            row["status"] = "result"
            self._save(db, row)
            return True
        row.update(accepted=True, status="done")
        self._save(db, row)
        return True

    def resolve_advance(self, occurrence_id, expected, intent_id, answer):
        if answer not in {"checked_off", "date_moved"}:
            raise ValueError("checked_off or date_moved required")
        with self.store.locked() as db:
            self._active(db)
            row = next((r for r in self._rows(db) if r["key"] == occurrence_id), None)
            if row is None:
                return dict(status="not_found")
            self._advance_question(db, row)
            request = dict(expected=expected, intent_id=intent_id, answer=answer)
            with self.completion.store.locked() as completion:
                occurrence = completion.execute(
                    "SELECT * FROM occurrences WHERE id=?", (row["key"],)
                ).fetchone()
                state = json.loads(occurrence["state"])
                receipt = state.get("advance_resolution")
                if receipt and receipt["request"] != request:
                    return dict(status="conflict", reason="advance_already_resolved", task=row)
                if receipt and row.get("advance_resolution") == receipt:
                    return dict(status="ok", task=row, receipt=receipt)
                if not receipt:
                    fresh = read_identity(self, row["source"])
                    def refuse(reason):
                        return dict(status="conflict", reason=reason, current=fresh, task=row)
                    if (not intent_id or intent_id != row.get("source_accept_intent")
                            or expected != fresh or expected != row.get("advance_snapshot")):
                        return refuse("stale_advance")
                    if (row.get("owner_question") != "checked_off_or_moved"
                            or instructions(fresh) != instructions(row["source"])
                            or fresh["rules"] != row["source"]["rules"]
                            or fresh["completed"] or fresh["due"] == row["source"]["due"]
                            or fresh["calendarId"] not in self._selected()):
                        return refuse("source_needs_reconciliation")
                    rows = self.call("completion-read", calendarId=fresh["calendarId"])
                    if fresh not in rows or Completion._copied(fresh, rows):
                        return refuse("source_needs_reconciliation")
                    history = [r for r in rows if r["completed"]
                               and r["due"] == row["source"]["due"]
                               and instructions(r) == instructions(row["source"])]
                    baseline = {r["id"] for r in state["baseline"] if r["completed"]}
                    if (len(history) > 1 or any(r["id"] in baseline for r in history)
                            or (answer == "date_moved" and history)):
                        return refuse("history_contradicts_answer")
                    with self.admission.serialized() as conn:
                        if not self.control_factory(conn, self.admission.kb)._workers_stopped(
                                row["task_id"]):
                            return refuse("worker_still_alive")
                    receipt = dict(request=request, recorded_at=self.clock())
                    state["advance_resolution"] = receipt
                    if answer == "checked_off":
                        state["confirmed"] = dict(
                            status="completed", history_id=history[0]["id"] if history else None,
                            result_id=state["result_id"], successor=fresh,
                            acceptance="owner_checked_off")
                        state["outcome"] = state["confirmed"]
                    else:
                        state.pop("outcome", None)
                        completion.execute("DELETE FROM attempts WHERE occurrence=?", (row["key"],))
                    completion.execute("UPDATE occurrences SET state=?, done=? WHERE id=?",
                                       (json.dumps(state), int(answer == "checked_off"),
                                        row["key"]))
                    completion.execute("UPDATE series SET state=? WHERE id=?",
                                       ('{"every":false}', row["authorization_id"]))
                    completion.commit()
            row.update(advance_resolution=receipt, scope="this_occurrence")
            row.pop("owner_question", None)
            row.pop("source_accept_intent", None)
            if answer == "checked_off":
                row.update(accepted=True, status="done", completion=state["confirmed"])
            else:
                row.pop("completion", None)
                row.update(status="stopped" if row.get("stop_intent") else "paused",
                           reason="source_occurrence_changed", guard={"status": "paused"})
            self._save(db, row)
            return dict(status="ok", task=row, receipt=receipt)

    def _observe_before_stop(self, db, row, conn):
        # Stop must never reconcile acceptance or write a completion to Reminders.
        # A finished Hermes task can still have an unfinished reminder completion.
        # Only the durable occurrence's done state makes Stop a finished no-op.
        return row

    def _observe(self, db, row, conn):
        if row["status"] == "done":
            return row
        if row.get("stop_intent"):
            return self._finish_stop(db, row, conn)
        if row["status"] in {"preparing", "preparation_attention", "done"}:
            return row
        control = self.control_factory(conn, self.admission.kb)
        observed = control.observe(row["task_id"])
        if observed["state"] == "done" and row.get("accept_intent"):
            row["accepted"] = True
        if row["accepted"]:
            return self._accept(db, row, control)
        if self._settle_claims(db, row, conn, observed["state"]):
            return row
        identity_reason = None
        try:
            identity_reason = check_identity(
                row["source"], selected_sources(self), self.install
            )
            baseline = completion_sources(self, row["source"]["calendarId"])
        except helper.HelperError:
            row["source_wait"] = True
            if row["status"] != "needs_reconciliation":
                row["guard"] = {"status": "waiting_source", "reason": "source_unavailable"}
            return self._save(db, row)
        row["source_wait"] = False
        fresh = next((s for s in baseline if same_identity(s, row["source"])), None)
        if (
            fresh
            and not identity_reason
            and not row.get("advance_resolution")
            and observed["state"] == "result"
            and fresh["calendarId"] in self._selected()
            and (fresh["completed"] or fresh["due"] != row["source"]["due"])
        ):
            if self._source_accept(db, row, control):
                return row
        with self.completion.store.connection() as completion_db:
            saved = completion_db.execute(
                "SELECT state FROM occurrences WHERE id=?", (row["key"],)
            ).fetchone()
        prior_ids = {s["id"] for s in json.loads(saved[0])["baseline"]}
        new_history = any(
            s["completed"] and s["id"] not in prior_ids
            and s.get("due") == row["source"].get("due")
            and instructions(s) == instructions(row["source"])
            for s in baseline
        )
        if (
            identity_reason
            or new_history
            or fresh is None
            or fresh["completed"]
            or not self._completion_matches(row, fresh)
            or Completion._copied(row["source"], baseline)
        ):
            row.update(
                status="needs_reconciliation",
                reason=identity_reason or "source_occurrence_changed",
                guard={"status": "paused"},
            )
            self._save(db, row)
            control.pause(row["task_id"])
            conn.execute(
                "UPDATE rk_admission SET park_event=NULL WHERE task_id=?", (row["task_id"],)
            )
            conn.commit()
        elif row["status"] != "needs_reconciliation":
            row["status"] = observed["state"]
            row["guard"] = {"status": "active"}
            Recovery(control).observe(row)
            if row["scope"] == "every_occurrence":
                try:
                    schedule = self.call("occurrence-schedule", id=fresh["id"], expected=fresh)
                except helper.HelperError:
                    row["source_wait"] = True
                    row["guard"] = {"status": "waiting_source", "reason": "source_unavailable"}
                    return self._save(db, row)
                row["due_at"] = schedule["due_at"]
                row["held_reason"] = None
                if self.clock() < row["due_at"]:
                    row["guard"] = {"status": "waiting_due"}
                    row["held_reason"] = "not_due"
                elif observed["state"] in {"question", "result"}:
                    row["held_reason"] = observed["state"]
                elif row.get("recovery"):
                    row["held_reason"] = "recovery"
        return self._save(db, row)

    def _due(self, row, rows):
        """As the one-off's, plus what _tick does for a finished occurrence: start an Every
        occurrence series' next one, give a hold its id, and ask about a moved date."""
        if super()._due(row, rows):
            return True
        state = row.get("series_state")
        if (row["scope"] == "every_occurrence" and row["status"] == "done"
                and not any(r.get("predecessor") == row["key"] for r in rows)
                and state not in {"needs_reconciliation", "authorization_ended"}
                # A series that ended for want of a successor is only saved as ended again.
                and (row["completion"].get("successor") or state != "ended")):
            return True
        if state == "needs_reconciliation" and not row.get("hold_id"):
            return True
        return not (row.get("advance_resolution") or row.get("accept_intent")
                    or row.get("accepted")
                    or row.get("completion", {}).get("reason") != "conflicting_or_missing_history")

    def _tick(self, db, *, keys=None):
        rows = self._rows(db)
        for row in rows:
            if not self._active(db):
                break
            if keys is not None and row["key"] not in keys:
                continue
            if row["scope"] != "every_occurrence" or row["status"] != "done":
                continue
            if any(r.get("predecessor") == row["key"] for r in rows):
                continue
            if row.get("series_state") in {"needs_reconciliation", "authorization_ended"}:
                continue
            if not row["completion"].get("successor"):
                row["series_state"] = "ended"
                self._save(db, row)
                continue
            other = self._successor_taken(row)
            if other:
                # The other Mac took the reminder between two occurrences: the series ends
                # here, with nothing for the person to do.
                row.update(series_state="authorization_ended", held_reason=None,
                           released=dict(reason="taken_over", mac=other["mac"],
                                         owner=other["owner"], url=other.get("url"),
                                         at=datetime.now(UTC).isoformat()))
                self._save(db, row)
                continue
            try:
                key = self.completion.carry_forward(row["key"])
                with self.completion.store.locked() as completion:
                    pending = json.loads(
                        completion.execute(
                            "SELECT state FROM occurrences WHERE id=?", (key,)
                        ).fetchone()[0]
                    )["expected"]
                successor = dict(
                    expected=pending,
                    key=key,
                    authorization_id=row["authorization_id"],
                    scope="every_occurrence",
                    instruction_version=1,
                    link_authorization_id=row.get("link_authorization_id", row["authorization_id"]),
                    resources=row["resources"],
                    status="preparing",
                    task_id=None,
                    accepted=False,
                    predecessor=row["key"],
                )
                self._save(db, successor)
                row.update(series_state="active", held_reason=None)
                self._save(db, row)
            except helper.HelperError as exc:
                if exc.code not in IDENTITY_ERRORS | {"not_found", "copied_link", "conflict"}:
                    row.update(series_state="waiting_source", held_reason=exc.code)
                else:
                    row.update(
                        series_state="needs_reconciliation",
                        held_reason=exc.code,
                        hold_id=str(uuid4()),
                    )
                self._save(db, row)
            except ValueError as exc:
                row.update(
                    series_state="needs_reconciliation", held_reason=str(exc), hold_id=str(uuid4())
                )
                self._save(db, row)
        result = super()._tick(db, keys=keys)
        for row in self._rows(db):
            if keys is not None and row["key"] not in keys:
                continue
            if row.get("series_state") == "needs_reconciliation" and not row.get("hold_id"):
                row["hold_id"] = str(uuid4())
                self._save(db, row)
            self._advance_question(db, row)
        selected = self._selected()
        try:
            sources = selected_sources(self) if selected else []
        except helper.HelperError:
            # Preserve the last successful observation when the source is unavailable.
            result["tasks"] = self._rows(db)
            return result
        observation = dict(current=sources, observed_at=datetime.now(UTC).isoformat())
        db.execute("INSERT OR REPLACE INTO observation VALUES (1, ?)",
                   (json.dumps(observation),))
        db.commit()
        result["tasks"] = self._rows(db)
        return result

    def resolve_series(self, occurrence_id, expected, hold_id, decision, confirmed_cause):
        if decision not in {"end", "reauthorize"}:
            raise ValueError("end or reauthorize required")
        request = dict(
            expected=expected, hold_id=hold_id, decision=decision, confirmed_cause=confirmed_cause
        )
        with self.store.locked() as db:
            self._active(db)
            row = next((r for r in self._rows(db) if r["key"] == occurrence_id), None)
            if row is None:
                return dict(status="not_found")
            with self.completion.store.locked() as completion:
                saved = completion.execute(
                    "SELECT * FROM occurrences WHERE id=?", (row["key"],)
                ).fetchone()
                state = json.loads(saved["state"])
                receipt = state.get("series_resolution")
                if receipt and receipt["request"] != request:
                    return dict(status="conflict", reason="series_already_resolved", task=row)
                if not receipt:
                    if (
                        not hold_id
                        or row.get("hold_id") != hold_id
                        or row.get("series_state") != "needs_reconciliation"
                        or row["status"] != "done"
                        or state.get("next")
                    ):
                        return dict(status="conflict", reason="stale_hold", task=row)
                    fresh = read_identity(self, row["source"])
                    if expected != fresh or not same_identity(fresh, row["source"]):
                        return dict(status="conflict", reason="stale_source", task=row)
                    baseline = self.call("completion-read", calendarId=fresh["calendarId"])
                    if (
                        fresh not in baseline
                        or Completion._copied(fresh, baseline)
                        or fresh["completed"]
                        or fresh["calendarId"] not in self._selected()
                    ):
                        raise ValueError("source needs reconciliation")
                    history = [
                        r
                        for r in baseline
                        if r["completed"]
                        and r["due"] == row["source"]["due"]
                        and instructions(r) == instructions(row["source"])
                    ]
                    if len(history) != 1 or history[0]["id"] != row["completion"].get("history_id"):
                        raise ValueError("history needs reconciliation")
                    if decision == "reauthorize" and (
                        confirmed_cause != row.get("held_reason")
                        or not fresh["rules"]
                        or not fresh["due"]
                    ):
                        raise ValueError("confirm held cause and pending recurring snapshot")
                    receipt = dict(
                        request=request,
                        recorded_at=self.clock(),
                        authorization_id=str(uuid4()),
                        key=str(uuid4()),
                    )
                    if decision == "reauthorize":
                        completion.execute(
                            "INSERT INTO series VALUES (?, ?, ?)",
                            (
                                receipt["authorization_id"],
                                fresh["calendarId"] + "/" + fresh["id"] + "/" + receipt["key"],
                                json.dumps(
                                    dict(
                                        every=True,
                                        instructions=instructions(fresh),
                                        instruction_version=1,
                                    )
                                ),
                            ),
                        )
                        self.completion._insert(
                            completion, receipt["key"], receipt["authorization_id"], fresh, baseline
                        )
                    completion.execute(
                        "UPDATE series SET state=? WHERE id=?",
                        ('{"every":false}', row["authorization_id"]),
                    )
                    state["series_resolution"] = receipt
                    completion.execute(
                        "UPDATE occurrences SET state=? WHERE id=?", (json.dumps(state), row["key"])
                    )
                    completion.commit()
            row.update(series_state="authorization_ended", series_resolution=receipt)
            if decision == "reauthorize" and not any(
                r["key"] == receipt["key"] for r in self._rows(db)
            ):
                self._save(
                    db,
                    dict(
                        expected=expected,
                        key=receipt["key"],
                        authorization_id=receipt["authorization_id"],
                        scope="every_occurrence",
                        link_authorization_id=row.get(
                            "link_authorization_id", row["authorization_id"]
                        ),
                        instruction_version=1,
                        resources=row["resources"],
                        status="preparing",
                        task_id=None,
                        accepted=False,
                        predecessor=row["key"],
                    ),
                )
            self._save(db, row)
            return dict(status="ok", task=row, tasks=self._rows(db), receipt=receipt)

    def reconcile_attempt(self, occurrence_id, **receipt):
        """Trusted receipt addressed by occurrence rather than reused source ID."""
        with self.store.locked() as db:
            row = next(r for r in self._rows(db) if r["key"] == occurrence_id)
            with self.admission.serialized() as conn:
                row = self._observe(db, row, conn)
                if row.get("guard", {}).get("status") != "active":
                    raise ValueError("source does not authorize recovery")
                Recovery(self.control_factory(conn, self.admission.kb)).reconcile(row, **receipt)
                return self._save(db, row)

    @fresh_source()
    def _apply(
        self,
        action,
        *,
        expected=None,
        occurrence_id=None,
        resources=(),
        take_over=False,
        run_id=None,
        intent_id=None,
        answer=None,
        hold_id=None,
        decision=None,
        confirmed_cause=None,
    ):
        if action == "tick":
            return self.tick()
        if action == "resolve_series":
            return self.resolve_series(occurrence_id, expected, hold_id, decision, confirmed_cause)
        if action == "resolve_advance":
            return self.resolve_advance(occurrence_id, expected, intent_id, answer)
        if action == "confirm_rerun":
            return self.confirm_rerun(occurrence_id=occurrence_id, run_id=run_id)
        if action == "stop":
            with self.store.locked() as db:
                self._active(db)
                row = next((r for r in self._rows(db) if r["key"] == occurrence_id), None)
                if row is None or not row.get("task_id"):
                    return dict(status="not_found", outcome="not_found")
                task_id = row["task_id"]
            return self.stop(task_id)
        with self.store.locked() as db:
            if action in {"ready", "every"}:
                if not self._active(db):
                    return dict(status="inactive")
                if not self.local_mode and (not self.origin or not self.write_link):
                    return dict(status="setup_required", reason="task_link_writer_unavailable")
                try:
                    self._prepare(db, expected, resources, every=action == "every",
                                  takeover=take_over)
                except Elsewhere as other:
                    return dict(self._action_result(db), status="conflict", reason="other_mac",
                                mac=other.claim["mac"])
            elif action == "rerun":
                rows = self._rows(db)
                row = next((r for r in rows if r["key"] == occurrence_id), None)
                if row is None:
                    raise ValueError("unknown occurrence")
                replay = next((r for r in rows if r.get("rerun_of") == occurrence_id), None)
                if replay:
                    return dict(status="ok", task=replay, tasks=rows)
                if row["status"] not in {"paused", "needs_reconciliation", "stopped"}:
                    raise ValueError("paused changed occurrence or stopped occurrence required")
                if row["status"] != "stopped" and row.get("reason") != "source_occurrence_changed":
                    raise ValueError("source needs reconciliation")
                if not self.local_mode and (not self.origin or not self.write_link):
                    return dict(status="setup_required", reason="task_link_writer_unavailable")
                # A claim line that came off since the board read it is not a changed reminder.
                expected = self._adopt_current(expected)
                self._check_redelegation(db, row, expected)
                if not expected.get("rules") or not expected.get("due"):
                    raise ValueError("pending recurring occurrence required")
                baseline = self.call("completion-read", calendarId=expected["calendarId"])
                if expected not in baseline or Completion._copied(expected, baseline):
                    raise ValueError("changed or ambiguous source")
                with self.admission.serialized() as conn:
                    row["stop_intent"] = True
                    self._save(db, row)
                    self._finish_stop(db, row, conn)
                if row["status"] != "stopped":
                    return dict(status="needs_reconciliation", task=row)
                self._check_redelegation(db, row, expected)
                new = self._prepare(db, expected, row["resources"], rerun_of=row)
                result = self._tick(db, keys={new["key"]})
                result["task"] = next(r for r in result["tasks"] if r["key"] == new["key"])
                return result
            elif action == "accept":
                row = next((r for r in self._rows(db) if r["key"] == occurrence_id), None)
                if row is None:
                    raise ValueError("unknown occurrence")
                limit_source(row["source"])
                with self.admission.serialized() as conn:
                    row = self._observe(db, row, conn)
                    if row.get("source_wait"):
                        return dict(status="waiting_source", reason="waiting for Reminders",
                                    task=row)
                    if row["status"] == "result":
                        row["accept_intent"] = True
                        self._save(db, row)
                        self._accept(db, row, self.control_factory(conn, self.admission.kb))
            elif action == "retry":
                row = next((r for r in self._rows(db) if r["key"] == occurrence_id), None)
                if row is None:
                    raise ValueError("unknown occurrence")
                with self.admission.serialized() as conn:
                    row = self._observe(db, row, conn)
                    recovery = Recovery(self.control_factory(conn, self.admission.kb))
                    if (
                        row.get("guard", {}).get("status") != "active"
                        or run_id is None
                        or not recovery.permit(row, deliberate=True, run_id=run_id)
                    ):
                        raise ValueError("attempt requires reconciliation")
                    self._save(db, row)
            elif action != "tick":
                raise ValueError("unsupported occurrence action")
            return self._action_result(db) if action == "accept" else self._tick(db)
