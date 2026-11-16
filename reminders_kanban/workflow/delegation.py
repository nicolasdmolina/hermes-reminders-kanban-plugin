"""One-off owner workflow. All entry points serialize through a profile-local store."""

import fcntl
import json
import sqlite3
import time
from datetime import UTC, datetime
from uuid import uuid4

from reminders_kanban.api.human import Human, HumanCompletion
from reminders_kanban.claims import (
    LINK,
    SETTLE_SECONDS,
    claims,
    classify,
    holder,
    local_line,
    mac_name,
    same_but_claims,
    short,
    strip_claims,
    with_claim,
    without,
)
from reminders_kanban.execution import TaskControl
from reminders_kanban.execution.recovery import Recovery, failure
from reminders_kanban.links import Links, link_url, page_url
from reminders_kanban.reminders import helper
from reminders_kanban.reminders.completion import instructions, same_identity
from reminders_kanban.reminders.edits import WRITE_LOCK
from reminders_kanban.store import CompletionStore
from reminders_kanban.workflow.reconciliation import (
    completion_sources,
    fresh_source,
    invalidate_source,
    limit_source,
    read_identity,
    read_source,
    selected_sources,
    source_check,
    terminal,
)
from reminders_kanban.workflow.source import SourceGuard

# After a release pass could not read or write Reminders: when it may try again, per store.
_RELEASE_AFTER = {}
RELEASE_BACKOFF_SECONDS = 60
RELEASES_PER_TICK = 3
# A reminder found free of this install's line is looked at again after this long (a line can
# come back with another Mac's late write), or at once when its rows here change.
RELEASE_RECHECK_SECONDS = 600
# After a claim write was refused or failed: when that row may try again.
_CLAIM_AFTER = {}
# How many checks a keeper waits on removing the other install's line before starting anyway.
CONTEST_TRIES = 3


class Elsewhere(Exception):
    """Another install's claim is on the reminder, and this one was not told to take over."""

    def __init__(self, claim):
        super().__init__("another Mac has this reminder")
        self.claim = claim


class Delegation:
    def __init__(
        self,
        home,
        admission,
        *,
        profile="default",
        origin=None,
        call=helper.run,
        write_link=None,
        control_factory=TaskControl,
        link_setup=None,
        mac=None,
        now=time.time,
        write_other=None,
    ):
        # write_other: the claim writer for the other kind of reminder (a one-off's helper op
        # refuses a repeating reminder and the reverse), so a write goes to the op that takes it.
        self.write_other = write_other
        self.home, self.admission, self.profile = home, admission, profile
        # Install identity (claims.py): the links owner id and this Mac's name. `now` times the
        # settle window; both are injectable for tests.
        self.links, self._mac, self.now = Links(home), mac, now
        self.origin, self.call, self.write_link = origin, call, write_link
        self.link_setup = link_setup
        self.control_factory = control_factory
        self.store = CompletionStore(home / "reminders-kanban/delegation.sqlite3")
        self.setup = Human(home, call=call).store
        self.completion = HumanCompletion(
            home / "reminders-kanban/delegation-completion.sqlite3", call=call
        )
        with self.store.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS activation (id INTEGER PRIMARY KEY, board TEXT);
                CREATE TABLE IF NOT EXISTS delegated (source TEXT PRIMARY KEY, state TEXT);
            """)
            migrate = "enabled" not in {r[1] for r in db.execute("PRAGMA table_info(activation)")}
        if migrate:
            with self.store.locked() as db:
                if "enabled" not in {r[1] for r in db.execute("PRAGMA table_info(activation)")}:
                    db.execute(
                        "ALTER TABLE activation ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1")
                    db.commit()

    @property
    def install(self):
        """This install's id, minted before the first claim is written."""
        if not getattr(self, "_install", None):
            self._install = self.links.owner_id()
        return self._install

    @property
    def mac(self):
        return self._mac or mac_name()

    def _claims(self, source):
        """A reminder's claims against this install (claims.classify)."""
        view = classify((source or {}).get("notes"), self.install, self.links.known, self.mac)
        if view["foreign"] and not (source or {}).get("completed"):
            # From now on this install waits out the settle window before starting new work.
            self.links.mark_foreign(self.now())
        return view

    def _body_notes(self, source):
        """The notes a task is given to work from: without another install's claim line."""
        view = self._claims(source)
        return without(source.get("notes"), view["foreign"] + view["lost"]) or ""

    def _writer(self, source):
        """The claim writer whose helper op takes this reminder as it is now, or None."""
        mine = bool((source or {}).get("rules")) == hasattr(self, "activation_store")
        return self.write_link if mine else self.write_other

    def _line(self, owner, link, start, taken=None, take=0, origin=None):
        """A claim line for this task: (line, url)."""
        origin = origin or (None if self.local_mode else self.origin)
        if origin or not self.local_mode:
            url = link_url(origin, owner, link, self.profile, self.mac, taken, take, start)
            return LINK + url, url
        return local_line(owner, link, self.mac, start, taken, take), None

    def _claim_plan(self, notes, owner, link, *, takeover=False, origin=None, start=0):
        """The notes a delegation leaves behind: (target, line, url). line is this task's claim,
        kept when the notes already carry it; a lost claim of this install's, and with takeover
        another install's, is replaced. start: when this run first claimed the reminder, for a
        line written now. Raises Elsewhere for a claim it may not replace."""
        view = self._claims(dict(notes=notes))
        own = [c for c in view["mine"] if c["link"] == short(link)]
        if view["unknown"] or len(own) != len(view["mine"]):
            raise ValueError("unassociated task link requires reconciliation")
        if view["foreign"] and not takeover:
            raise Elsewhere(holder(view["foreign"]))
        if len({(c["url"], c["line"]) for c in own}) > 1 and not view["foreign"]:
            raise ValueError("multiple task links require reconciliation")
        origin = origin or (None if self.local_mode else self.origin)
        keep = own[0] if own else None
        drop = view["lost"] + view["foreign"]
        taken, take = None, 0
        if view["foreign"]:
            # A person's Take over: the new line names whom it took the reminder from, so it
            # wins if Apple keeps both lines. One more than any take over it replaces.
            taken = holder(view["foreign"])["owner"]
            take = max(c["take"] for c in view["foreign"] + own) + 1
            drop, keep = drop + own, None
        elif keep and origin and not keep["url"]:
            # Links were set up after this claim was written: the link line takes its place,
            # with the same start (and take over, if it was one).
            drop, taken, take, start = drop + own, keep["from"], keep["take"], keep["start"]
            keep = None
        if keep and not keep["line"]:
            # A person typed onto this task's line: it is written again as a line of its own,
            # with the same start (and take over), and their words stay where they are.
            drop, taken, take, start = drop + own, keep["from"], keep["take"], keep["start"]
            keep = None
        if keep:
            return without(notes, drop), keep["line"], keep["url"]
        line, url = self._line(owner, link, start, taken, take, origin)
        return (without(notes, drop) if drop else notes or "") + "\n\n" + line, line, url

    def _recorded(self, row):
        """This task's claim as its row remembers it, for when the line is not in the notes."""
        me, link = short(self.install), short(row["destination"]["link_id"])
        for claim in claims(row.get("claim")):
            if claim["owner"] == me and claim["link"] == link:
                return claim
        return {"owner": me, "link": link, "start": row.get("claim_start") or 0, "from": None,
                "take": 0, "line": None, "url": row["destination"].get("url"), "mac": self.mac}

    def _own_line(self, row):
        """(line, url) to write for this task's claim: the recorded one, else a new one that
        keeps its start time."""
        recorded = self._recorded(row)
        if recorded["line"]:
            return recorded["line"], recorded["url"]
        try:
            return self._line(self.install, row["destination"]["link_id"], recorded["start"])
        except ValueError:
            return local_line(self.install, row["destination"]["link_id"], self.mac,
                              recorded["start"]), None

    def _claim_landed(self, current, link, target, *, takeover=False):
        """While linking: whether the reminder as it is now carries this task's claim. Another
        install's claim beside it is settled by claims.holder; one that keeps the reminder
        raises Elsewhere. (A lost write response leaves this install's line in the notes: it
        must not let go of a reminder it rightly keeps.)"""
        seen = self._claims(current)
        mine = [c for c in seen["mine"] if c["link"] == short(link)]
        if seen["foreign"] and not takeover:
            keeper = holder(mine + seen["foreign"])
            if not any(keeper is c for c in mine):
                raise Elsewhere(keeper)
        return current.get("notes") == target or bool(mine and strip_claims(
            current.get("notes")) == strip_claims(target))

    def _adopt_current(self, source):
        """The reminder as it is now, when the snapshot a client sent differs from it only by
        claim lines (one came off after a Stop, or the other Mac's arrived): to the person it
        is the same reminder, so the action goes on from the fresh copy."""
        try:
            current = read_source(self, source["id"])
        except (helper.HelperError, KeyError, TypeError):
            return source
        if current != source and same_but_claims(current, source):
            limit_source(current)
            return current
        return source

    def _release(self, db, row, conn=None, *, reason, claim):
        """Another install has the reminder (taken_over, or yielded in a tie): stop and archive
        this task and finish its row. The reminder is never written. conn: the admission
        connection when the caller already holds that lock."""
        row["released"] = dict(reason=reason, mac=claim["mac"], owner=claim["owner"],
                               url=claim.get("url"), at=datetime.now(UTC).isoformat())
        row["stop_intent"] = True
        self._save(db, row)
        if row.get("task_id") and conn is not None:
            self._finish_stop(db, row, conn)
        elif row.get("task_id"):
            with self.admission.serialized() as held:
                self._finish_stop(db, row, held)
        else:
            row.update(status="stopped", stop_receipt=dict(worker_stop_verified=True),
                       guard=dict(row.get("guard", {}), status="stopped", hidden=False))
        row["guard"]["reason"] = reason
        return self._save(db, row)

    def _settle_claims(self, db, row, conn, state=None):
        """Whose reminder this is, by the claims in its notes now. True when this install let go.

        claims.holder decides, from the lines present plus this task's own claim as its row
        recorded it (the line may be missing: another Mac's late write can drop it). A person's
        take over naming this install wins; otherwise the claim that started first keeps the
        reminder. The keeper removes the other lines and writes its own back if it is missing;
        the other stops and never rewrites the notes. No claim at all: the keeper's line is
        written back. Nothing here depends on what state the work is in.
        """
        source = row.get("source", row["expected"])
        try:
            fresh = read_source(self, source["id"])
        except helper.HelperError:
            return False
        link = short((row.get("destination") or {}).get("link_id"))
        view = self._claims(fresh)
        foreign = view["foreign"]
        own = [c for c in view["mine"] + view["lost"] if c["link"] == link]
        if not foreign:
            if row.pop("contested", None):
                self._save(db, row)
            folded = own and not any(c["line"] for c in own)
            bare = not claims(fresh.get("notes")) or folded
            if bare and not fresh.get("completed") and link:
                # No claim at all, or only this task's with a person's words typed onto its
                # line: the line is written (again) on its own; their words stay.
                line, url = self._own_line(row)
                self._write_claim(db, row, conn, fresh,
                                  with_claim(without(fresh.get("notes"), own) or None, line),
                                  line, url)
            return False
        mine = own or [self._recorded(row)]
        keeper = holder(mine + foreign)
        if not any(keeper is c for c in mine):
            self._release(db, row, conn, reason="yielded" if own else "taken_over",
                          claim=keeper)
            return True
        if fresh.get("completed") or getattr(self, "_dispatching", False):
            # Checked off (here or on the other Mac) still counts for the install that has it.
            # (The check right before a start only looks; the tick's own tries.)
            return False
        # Its own older lines go too (the one a take-back replaced).
        extra = [c for c in own if c is not keeper]
        # Nothing new starts until a read shows only this claim, for a few checks; after that
        # it starts while it is still the keeper, and the cleanup keeps being tried.
        row["contested"] = int(row.get("contested") or 0) + 1
        self._save(db, row)
        whole = own and keeper["line"]
        target = without(fresh["notes"], foreign + (extra if whole else own))
        line, url = (keeper["line"], keeper["url"]) if whole else self._own_line(row)
        if not whole:
            target = with_claim(target or None, line)
        self._write_claim(db, row, conn, fresh, target, line, url)
        return False

    def _write_claim(self, db, row, conn, fresh, target, line, url):
        """Save notes that differ from the ones read only by claim lines, and remember this
        task's line. Through the helper op that takes this kind of reminder; a refusal or a
        failure waits a while before the next try."""
        key = (str(self.home), row["key"])
        writer = self._writer(fresh)
        if not writer or self.now() < _CLAIM_AFTER.get(key, 0):
            return
        try:
            with WRITE_LOCK.open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                current = writer(fresh, target)
        except helper.HelperError:
            _CLAIM_AFTER[key] = self.now() + RELEASE_BACKOFF_SECONDS
            invalidate_source()
            return
        invalidate_source()
        # The stored snapshots take the new claim line only: what else changed is still theirs
        # to notice (instructions, due date).
        old = row.get("source", row["expected"])
        row["source"] = dict(old, notes=current.get("notes"), modified=current.get("modified"))
        row["claim"] = line
        if url:
            row["destination"]["url"] = page_url(url)
        self._save(db, row)
        if not hasattr(self, "activation_store") and row.get("task_id"):
            guard = self._guard(self.control_factory(conn, self.admission.kb))
            with guard.store.locked() as guard_db:
                try:
                    state = guard._load(guard_db, row["task_id"])
                except KeyError:
                    return
                notes = state["source"].get("notes")
                state["source"]["notes"] = with_claim(
                    notes, line, [c["line"] for c in claims(notes) if c["owner"] and c["line"]])
                guard._save(guard_db, state)

    def _install_rows(self):
        """Every delegated row of this install, one-off and occurrence alike (read only)."""
        rows = []
        for name in ("delegation.sqlite3", "current-occurrences.sqlite3"):
            path = self.home / "reminders-kanban" / name
            if not path.exists():
                continue
            try:
                with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
                    rows += [json.loads(r[0]) for r in db.execute("SELECT state FROM delegated")]
            except sqlite3.Error:
                continue
        return rows

    def release_claims(self):
        """Take this install's claim line off reminders that are the person's again.

        Its work on the reminder ended and the reminder is still open: stopped, a This
        occurrence finished and the reminder rolled on, an Every occurrence series ended, an
        accepted reminder was reopened, or another install has it and this one's line was left
        behind. Otherwise the other Mac would keep showing it as this Mac's.

        Decided from the stored rows, so it works with no board open. A reminder is looked at
        when its rows here change, and again every ten minutes (a line can come back with
        another Mac's late write); only then is the tick's own read of the lists used, with no
        store lock held. Each write is compared against the reminder as read, a few per tick.
        A read or write that fails ends the pass, which waits before trying again.
        """
        key = (str(self.home), hasattr(self, "activation_store"))
        me = short(self.links.owner_id(create=False))
        if not me or self.now() < _RELEASE_AFTER.get(key, 0):
            return
        every = self._install_rows()
        followed = {r.get(k) for r in every for k in ("predecessor", "rerun_of")}
        held = {r["expected"]["id"] for r in every if self._holds(r, followed)}
        with self.store.connection() as db:
            db.execute("CREATE TABLE IF NOT EXISTS claim_checks "
                       "(reminder TEXT PRIMARY KEY, signature TEXT, at REAL)")
            checked = {r[0]: (r[1], r[2]) for r in db.execute("SELECT * FROM claim_checks")}
            groups = {}
            for row in self._rows(db):
                if row.get("destination") and row["expected"]["id"] not in held:
                    groups.setdefault(row["expected"]["id"], []).append(row)

        def signature(rows):
            return json.dumps(sorted((r["key"], r["status"], bool(r.get("released")))
                                     for r in rows))

        due = [reminder for reminder, rows in groups.items()
               if checked.get(reminder, (None, 0))[0] != signature(rows)
               or self.now() - checked[reminder][1] >= RELEASE_RECHECK_SECONDS]
        if not due:
            return
        try:
            sources = {source["id"]: source for source in selected_sources(self)}
        except helper.HelperError:
            _RELEASE_AFTER[key] = self.now() + RELEASE_BACKOFF_SECONDS
            return
        clean, written = [], 0
        for reminder in due:
            current = sources.get(reminder)
            links = {short(r["destination"]["link_id"]) for r in groups[reminder]}
            lines = [c for c in claims((current or {}).get("notes"))
                     if c["owner"] == me and c["link"] in links and (c["line"] or c["url"])]
            writer = self._writer(current)
            if not current or current["completed"] or not lines or not writer:
                clean.append(reminder)
                continue
            if written >= RELEASES_PER_TICK:
                continue
            with self.store.locked():
                again = self._install_rows()
                followed = {r.get(k) for r in again for k in ("predecessor", "rerun_of")}
                if any(r["expected"]["id"] == reminder and self._holds(r, followed)
                       for r in again):
                    continue  # Delegated again in the meantime.
                try:
                    with WRITE_LOCK.open("a") as lock:
                        fcntl.flock(lock, fcntl.LOCK_EX)
                        writer(current, without(current["notes"], lines))
                except helper.HelperError as exc:
                    invalidate_source()
                    if exc.code == "not_found":
                        clean.append(reminder)
                        continue
                    _RELEASE_AFTER[key] = self.now() + RELEASE_BACKOFF_SECONDS
                    break
            invalidate_source()
            written += 1
        if clean:
            with self.store.connection() as db:
                db.executemany(
                    "INSERT OR REPLACE INTO claim_checks VALUES (?, ?, ?)",
                    [(reminder, signature(groups[reminder]), self.now()) for reminder in clean])
                db.commit()

    @staticmethod
    def _holds(row, followed=()):
        """Whether this row still has the reminder for Hermes (so its claim stays)."""
        if row.get("released"):
            return False
        if row["status"] != "done":
            return not terminal(row)
        # The newest occurrence of an Every occurrence series: the next date is on its way, or
        # waits for the person's decision.
        return (row.get("scope") == "every_occurrence" and row["key"] not in followed
                and row.get("series_state") not in {"ended", "authorization_ended"}
                and bool((row.get("completion") or {}).get("successor")))

    def _release_quietly(self):
        try:
            self.release_claims()
        except Exception:  # noqa: BLE001 - housekeeping never fails the tick it rides on
            pass

    def _settling(self, row):
        """A new claim still inside its settle window, on an install that shares its reminders."""
        if 0 < int(row.get("contested") or 0) <= CONTEST_TRIES:
            return True
        written = row.get("claimed_at")
        return bool(written and self.links.seen_foreign(self.now())
                    and self.now() - written < SETTLE_SECONDS)

    @property
    def local_mode(self):
        from reminders_kanban.links.setup import read_state

        return read_state(self.home).get("mode") == "local" and not self.origin

    def link_readiness(self):
        from reminders_kanban.links import origin_error

        if self.link_setup:
            state = self.link_setup.readiness(fresh=False)
            return {key: state[key] for key in ("status", "reason", "mode")}
        status = "local" if self.local_mode else (
            "missing" if not self.origin else "invalid" if origin_error(self.origin) else "ready")
        return dict(status=status, reason=origin_error(self.origin),
                    mode="local" if self.local_mode else "links" if self.origin else "none")

    def _refresh_link_setup(self):
        if not self.link_setup:
            return self.link_readiness()
        from reminders_kanban.links.setup import read_state, save_state, setup_lock

        # This runs before acquiring a workflow lock; setup apply uses the same order.
        with setup_lock(self.link_setup.config_home):
            readiness = self.link_setup.readiness()
            if readiness["status"] == "ready":
                self.origin = readiness["address"]
                state = read_state(self.home)
                if state.get("mode") != "links":
                    state["mode"] = "links"
                    save_state(self.home, state)
            return readiness

    def backfill_links(self, origin=None):
        """Retry the recorded claim write, never adopt an edited reminder as a new baseline.

        With an origin: the link line, for tasks delegated before a link address was set up (it
        replaces their "Only on this Mac" claim line). Without: that claim line, for tasks
        delegated before claims were written.
        """
        with self.store.locked() as db:
            for row in self._rows(db):
                destination = row.get("destination")
                if (not destination or destination.get("url") or row["status"] == "done"
                        or row.get("released")
                        or row.get("stop_intent") or row["status"] in {"stopped", "deleted"}):
                    continue  # A finished task claims nothing (release_claims).
                if not origin and row.get("claim"):
                    continue
                expected = row.get("source", row["expected"])
                try:
                    current = self.call("read", id=expected["id"])
                    if current["completed"]:
                        row["backfill"] = "completed"
                        self._save(db, row)
                        continue
                    owner, link = destination["owner_id"], destination["link_id"]
                    # Only this task's own "Only on this Mac" line may already be there.
                    found = claims(expected.get("notes"))
                    mine = [c for c in found if c["owner"] == short(owner)
                            and c["link"] == short(link) and c["line"]]
                    own = [c["line"] for c in mine]
                    # The start time stays the run's own: a row from before claims has none,
                    # which reads as the earliest.
                    start = mine[0]["start"] if mine else row.get("claim_start") or 0
                    if origin:
                        url = row.get("backfill_url") or link_url(
                            origin, owner, link, self.profile, self.mac,
                            *((mine[0]["from"], mine[0]["take"]) if mine else (None, 0)), start)
                        line = LINK + url
                    else:
                        url = None
                        line = row.get("backfill_claim") or local_line(
                            owner, link, self.mac, start)
                    target = with_claim(expected.get("notes"), line, own)
                    comparison = dict(current, notes=expected.get("notes"),
                                      modified=expected.get("modified"))
                    if current.get("notes") == target and comparison == expected:
                        pass  # A previous append succeeded but its response was lost.
                    elif current != expected or len(found) != len(own):
                        row["backfill"] = "conflict"
                        self._save(db, row)
                        continue
                    elif own and not origin:
                        row["claim"] = own[0]  # Already there.
                        self._save(db, row)
                        continue
                    else:
                        row["backfill_url" if url else "backfill_claim"] = url or line
                        self._save(db, row)
                        with WRITE_LOCK.open("a") as lock:
                            fcntl.flock(lock, fcntl.LOCK_EX)
                            current = self.write_link(expected, target)
                    # Advance only the exact stored baseline owned by this append.
                    with self.completion.store.locked() as completion:
                        saved = completion.execute(
                            "SELECT state FROM occurrences WHERE id=?", (row["key"],)
                        ).fetchone()
                        if saved:
                            payload = json.loads(saved[0])
                            if payload.get("expected") == expected:
                                payload["expected"] = current
                                payload["baseline"] = [
                                    current if item == expected else item
                                    for item in payload.get("baseline", [])]
                                completion.execute("UPDATE occurrences SET state=? WHERE id=?",
                                                   (json.dumps(payload), row["key"]))
                            series_id = row.get("authorization_id", row["key"])
                            saved_series = completion.execute(
                                "SELECT state FROM series WHERE id=?", (series_id,)
                            ).fetchone()
                            if saved_series:
                                series = json.loads(saved_series[0])
                                if series.get("instructions") == instructions(expected):
                                    series["instructions"] = instructions(current)
                                    completion.execute("UPDATE series SET state=? WHERE id=?",
                                                       (json.dumps(series), series_id))
                            completion.commit()
                    if not hasattr(self, "activation_store"):
                        with self.admission.serialized() as conn:
                            guard = self._guard(self.control_factory(conn, self.admission.kb))
                            with guard.store.locked() as guard_db:
                                state = guard._load(guard_db, row["task_id"])
                                if state["source"] == expected:
                                    state["source"] = current
                                    guard._save(guard_db, state)
                    row.update(source=current, backfill="done", claim=line)
                    row.setdefault("claimed_at", self.now())
                    destination["url"] = page_url(url)
                    self._save(db, row)
                except helper.HelperError as exc:
                    row["backfill"] = ("conflict" if exc.code in {
                        "conflict", "source_changed", "not_found", "identity_changed"
                    } else "pending")
                    self._save(db, row)

    def submission_guard(self, db, row, control):
        return self._guard(control).observe(row["task_id"])

    def _selected(self):
        # The last saved choice, read without the setup lock. That lock is held across Reminders
        # reads by the board, and this is called while holding the task and admission locks: waiting
        # here made every action queue behind a slow Reminders read.
        with self.setup.connection() as db:
            return self.setup.read(db)["selected_list_ids"]

    def _save(self, db, row):
        # However a row came to be stopped (the Stop button, a task archived in Hermes, a reminder
        # checked off and reopened), remember when it was first seen so. `stopped_at` stays the
        # verified Stop's own time (delegation-contract.md).
        seen = row.get("stopped_at") or row.get("stopped_seen_at")
        if row.get("status") == "stopped" and not seen:
            row["stopped_seen_at"] = datetime.now(UTC).isoformat()
        db.execute(
            "INSERT INTO delegated VALUES (?, ?) "
            "ON CONFLICT(source) DO UPDATE SET state=excluded.state",
            (row.get("storage_key", row["expected"]["id"]), json.dumps(row)),
        )
        db.commit()
        return row

    def _rows(self, db):
        return [json.loads(r[0]) for r in db.execute("SELECT state FROM delegated")]

    def _active_to_dispatch(self, db):
        """Pickup's state at the moment a worker would start, read inside the admission lock."""
        return self._active(db)

    def _active(self, db):
        row = db.execute("SELECT board, enabled FROM activation WHERE id=1").fetchone()
        if row and row[0] != self.admission.board:
            raise ValueError("activation belongs to another board")
        return bool(row and row[1])

    @staticmethod
    def settled(row):
        """Accepted and checked off: nothing about it can change, so it needs no Hermes read.

        Every board poll used to re-read each task ever run (its comments, runs and events).
        """
        guard = row.get("guard", {}).get("status", "active")
        return row.get("status") == "done" and guard == "active"

    @staticmethod
    def settled_view(row):
        return dict(state="done", recovery=None, waiting=False, required_action=None,
                    wait_reason=None, stopped_at=row.get("stopped_at"), work_before_stop=None)

    def task_view(self, row, conn, observed=None):
        """Project durable recovery only while its attempt still owns the failure."""
        if observed is None and self.settled(row):
            return self.settled_view(row)
        if observed is None:
            observed = self.control_factory(conn, self.admission.kb).observe(row["task_id"])
        state = observed["state"]
        if state == "paused" and self.admission._parked(
            conn, self.admission.kb.get_task(conn, row["task_id"])
        ):
            state = "ready"
        guard = row.get("guard", {})
        if guard and guard["status"] != "active" and not (
            guard["status"] == "waiting_source" and state == "result"
        ):
            state = guard["status"]
        if row["status"] in {"needs_reconciliation", "preparation_attention"}:
            state = row["status"]
        required = {"question": "reply", "result": "review", "failed": "retry",
                    "paused": "resume", "needs_reconciliation": "reconcile",
                    "preparation_attention": "reconcile"}.get(state)
        recovery = row.get("recovery")
        waiting = False
        current_failure = failure(observed)
        if (not current_failure or not recovery
                or recovery.get("run_id") != current_failure[0]["id"]):
            recovery = None
        if state in {"failed", "ready"} and recovery:
            required = recovery.get("action", required)
            waiting = required == "wait"
            if waiting:
                required = None
        wait_reason = "source_unavailable" if guard.get("status") == "waiting_source" else None
        if wait_reason and state != "result":
            waiting, required = True, None
        return dict(state=state, recovery=recovery, waiting=waiting, required_action=required,
                    wait_reason=wait_reason,
                    stopped_at=row.get("stopped_at"),
                    work_before_stop=observed if row["status"] == "stopped" else None)

    def _task_views(self, db):
        tasks = self._rows(db)
        with self.admission.reading() as conn:
            for row in tasks:
                if row.get("task_id"):
                    row.update(self.task_view(row, conn))
        return tasks

    def _preview(self, db):
        selected = self._selected()
        lists = self.call("lists")
        if not set(selected) <= {r["id"] for r in lists if r["writable"]}:
            raise ValueError("selected list unavailable")
        sources = self.call("read_many", calendarIds=selected) if selected else []
        with self.setup.locked() as setup:
            label = Human.labels(setup)["ready"]
        return dict(
            status="ok",
            pickup_enabled=self._active(db),
            selected_list_ids=selected,
            limits=self.admission.observe(),
            eligible=[
                s
                for s in sources
                if not s["completed"] and not s["rules"] and s["title"].startswith(label)
                # One another Mac's Hermes has is not this one's to start.
                and not self._claims(s)["foreign"]
            ],
            tasks=self._task_views(db),
        )

    def preview(self):
        with self.store.connection() as db, self.setup.connection() as setup:
            state = self.setup.read(setup)
            rows = self._task_views(db)
            return dict(status="ok", pickup_enabled=self._active(db),
                        selected_list_ids=state["selected_list_ids"],
                        limits=self.admission.observe(), eligible=[], tasks=rows,
                        stale=True, as_of=state.get("observed_at"),
                        task_links=self.link_readiness())

    def _guard(self, control):
        def read(identity):
            fresh = read_source(self, identity)
            if fresh["calendarId"] not in self._selected() or (
                fresh.get("rules") and not fresh["completed"]
            ):
                raise helper.HelperError(
                    "source_ineligible", "source is no longer a selected one-off"
                )
            return fresh

        return SourceGuard(
            self.home / "reminders-kanban/delegation-source.sqlite3",
            control,
            read=read,
            validate=lambda expected: read_identity(self, expected),
        )

    @fresh_source()
    def _prepare(self, db, source, resources=(), *, deliberate=False, takeover=False):
        """takeover: the person chose Take over here, so another install's claim is replaced.
        Without it a reminder another install has is passed over by pickup (returns None, no
        error); a deliberate Delegate raises Elsewhere, so the person is told whose it is."""
        limit_source(source)
        source = self._adopt_current(source)
        prior = db.execute("SELECT state FROM delegated WHERE source=?", (source["id"],)).fetchone()
        view = self._claims(source)

        def elsewhere():
            if deliberate:
                raise Elsewhere(holder(view["foreign"]))

        if prior:
            row = json.loads(prior[0])
            # Take over of a reminder this Mac had finished (accepted, then reopened and handed to
            # the other Mac), or let go of (whatever its stop came to): a new task, like one
            # stopped here.
            again = takeover and not source["completed"] and (
                row["status"] == "done" or (row.get("released") and row["status"] != "stopped"))
            if deliberate and (row["status"] == "stopped" or again):
                if view["foreign"] and not takeover:
                    return elsewhere()
                if again:
                    if read_identity(self, row.get("source", row["expected"])) != source:
                        raise ValueError("source changed")
                else:
                    self._check_redelegation(db, row, source)
                if source["rules"]:
                    raise ValueError("selected incomplete one-off required")
                # Archive under its durable key, leaving the source slot for the new row.
                row["storage_key"] = row["key"]
                self._save(db, row)
                db.execute("DELETE FROM delegated WHERE source=?", (source["id"],))
                row = dict(
                    expected=source,
                    key=str(uuid4()),
                    resources=list(resources),
                    status="preparing",
                    task_id=None,
                    accepted=False,
                    takeover=takeover,
                    prior_effects=row.get("rerun_reconciliation", {}).get("evidence"),
                )
                self._save(db, row)
        else:
            if view["foreign"] and not takeover:
                return elsewhere()
            if view["mine"] or view["unknown"]:
                # Its notes carry another reminder's task link. Pickup passes over it.
                if not deliberate:
                    return None
                raise ValueError("unassociated task link requires reconciliation")
            read_identity(self, source)
            if (
                source["completed"]
                or source["rules"]
                or source["calendarId"] not in self._selected()
            ):
                raise ValueError("selected incomplete one-off required")
            if read_source(self, source["id"]) != source:
                raise ValueError("source changed")
            row = dict(
                expected=source,
                key=str(uuid4()),
                resources=list(resources),
                status="preparing",
                task_id=None,
                accepted=False,
                takeover=takeover,
            )
            self._save(db, row)
        if row["status"] not in {"preparing", "preparation_attention"}:
            return row
        with self.admission.serialized() as conn:
            control = self.control_factory(conn, self.admission.kb)
            original = row["expected"]
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
            original["id"], row["key"], self.admission.board, task, self.profile
        )
        current = read_source(self, original["id"])
        try:
            # A durable exact target permits read-only reconciliation after a lost write response.
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
        elif current.get("notes") == target:
            row.setdefault("claimed_at", 0)  # Already in the notes: nothing to wait out.
        elif not row.get("link_intent"):
            row["link_intent"] = True
            self._save(db, row)
            with WRITE_LOCK.open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                current = self.write_link(original, target)
            row["claimed_at"] = self.now()
        else:
            row["status"] = "preparation_attention"
            return self._save(db, row)
        if current != original:
            limit_source(current)
        row["source"] = current
        row["claim"] = line
        row["destination"] = dict(owner_id=owner, link_id=link, url=page_url(url))
        with self.admission.serialized() as conn:
            self._guard(self.control_factory(conn, self.admission.kb)).bind(task, current)
        # Occurrence identity is the durable creation key, including undated one-offs.
        with self.completion.store.locked() as completion:
            if not completion.execute(
                "SELECT id FROM occurrences WHERE id=?", (row["key"],)
            ).fetchone():
                baseline = completion_sources(self, current["calendarId"])
                if current not in baseline:
                    raise ValueError("source changed before completion association")
                completion.execute(
                    "INSERT INTO series VALUES (?, ?, ?)",
                    (row["key"], current["id"] + "/" + row["key"], '{"every":false}'),
                )
                self.completion._insert(completion, row["key"], row["key"], current, baseline)
                completion.commit()
        with self.admission.serialized() as conn:
            self.control_factory(conn, self.admission.kb).resume(task)
        self.admission.ready(task, resources=row["resources"])
        row["status"] = "ready"
        return self._save(db, row)

    def _completion_matches(self, row, fresh):
        with self.completion.store.locked() as completion:
            stored = completion.execute(
                "SELECT state FROM occurrences WHERE id=?", (row["key"],)
            ).fetchone()
            expected = json.loads(stored[0])["expected"]
        return (
            same_identity(expected, fresh)
            and expected.get("due") == fresh.get("due")
            and expected.get("rules") == fresh.get("rules")
            and instructions(expected) == instructions(fresh)
            and fresh["calendarId"] in self._selected()
        )

    @source_check()
    def _accept(self, db, row, control):
        observed = control.observe(row["task_id"])
        if not row["accepted"]:
            if observed["state"] != "result":
                return row
            fresh = read_identity(self, row.get("source", row["expected"]))
            if not self._completion_matches(row, fresh):
                row["status"] = "needs_reconciliation"
                return self._save(db, row)
            with self.completion.store.locked() as completion:
                attempted = completion.execute(
                    "SELECT state FROM attempts WHERE occurrence=?", (row["key"],)
                ).fetchone()
                if not attempted and not fresh["completed"]:
                    baseline = completion_sources(self, fresh["calendarId"])
                    if fresh not in baseline:
                        raise ValueError("source changed before acceptance")
                    completion.execute(
                        "UPDATE occurrences SET state=? WHERE id=?",
                        (json.dumps(dict(expected=fresh, baseline=baseline)), row["key"]),
                    )
                    completion.commit()
            # Do not save source completion until native review acceptance proves worker exit.
            control.accept(row["task_id"])
            row["accepted"] = True
            self._save(db, row)
        baseline = completion_sources(self, row["source"]["calendarId"])
        with WRITE_LOCK.open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = self.completion.accept(row["key"], row["key"], baseline=baseline)
        invalidate_source()
        row.update(
            status="done" if result["status"] == "completed" else "needs_reconciliation",
            completion=result,
        )
        return self._save(db, row)

    def _check_redelegation(self, db, row, expected):
        with self.admission.serialized() as conn:
            control = self.control_factory(conn, self.admission.kb)
            if not control._workers_stopped(row["task_id"]):
                raise ValueError("worker still alive")
            observed = control.observe(row["task_id"])
            runs = observed.get("runs", [])
            receipt = row.get("rerun_reconciliation", {})
            if runs and receipt.get("runs") != runs:
                raise ValueError("external effects need reconciliation")
        with self.completion.store.locked() as completion:
            if completion.execute(
                "SELECT 1 FROM attempts WHERE occurrence=?", (row["key"],)
            ).fetchone() or row.get("accept_intent"):
                raise ValueError("completion needs reconciliation")
        fresh = read_identity(self, row.get("source", row["expected"]))
        if fresh != expected:
            raise ValueError("source changed")
        if (
            not same_identity(row.get("source", row["expected"]), fresh)
            or fresh["completed"]
            or fresh["calendarId"] not in self._selected()
        ):
            raise ValueError("source identity or eligibility changed")
        return fresh

    def _reconcile_rerun(self, db, row, control, *, evidence, cause="inspected_outcomes",
                         run_id=None):
        """Both trusted inspection and owner consent use the existing rerun gate."""
        if not isinstance(evidence, str) or not evidence.strip():
            raise ValueError("inspected external outcomes required")
        if row["status"] != "stopped" or not control._workers_stopped(row["task_id"]):
            raise ValueError("verified stop required")
        runs = control.observe(row["task_id"]).get("runs", [])
        receipt = row.get("rerun_reconciliation", {})
        if receipt.get("runs") == runs and receipt.get("cause") == cause:
            return receipt
        receipt = dict(runs=runs, evidence=evidence, cause=cause, run_id=run_id,
                       confirmed_at=datetime.now(UTC).isoformat(), receipt_id=str(uuid4()),
                       work_before_stop=control.observe(row["task_id"]))
        row["rerun_reconciliation"] = receipt
        self._save(db, row)
        return receipt

    def reconcile_rerun(self, key, *, evidence):
        """Trusted inspection of external outcomes using the existing rerun receipt."""
        with self.store.locked() as db:
            row = next(r for r in self._rows(db) if r["key"] == key)
            with self.admission.serialized() as conn:
                self._reconcile_rerun(db, row, self.control_factory(conn, self.admission.kb),
                                      evidence=evidence)
            return row

    @fresh_source()
    def confirm_rerun(self, *, task_id=None, occurrence_id=None, run_id=None):
        with self.store.locked() as db:
            self._active(db)
            row = next((r for r in self._rows(db) if
                        (r["key"] == occurrence_id if occurrence_id is not None
                         else r.get("task_id") == task_id)), None)
            if row is None or not row.get("task_id"):
                return dict(status="not_found")
            with self.admission.serialized() as conn:
                control = self.control_factory(conn, self.admission.kb)
                observed = control.observe(row["task_id"])
                current = dict(task=row, work_before_stop=observed)
                runs = observed.get("runs", [])
                latest = runs[-1] if runs else {}
                if not run_id or str(latest.get("id")) != str(run_id) or not latest.get("ended_at"):
                    return dict(status="attention", reason="stale_run", **current)
                if row["status"] != "stopped" or not control._workers_stopped(row["task_id"]):
                    return dict(status="attention", reason="verified_stop_required", **current)
                with self.completion.store.locked() as completion:
                    if row.get("accept_intent") or completion.execute(
                        "SELECT 1 FROM attempts WHERE occurrence=?", (row["key"],)
                    ).fetchone():
                        return dict(status="attention", reason="completion needs reconciliation",
                                    **current)
                receipt = self._reconcile_rerun(
                    db, row, control, run_id=str(run_id), cause="owner_confirmed_rerun",
                    evidence=f"Owner reviewed retained work for run {run_id} and accepts that "
                    "running again may repeat parts of it. This is consent, not proof of "
                    "external outcomes. Consult retained work before repeating actions.")
                return dict(status="ok", receipt=receipt, **current)

    def _finish_stop(self, db, row, conn):
        control = self.control_factory(conn, self.admission.kb)
        # Re-observe before replaying termination. Never replay worker work.
        observed = control.observe(row["task_id"])
        conn.execute("UPDATE rk_admission SET park_event=NULL WHERE task_id=?", (row["task_id"],))
        conn.commit()
        receipt = row.get("stop_receipt", {})
        if not receipt.get("worker_stop_verified"):
            try:
                receipt = control.stop(row["task_id"])
            except Exception as exc:
                receipt = dict(observed, worker_stop_verified=False, reason=str(exc))
            row["stop_receipt"] = receipt
            if receipt.get("worker_stop_verified") and not row.get("stopped_at"):
                row["stopped_at"] = datetime.now(UTC).isoformat()
        if row.get("accepted"):
            row["host_accepted"] = True
            row["accepted"] = False
        verified = receipt.get("worker_stop_verified", False)
        deleted = row.get("guard", {}).get("hidden", False)
        terminal = "deleted" if deleted else "stopped"
        row.update(
            status=terminal if verified else "needs_reconciliation",
            guard=dict(row.get("guard", {}), status=terminal, hidden=deleted),
            recovery=None,
        )
        return self._save(db, row)

    def _observe_before_stop(self, db, row, conn):
        if terminal(row):
            return row
        observed = self.control_factory(conn, self.admission.kb).observe(row["task_id"])
        if observed["state"] in {"done", "stopped"} and not row.get("accept_intent"):
            row["status"] = observed["state"]
        return row

    @fresh_source()
    def stop(self, task_id):
        # Stop itself never reads or writes Reminders. The reminder is the person's again: the
        # next tick takes this install's claim line off it (release_claims).
        with self.store.locked() as db:
            self._active(db)  # Validate the owning board even when pickup is disabled.
            row = next((r for r in self._rows(db) if r.get("task_id") == task_id), None)
            if row is None:
                return dict(status="not_found", outcome="not_found")
            limit_source(row.get("source", row["expected"]))
            with self.admission.serialized() as conn:
                if row.get("stop_intent"):
                    completed = row.get("stop_receipt", {}).get("worker_stop_verified")
                    row = self._finish_stop(db, row, conn)
                    outcome = "already_stopped" if completed else "stopped"
                else:
                    row = self._observe_before_stop(db, row, conn)
                    state = row["status"]
                    outcome = {
                        "done": "already_finished",
                        "stopped": "already_stopped",
                        "deleted": "already_deleted",
                    }.get(state)
                    if outcome is None:
                        row["stop_intent"] = True
                        self._save(db, row)
                        row = self._finish_stop(db, row, conn)
                        outcome = "stopped"
                if row["status"] == "deleted":
                    outcome = "already_deleted"
                elif row["status"] == "needs_reconciliation":
                    outcome = "needs_reconciliation"
                observed = self.control_factory(conn, self.admission.kb).observe(task_id)
            return dict(
                status="ok",
                outcome=outcome,
                task=row,
                column="To do" if row["status"] == "stopped" else None,
                label="Stopped" if row["status"] == "stopped" else None,
                reminder_owner="human" if row["status"] == "stopped" else None,
                work_before_stop=observed,
                effects="Recorded work is retained. Already-issued effects cannot be "
                "undone and may still finish; reconcile unknown outcomes "
                "before retry.",
            )

    def _observe(self, db, row, conn):
        if terminal(row):
            return row
        if row.get("stop_intent"):
            return self._finish_stop(db, row, conn)
        if row["status"] in {"preparing", "preparation_attention", "done"}:
            return row
        control = self.control_factory(conn, self.admission.kb)
        observed = control.observe(row["task_id"])
        # Recover a crash after Hermes accepted but before our receipt committed.
        if observed["state"] == "done" and row.get("accept_intent"):
            row["accepted"] = True
        if row["accepted"]:
            with fresh_source():
                return self._accept(db, row, control)
        if self._settle_claims(db, row, conn, observed["state"]):
            return row
        try:
            fresh = read_identity(self, row.get("source", row["expected"]))
        except helper.HelperError:
            fresh = None
        if (
            fresh
            and fresh["completed"]
            and observed["state"] == "result"
            and self._completion_matches(row, fresh)
        ):
            row["accept_intent"] = True
            self._save(db, row)
            with fresh_source():
                return self._accept(db, row, control)
        guard = self._guard(control).observe(row["task_id"])
        row["guard"] = guard
        if guard["status"] == "waiting_source":
            row["status"] = "waiting_source"
        elif guard["status"] != "active":
            conn.execute(
                "UPDATE rk_admission SET park_event=NULL WHERE task_id=?", (row["task_id"],)
            )
            conn.commit()
            row["status"] = guard["status"]
        else:
            row["status"] = observed["state"]
            Recovery(control).observe(row)
        return self._save(db, row)

    def tick(self):
        if self.link_setup and self.local_mode and self.link_setup.configuration()[0]:
            self._refresh_link_setup()
        if self.write_link and (self.origin or self.local_mode):
            self.backfill_links(self.origin)
        # Source I/O precedes the lifecycle lock. Recheck the journal before using it.
        # Release the lock between tasks so actions never wait for an entire pass.
        with self.store.connection() as snapshot:
            expected = self._rows(snapshot)
        # One pass per row that still has work: a finished row's own pass does nothing, so the
        # tick grows with open work, never with history. (No row due: one pass, for admission.)
        keys = [row["key"] for row in expected if self._due(row, expected)] or [None]
        with source_check():
            # Shares this pass's read of the lists; holds no lock while reading.
            self._release_quietly()
            for key in keys:
                try:
                    if self._selected() and (any(not terminal(r) for r in expected)
                                             or hasattr(self, "activation_store")):
                        selected_sources(self)
                except helper.HelperError:
                    pass
                with self.store.locked() as db:
                    if self._rows(db) != expected:
                        return self._action_result(db)
                    result = self._tick(db, keys={key})
                    expected = self._rows(db)
            return result

    def _due(self, row, rows):
        """Whether a pass for this row's key can do anything (see _tick): it is not finished."""
        return not terminal(row)

    def _action_result(self, db):
        return dict(status="ok", pickup_enabled=self._active(db), tasks=self._rows(db),
                    limits=self.admission.observe())

    def _tick(self, db, *, keys=None):
        with source_check():
            for row in self._rows(db):
                if (keys is not None and row["key"] not in keys
                        and row.get("predecessor") not in keys):
                    continue
                if terminal(row):
                    continue
                if row["status"] in {"preparing", "preparation_attention"}:
                    if not self._active(db):
                        continue
                    try:
                        self._prepare(db, row["expected"])
                    except (helper.HelperError, ValueError) as exc:
                        row = next(r for r in self._rows(db) if r["key"] == row["key"])
                        row.update(status="preparation_attention", reason=str(exc))
                        self._save(db, row)
                else:
                    with self.admission.serialized() as conn:
                        row = self._observe(db, row, conn)
                        state = row.get("recovery")
                        released = False
                        if (state and state["cause"] in {"access", "ordinary"}
                                and (state["cause"] == "access" or state["authorized"])
                                and row.get("guard", {}).get("status") == "active"):
                            recovery = Recovery(self.control_factory(conn, self.admission.kb))
                            if (recovery.control.observe(row["task_id"])["state"]
                                    in {"failed", "ready"} and recovery.permit(row)):
                                self._save(db, row)
                                released = recovery.control.resume(row["task_id"])
                    if released:
                        self.admission.ready(row["task_id"], resources=row["resources"])

        @fresh_source()
        def before_dispatch(conn, task):
            if not self._active_to_dispatch(db):
                return False
            row = next((r for r in self._rows(db) if r["task_id"] == task), None)
            if row is None or (keys is not None and row["key"] not in keys
                               and row.get("predecessor") not in keys):
                return False
            self._dispatching = True
            try:
                row = self._observe(db, row, conn)
            finally:
                self._dispatching = False
            allowed = (row.get("guard", {}).get("status") == "active"
                       # Two Macs: a new claim waits for the other Mac's write to arrive first.
                       and not self._settling(row)
                       and Recovery(self.control_factory(conn, self.admission.kb)).permit(row))
            self._save(db, row)
            return allowed

        limits = self.admission.admit(before_dispatch=before_dispatch)
        return dict(status="ok", pickup_enabled=self._active(db),
                    tasks=self._rows(db), limits=limits)

    def apply(self, action, **fields):
        # (Releasing a claim is the tick's work: no action waits on Reminders for it.)
        return self._apply(action, **fields)

    @fresh_source()
    def _apply(self, action, *, expected=None, resources=(), maximum=None,
               instruction_version=None, task_id=None, run_id=None):
        if action == "tick":
            return self.tick()
        if action == "confirm_rerun":
            return self.confirm_rerun(task_id=task_id, run_id=run_id)
        if action == "deactivate":
            # Occurrence passes hold this lock before reading activation. Drain them
            # before disabling pickup so no pass can dispatch after this returns.
            occurrences = CompletionStore(
                self.home / "reminders-kanban/current-occurrences.sqlite3")
            with occurrences.locked(), self.store.locked() as db:
                self._active(db)  # Validate the board binding even when already off.
                db.execute("UPDATE activation SET enabled=0 WHERE id=1")
                db.commit()
                return self._action_result(db)
        if action == "activate":
            readiness = self._refresh_link_setup()
            if readiness["status"] not in {"ready", "local"}:
                reason = ("task_link_origin_missing" if readiness["status"] == "missing"
                          else "task_link_origin_invalid")
                return dict(status="setup_required", reason=reason)
        with self.store.locked() as db:
            if action == "maximum":
                self.admission.set_maximum(maximum)
                return self._preview(db)
            if action == "activate":
                if self._active(db):
                    for row in self._rows(db):
                        if row["status"] == "preparing":
                            self._prepare(db, row["expected"])
                preview = self._preview(db)
                if not preview["selected_list_ids"]:
                    return dict(status="select_lists")
                if not self.local_mode and (not self.origin or not self.write_link):
                    return dict(status="setup_required", reason="task_link_writer_unavailable")
                if not self.local_mode:
                    link_url(self.origin, "validate", "validate", self.profile)
                db.execute(
                    "INSERT INTO activation (id, board, enabled) VALUES (1, ?, 1) "
                    "ON CONFLICT(id) DO UPDATE SET enabled=1", (self.admission.board,)
                )
                db.commit()
                for source in preview["eligible"]:
                    self._prepare(db, source)
            elif action in {"ready", "take_over"}:
                if not self._active(db):
                    return dict(status="inactive")
                try:
                    self._prepare(db, expected, resources, deliberate=True,
                                  takeover=action == "take_over")
                except Elsewhere as other:
                    # Another Mac's Hermes has it: say whose, start nothing.
                    return dict(self._action_result(db), status="conflict", reason="other_mac",
                                mac=other.claim["mac"])
            elif action in {"accept", "resume"}:
                row = next(
                    (r for r in reversed(self._rows(db)) if r["expected"]["id"] == expected["id"]),
                    None,
                )
                if row is None:
                    raise ValueError("not delegated")
                with self.admission.serialized() as conn:
                    control = self.control_factory(conn, self.admission.kb)
                    if action == "accept":
                        if row["status"] == "done" or row.get("stop_intent"):
                            return self._action_result(db)
                        row["status"] = control.observe(row["task_id"])["state"]
                        limit_source(row.get("source", row["expected"]))
                        try:
                            fresh = read_identity(self, row.get("source", row["expected"]))
                            # Kept so the board can tell a later reopen from this moment.
                            row["guard"] = {"status": "active", "source": fresh}
                        except helper.HelperError:
                            row["guard"] = {"status": "waiting_source"}
                    else:
                        row = self._observe(db, row, conn)
                    if (action == "accept"
                            and row.get("guard", {}).get("status") == "waiting_source"):
                        return dict(status="waiting_source", reason="waiting for Reminders",
                                    task=row)
                    if action == "accept" and row["status"] == "result":
                        row["accept_intent"] = True
                        self._save(db, row)
                        self._accept(db, row, control)
                    elif action == "resume" and not row.get("stop_intent"):
                        state = self._guard(control).resume(
                            row["task_id"], instruction_version=instruction_version
                        )
                        row["guard"] = state
                        self._save(db, row)
                    host_ready = control.observe(row["task_id"])["state"] == "ready"
                if action == "resume" and row["guard"]["status"] == "active" and host_ready:
                    current = row["guard"]["source"]
                    with self.completion.store.locked() as completion:
                        attempted = completion.execute(
                            "SELECT state FROM attempts WHERE occurrence=?", (row["key"],)
                        ).fetchone()
                        if attempted:
                            raise ValueError("completion already attempted")
                        baseline = completion_sources(self, current["calendarId"])
                        completion.execute(
                            "UPDATE occurrences SET state=? WHERE id=?",
                            (json.dumps(dict(expected=current, baseline=baseline)), row["key"]),
                        )
                        completion.commit()
                    self.admission.ready(row["task_id"], resources=row["resources"])
            if action in {"accept", "ready", "take_over"}:
                return self._action_result(db)
            return self._tick(db)
