"""Two installs sharing one set of reminders through iCloud (docs/adr/003-two-macs.md).

Each Mac has its own copy of the reminders, its own databases, Hermes tasks and install id.
`sync` delivers one Mac's copy of a reminder to the other (last writer wins), `merge` stands for
Apple keeping both Macs' note lines. Nothing here touches Reminders or Hermes.
"""

import copy
import json
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from test_delegation import Admission

from reminders_kanban.api.human import Action, Human
from reminders_kanban.claims import SETTLE_SECONDS, base36, claims, local_line
from reminders_kanban.links import Links
from reminders_kanban.reminders import helper
from reminders_kanban.reminders.helper import HelperError
from reminders_kanban.workflow.delegation import Delegation
from reminders_kanban.workflow.occurrence import OccurrenceDelegation

LOW = "00000000-0000-4000-8000-00000000000a"
HIGH = "ffffffff-ffff-4fff-8fff-fffffffffffb"
MID = "88888888-8888-4888-8888-888888888888"
FULL = {owner[:8]: owner for owner in (LOW, HIGH, MID)}
DUE = {"year": 2026, "month": 11, "day": 6}
MODES = [("local", "local"), ("links", "links"), ("local", "links"), ("links", "local")]


def reminder(rid, title, notes=None, *, repeats=False):
    return dict(
        id=rid, externalId="ext-" + rid, calendarId="list", calendarTitle="List", title=title,
        notes=notes, url=None, due=DUE if repeats else None, start=None,
        rules=["daily"] if repeats else [], completed=False, completedAt=None, modified="m0",
        priority=0,
    )


class Store:
    """One Mac's local copy of Reminders. Ids are local to a Mac; externalId is shared."""

    def __init__(self, name, rows):
        self.name, self.changes, self.writes, self.down = name, 0, 0, False
        self.rows = [dict(copy.deepcopy(row), id=f"{name}:{row['id']}") for row in rows]

    def find(self, rid):
        return next(row for row in self.rows if row["externalId"] == "ext-" + rid)

    def touch(self, row):
        self.changes += 1
        row["modified"] = f"{self.name}-m{self.changes}"

    def _checked(self, expected):
        row = next((r for r in self.rows if r["id"] == expected.get("id")), None)
        if row is None:
            raise HelperError("not_found", "gone")
        if row != expected:
            raise HelperError("conflict", "Source changed", copy.deepcopy(row))
        return row

    def __call__(self, op, **fields):
        if self.down:
            raise HelperError("uncertain", "Read timed out")
        if op == "lists":
            return [dict(id=key, writable=True, title=key) for key in ("list", "list2")]
        if op in {"read_many", "completion-read"}:
            return copy.deepcopy(self.rows)
        if op == "read":
            row = next((r for r in self.rows if r["id"] == fields["id"]), None)
            if row is None:
                raise HelperError("not_found", "gone")
            return copy.deepcopy(row)
        row = self._checked(fields["expected"])
        if op == "occurrence-schedule":
            due = row["due"]
            return dict(due_at=datetime(due["year"], due["month"], due["day"],
                                        tzinfo=UTC).timestamp())
        self.writes += 1
        if op == "complete-occurrence":
            if row["rules"]:
                done = copy.deepcopy(row)
                done.update(id=f"{row['id']}-done-{self.writes}", completed=True, rules=[],
                            externalId=f"{row['externalId']}-done-{self.writes}")
                self.rows.append(done)
                day = datetime(**{k: row["due"][k] for k in ("year", "month", "day")})
                day += timedelta(days=1)
                row["due"] = dict(year=day.year, month=day.month, day=day.day)
            else:
                row["completed"] = True
            self.touch(row)
            return None
        if op == "human-edit":
            row.update(fields["patch"])
        elif op == "human-reopen":
            row["completed"] = False
        else:
            raise AssertionError(op)
        self.touch(row)
        return copy.deepcopy(row)

    def link(self, expected, notes):
        """The claim write: saved only if the reminder is still exactly what was read."""
        row = self._checked(expected)
        self.writes += 1
        row["notes"] = notes
        self.touch(row)
        return copy.deepcopy(row)


class Worker:
    """One Mac's Hermes tasks."""

    def __init__(self):
        self.tasks, self.keys, self.log = {}, {}, []

    def create(self, key, title, body, **kwargs):
        if key not in self.keys:
            self.keys[key] = f"t{len(self.tasks)}"
            self.tasks[self.keys[key]] = "ready"
        return self.keys[key]

    def observe(self, task):
        return dict(state=self.tasks[task], runs=[], comments=[], task={})

    def _workers_stopped(self, task):
        return True

    def pause(self, task):
        self.tasks[task] = "paused"
        self.log.append(("pause", task))
        return dict(worker_stop_verified=True)

    def stop(self, task):
        self.tasks[task] = "stopped"
        self.log.append(("stop", task))
        return dict(worker_stop_verified=True)

    def accept(self, task):
        assert self.tasks[task] == "result"
        self.tasks[task] = "done"
        self.log.append(("accept", task))
        return True

    def comment(self, *args):
        pass

    def resume(self, task):
        self.tasks[task] = "ready"
        return True


class Clock:
    def __init__(self):
        self.at = 1_000_000.0

    def __call__(self):
        return self.at


class Mac:
    def __init__(self, root, name, rows, mode, owner, clock, *, writer=True):
        self.name, self.home, self.clock = name, root / name.replace(" ", "-"), clock
        (self.home / "reminders-kanban").mkdir(parents=True)
        if owner:
            with sqlite3.connect(Links(self.home).path) as db:
                db.executescript(Links.SCHEMA)
                db.execute("INSERT INTO owner VALUES (?)", (owner,))
        if mode == "local":
            (self.home / "reminders-kanban/link-setup.json").write_text('{"mode":"local"}')
        self.store, self.worker = Store(name, rows), Worker()
        self.admission = Admission(self.worker)
        self.kwargs = dict(
            origin=f"https://{name.lower().replace(' ', '-')}.tail.ts.net"
            if mode == "links" else None,
            call=self.store, write_link=self.store.link if writer else None,
            control_factory=lambda *_: self.worker, mac=name, now=clock,
        )
        # The store's writer takes either kind of reminder, like the two helper ops together.
        self.kwargs["write_other"] = self.kwargs["write_link"]
        self.restart()

    def restart(self, **changes):
        """New service objects over the same home, as after a Hermes restart."""
        self.kwargs.update(changes)
        self.d = Delegation(self.home, self.admission, **self.kwargs)
        self.o = OccurrenceDelegation(self.home, self.admission, **self.kwargs)
        self.o.clock = lambda: datetime(2027, 1, 1, tzinfo=UTC).timestamp()
        with self.d.setup.locked() as db:
            state = self.d.setup.read(db)
            state.update(selected_list_ids=["list", "list2"], selection_saved=True)
            self.d.setup.save(db, state)

    @property
    def owner(self):
        return Links(self.home).owner_id(create=False)

    def _run(self, service, action, **fields):
        # What the HTTP route answers (api/delegation.py run).
        try:
            return service.apply(action, **fields)
        except HelperError as exc:
            return dict(status=exc.code, error=str(exc))
        except (ValueError, KeyError, TypeError) as exc:
            return dict(status="attention", reason=str(exc))

    def act(self, action, rid=None, **fields):
        if rid:
            fields["expected"] = self.snap(rid)
        return self._run(self.d, action, **fields)

    def occ(self, action, rid=None, **fields):
        if rid:
            fields["expected"] = self.snap(rid)
        return self._run(self.o, action, **fields)

    def tick(self):
        # As Desktop does: the board is read, then the owner checks. (Read again only when the
        # reminders changed: each read is a synced database write.)
        seen = json.dumps(self.store.rows, sort_keys=True)
        if seen != getattr(self, "_board_seen", None) and not self.store.down:
            with self.reads() as human:
                human.board()
            self._board_seen = seen
        assert self.act("tick")["status"] == "ok"
        assert self.occ("tick")["status"] == "ok"

    def snap(self, rid):
        return copy.deepcopy(self.store.find(rid))

    def notes(self, rid):
        return self.store.find(rid)["notes"]

    def claim_owners(self, rid):
        # Claims carry short ids; the tests name installs by their whole id.
        return [FULL.get(claim["owner"], claim["owner"]) for claim in claims(self.notes(rid))]

    def rows(self, rid=None, service=None):
        service = service or self.d
        with service.store.connection() as db:
            rows = service._rows(db)
        return [r for r in rows if rid is None or r["expected"]["externalId"] == "ext-" + rid]

    def row(self, rid, service=None):
        found = self.rows(rid, service)
        return next((r for r in found if not r.get("storage_key")), None)

    def state(self, rid, service=None):
        return self.worker.tasks[self.row(rid, service)["task_id"]]

    @contextmanager
    def reads(self):
        real, helper.run = helper.run, self.store
        try:
            yield Human(self.home, call=self.store, mac=self.name)
        finally:
            helper.run = real

    def card(self, rid):
        self._board_seen = json.dumps(self.store.rows, sort_keys=True)
        with self.reads() as human:
            return next(c for c in human.board()["cards"]
                        if c["source"]["externalId"] == "ext-" + rid)

    def human(self, action, rid, **fields):
        with self.reads() as human:
            return human.apply(Action(operation_id=str(uuid4()), action=action,
                                      expected=self.snap(rid), fields=fields))


def sync(source, target, rid):
    """iCloud delivers `source`'s copy of a reminder to `target`: last writer wins."""
    theirs, mine = source.store.find(rid), target.store.find(rid)
    keep = mine["id"]
    mine.clear()
    mine.update(copy.deepcopy(theirs), id=keep)


def sync_all(source, target):
    """Every reminder, including the completed copies a repeating reminder leaves behind."""
    for theirs in source.store.rows:
        mine = next((r for r in target.store.rows if r["externalId"] == theirs["externalId"]),
                    None)
        if mine is None:
            mine = dict(id=theirs["id"].replace(source.name + ":", target.name + ":", 1))
            target.store.rows.append(mine)
        keep = mine["id"]
        mine.clear()
        mine.update(copy.deepcopy(theirs), id=keep)


def merge(rid, notes, *macs):
    """Apple kept both Macs' edits of the notes: every Mac ends with the same merged text."""
    for mac in macs:
        row = mac.store.find(rid)
        row["notes"] = notes
        row["modified"] = "merged"


@pytest.fixture
def world(tmp_path):
    clock = Clock()

    def make(name, rows, mode="local", owner=None, **options):
        return Mac(tmp_path, name, rows, mode, owner, clock, **options)

    make.clock = clock
    return make


def pair(world, rows, modes=("local", "local"), *, a_low=True):
    a = world("Studio", rows, modes[0], LOW if a_low else HIGH)
    b = world("MacBook Air", rows, modes[1], HIGH if a_low else LOW)
    for mac in (a, b):
        assert mac.act("activate")["status"] == "ok"
    return a, b


def wait(world):
    world.clock.at += SETTLE_SECONDS + 1


ONE = [reminder("r1", "Book flights", "Window seat")]


@pytest.mark.parametrize("modes", MODES)
def test_every_delegation_writes_a_claim(world, modes):
    a, b = pair(world, ONE, modes)
    assert a.act("ready", "r1")["status"] == "ok"
    found = claims(a.notes("r1"))
    assert [(c["owner"], c["mac"]) for c in found] == [(LOW[:8], "Studio")]
    link = a.row("r1")["destination"]["link_id"]
    assert link[:8] == found[0]["link"] and found[0]["start"] == int(world.clock.at)
    start = base36(world.clock.at)
    if modes[0] == "links":
        assert a.notes("r1").startswith("Window seat\n\nOpen in Hermes: https://studio.")
        assert found[0]["url"].endswith(f"&owner={LOW}&link={link}&profile=default"
                                        f"&mac=Studio&t={start}".split("&", 1)[1])
        # The row keeps one address for the task, without what only the claim says.
        assert a.row("r1")["destination"]["url"].endswith("&mac=Studio")
    else:
        assert a.notes("r1") == (
            f"Window seat\n\nIn Hermes on Studio (ref {LOW[:8]}.{link[:8]}.{start})")
        assert len(a.notes("r1").split("\n")[-1]) < 60
    # A single install: no wait, nothing but the claim line is new.
    a.tick()
    assert a.admission.starts == 1 and a.card("r1").get("elsewhere") is None
    assert a.card("r1")["claim"] == "mine"


@pytest.mark.parametrize("modes", MODES)
@pytest.mark.parametrize("a_low", [True, False])
def test_other_mac_skips_a_reminder_it_sees_claimed(world, modes, a_low):
    a, b = pair(world, ONE, modes, a_low=a_low)
    a.act("ready", "r1")
    sync(a, b, "r1")
    before = b.snap("r1")
    answer = b.act("ready", "r1")
    # A deliberate Delegate is told whose it is; nothing starts.
    assert (answer["status"], answer["reason"], answer["mac"]) == (
        "conflict", "other_mac", "Studio")
    assert answer["tasks"] == []
    for _ in range(2):
        a.tick()
        b.tick()
    assert a.admission.starts == 1 and a.state("r1") == "active"
    assert not b.worker.tasks and b.snap("r1") == before
    assert b.card("r1")["elsewhere"]["mac"] == "Studio"


@pytest.mark.parametrize("modes", MODES)
@pytest.mark.parametrize("a_low", [True, False])
@pytest.mark.parametrize("survives", ["both", "a", "b"])
def test_both_delegate_inside_the_sync_window(world, modes, a_low, survives):
    a, b = pair(world, ONE, modes, a_low=a_low)
    a.act("ready", "r1")
    b.act("ready", "r1")
    a.tick()
    b.tick()
    # Neither had seen the other: both started.
    assert a.admission.starts == b.admission.starts == 1
    line_a, line_b = (claims(mac.notes("r1"))[0]["line"] for mac in (a, b))
    if survives == "both":
        merge("r1", f"Window seat\n\n{line_a}\n\n{line_b}", a, b)
    elif survives == "a":
        sync(a, b, "r1")
    else:
        sync(b, a, "r1")
    # Claimed in the same second: the smaller id keeps it, whichever line survived the sync
    # (each Mac counts its own recorded claim along with the lines it sees).
    winner, loser = (a, b) if a_low else (b, a)
    # Whichever Mac checks first, and however often, they agree.
    for first, second in ((loser, winner), (winner, loser), (winner, loser)):
        first.tick()
        second.tick()
        sync(winner, loser, "r1")
    assert winner.state("r1") == "active" and winner.row("r1")["status"] == "active"
    assert winner.row("r1").get("guard", {}).get("reason") is None
    assert winner.claim_owners("r1") == [winner.owner] == loser.claim_owners("r1")
    released = loser.row("r1")
    assert released["status"] == "stopped" and loser.state("r1") == "stopped"
    assert released["released"]["reason"] == released["guard"]["reason"]
    assert released["released"]["reason"] in {"yielded", "taken_over"}
    assert released["released"]["mac"] == winner.name
    assert winner.admission.starts == loser.admission.starts == 1
    assert loser.card("r1")["elsewhere"]["mac"] == winner.name
    assert winner.card("r1").get("elsewhere") is None


def test_settle_window_only_after_another_install_was_seen(world):
    rows = ONE + [reminder("r2", "Pay rent", "Two"), reminder("r3", "Call mum", "Three")]
    a, b = pair(world, rows)
    b.act("ready", "r2")
    b.tick()
    assert b.admission.starts == 1 and not Links(b.home).seen_foreign()
    a.act("ready", "r1")
    sync(a, b, "r1")
    assert b.card("r1")["elsewhere"]
    assert Links(b.home).seen_foreign()
    b.act("ready", "r3")
    b.tick()
    # Held: it reads as queued, with its claim already in the notes.
    assert b.admission.starts == 1 and b.state("r3") == "paused"
    assert b.row("r3")["guard"]["status"] == "active" and "reason" not in b.row("r3")
    assert b.claim_owners("r3") == [HIGH]
    world.clock.at += SETTLE_SECONDS - 1
    b.tick()
    assert b.admission.starts == 1
    world.clock.at += 2
    b.tick()
    assert b.admission.starts == 2 and b.state("r3") == "active"


@pytest.mark.parametrize("b_low", [True, False])
def test_inside_the_window_the_loser_never_starts(world, b_low):
    a, b = pair(world, ONE, a_low=not b_low)
    Links(b.home).mark_foreign()
    a.act("ready", "r1")
    b.act("ready", "r1")
    a.tick()
    b.tick()
    assert (a.admission.starts, b.admission.starts) == (1, 0)
    line_a, line_b = (claims(mac.notes("r1"))[0]["line"] for mac in (a, b))
    merge("r1", f"Window seat\n\n{line_a}\n\n{line_b}", a, b)
    wait(world)
    b.tick()
    if b_low:
        # B keeps it: it starts once a fresh read shows only its own claim.
        assert b.admission.starts == 1 and b.claim_owners("r1") == [LOW]
        sync(b, a, "r1")
        a.tick()
        b.tick()
        assert b.state("r1") == "active" and a.state("r1") == "stopped"
        assert a.row("r1")["released"]["reason"] == "taken_over"
    else:
        assert b.row("r1")["released"]["reason"] == "yielded"
        a.tick()
        b.tick()
        assert b.admission.starts == 0 and b.state("r1") == "stopped"
        assert a.state("r1") == "active" and a.claim_owners("r1") == [LOW]


@pytest.mark.parametrize("modes", [("local", "local"), ("links", "links")])
@pytest.mark.parametrize("phase", ["queued", "running", "question", "result"])
def test_take_over_stops_the_other_mac(world, modes, phase):
    a, b = pair(world, ONE, modes)
    a.act("ready", "r1")
    if phase != "queued":
        a.tick()
    if phase in {"question", "result"}:
        a.worker.tasks[a.row("r1")["task_id"]] = phase
        a.tick()
    sync(a, b, "r1")
    card = b.card("r1")
    assert card["elsewhere"]["mac"] == "Studio" and card["owner"] == "agent"
    assert bool(card["elsewhere"]["url"]) == (modes[0] == "links")
    assert b.act("take_over", "r1")["status"] == "ok"
    assert b.claim_owners("r1") == [HIGH]
    assert b.notes("r1").startswith("Window seat\n\n")
    assert b.card("r1").get("elsewhere") is None and b.row("r1")["status"] == "ready"
    b.tick()
    assert b.admission.starts == 0  # B has seen another install: its claim settles first.
    wait(world)
    b.tick()
    assert b.state("r1") == "active"
    a_writes = a.store.writes
    sync(b, a, "r1")
    a.tick()
    a.tick()
    released = a.row("r1")
    assert released["status"] == "stopped" and a.state("r1") == "stopped"
    assert released["released"] == dict(released["released"], reason="taken_over",
                                        mac="MacBook Air", owner=HIGH[:8])
    assert released["guard"]["reason"] == "taken_over"
    # Nothing for the person to do on A, and A never touched the reminder.
    assert a.store.writes == a_writes and not a.snap("r1")["completed"]
    assert ("accept", released["task_id"]) not in a.worker.log
    card = a.card("r1")
    assert card["elsewhere"]["mac"] == "MacBook Air" and card["column"] == "In progress"
    b.tick()
    assert b.state("r1") == "active" and b.claim_owners("r1") == [HIGH]


def test_take_over_fails_safely_when_the_reminder_changed(world):
    a, b = pair(world, ONE)
    a.act("ready", "r1")
    sync(a, b, "r1")
    stale = b.snap("r1")
    b.store.find("r1")["title"] = "Book trains"
    b.store.touch(b.store.find("r1"))
    answer = b.act("take_over", expected=stale)
    assert answer["status"] == "attention" and not b.worker.tasks
    assert b.claim_owners("r1") == [LOW]


def test_a_offline_during_take_over_then_back(world):
    a, b = pair(world, ONE)
    a.act("ready", "r1")
    a.tick()
    a.worker.tasks[a.row("r1")["task_id"]] = "result"
    sync(a, b, "r1")
    # A goes offline holding a result. B takes over, finishes and checks the reminder off.
    b.act("take_over", "r1")
    wait(world)
    b.tick()
    b.worker.tasks[b.row("r1")["task_id"]] = "result"
    b.tick()
    assert b.act("accept", "r1")["status"] == "ok"
    assert b.row("r1")["status"] == "done" and b.snap("r1")["completed"]
    sync(b, a, "r1")
    a.tick()
    # A's old result is not accepted as if it had finished the reminder.
    assert a.row("r1")["released"]["reason"] == "taken_over"
    assert a.worker.log == [("stop", a.row("r1")["task_id"])]
    assert a.card("r1")["column"] == "Done"


def test_other_mac_gone_forever(world):
    a, b = pair(world, ONE, ("links", "links"))
    a.act("ready", "r1")
    a.tick()
    sync(a, b, "r1")
    # A is switched off for good. B can still get the reminder done.
    assert b.act("ready", "r1")["tasks"] == []
    assert b.act("take_over", "r1")["status"] == "ok"
    wait(world)
    b.tick()
    b.worker.tasks[b.row("r1")["task_id"]] = "result"
    b.tick()
    b.act("accept", "r1")
    assert b.row("r1")["status"] == "done" and b.snap("r1")["completed"]


@pytest.mark.parametrize("mode", ["local", "links"])
@pytest.mark.parametrize("wiped", ["tasks", "everything"])
def test_lost_own_claim_then_delegate(world, mode, wiped):
    a = world("Studio", ONE, mode, LOW)
    a.act("activate")
    a.act("ready", "r1")
    stale = claims(a.notes("r1"))[0]
    # The task databases were lost. "tasks": the install id survived. "everything": it did not.
    for path in (a.home / "reminders-kanban").iterdir():
        if path.name.startswith(("delegation", "current-")) or (
                wiped == "everything" and path.name.startswith("links")):
            path.unlink()
    if wiped == "tasks":
        with sqlite3.connect(Links(a.home).path) as db:
            db.execute("DELETE FROM links")
            db.execute("DELETE FROM occurrences")
    a.worker.tasks.clear()
    a.worker.keys.clear()
    a.restart()
    assert a.act("activate")["status"] == "ok"
    card = a.card("r1")
    if wiped == "tasks":
        # Its own claim, with nothing local behind it: Delegate just works.
        assert card["claim"] == "lost" and card.get("elsewhere") is None
        assert a.act("ready", "r1")["status"] == "ok"
    else:
        # A new install id: the old claim reads as another Hermes on a Mac of the same name.
        assert card["elsewhere"]["mac"] == "Studio"
        assert a.act("ready", "r1")["tasks"] == []
        assert a.act("take_over", "r1")["status"] == "ok"
        wait(world)
    fresh = claims(a.notes("r1"))
    assert len(fresh) == 1 and fresh[0]["link"] != stale["link"]
    assert a.notes("r1").startswith("Window seat\n\n")
    a.tick()
    a.tick()
    assert a.state("r1") == "active" and a.row("r1")["status"] == "active"


def test_pickup_switch_on_passes_over_the_other_macs_reminders(world):
    ready = "[Agent · Ready] "
    rows = [reminder(f"r{n}", f"{ready}Task {n}", f"Notes {n}") for n in range(1, 6)]
    rows[4]["notes"] = "Notes 5\n\nOpen in Hermes: https://elsewhere.example/not-a-task"
    a = world("Studio", [rows[0], rows[2]], "links", LOW)
    b = world("MacBook Air", rows, "links", HIGH)
    assert a.act("activate")["status"] == "ok"
    assert len(a.rows()) == 2
    sync(a, b, "r1")
    sync(a, b, "r3")
    assert b.card("r1")["imported_ready"] is False
    with b.reads() as human:
        assert human.board()["ready_count"] == 3
    answer = b.act("activate")
    assert answer["status"] == "ok" and answer["pickup_enabled"] is True
    with b.d.store.locked() as db:
        eligible = b.d._preview(db)["eligible"]
    assert [e["externalId"] for e in eligible] == ["ext-r2", "ext-r4", "ext-r5"]
    # The unclaimed ones after a claimed one still import; nothing aborts.
    assert sorted(r["expected"]["externalId"] for r in b.rows()) == ["ext-r2", "ext-r4"]
    assert b.snap("r1") == a.snap("r1") | {"id": b.snap("r1")["id"]}
    wait(world)
    b.tick()
    assert b.admission.starts == 2
    assert b.act("activate")["status"] == "ok" and len(b.rows()) == 2


def test_human_writes_on_the_other_mac_are_refused(world):
    a, b = pair(world, [reminder("p1", "Plain task", "Some notes")], ("links", "links"))
    a.act("ready", "p1")
    a.tick()
    sync(a, b, "p1")
    before = b.snap("p1")
    card = b.card("p1")
    # Unlabelled, so nothing in its title says an agent has it.
    assert card["owner"] == "agent" and card["column"] == "In progress"
    assert card["elsewhere"] == dict(mac="Studio", url=claims(before["notes"])[0]["url"])
    assert not any(card["capabilities"][key] for key in ("edit", "complete", "progress", "reopen"))
    attempts = [
        ("edit", dict(title="Plain task, edited")),
        ("edit", dict(notes=before["notes"] + "\nmore")),
        ("edit", dict(calendarId="list2")),
        ("progress", dict(column="In progress")),
        ("complete", {}),
    ]
    for action, fields in attempts:
        out = b.human(action, "p1", **fields)
        assert (out["status"], out["reason"], out["mac"]) == ("conflict", "other_mac", "Studio")
    assert b.snap("p1") == before and b.store.writes == 0
    # Checked off in Reminders itself: it reads as done, and reopening is A's too.
    b.store.find("p1")["completed"] = True
    out = b.human("reopen", "p1", column="To do")
    assert (out["status"], out["reason"]) == ("conflict", "other_mac")
    assert b.card("p1")["column"] == "Done" and "elsewhere" not in b.card("p1")
    # The Mac that has it still treats that check-off as the person's answer.
    a.worker.tasks[a.row("p1")["task_id"]] = "result"
    sync(b, a, "p1")
    a.tick()
    assert a.row("p1")["status"] == "done"


def test_own_reminders_stay_editable_and_uncounted(world):
    rows = [reminder("p1", "Plain task", "Some notes"), reminder("p2", "Mine", "Other notes")]
    a, b = pair(world, rows)
    a.act("ready", "p1")
    sync(a, b, "p1")
    assert b.human("progress", "p2", column="In progress")["status"] == "ok"
    assert b.human("edit", "p2", title="Mine, edited")["status"] == "ok"
    assert b.card("p2")["owner"] == "human" and "claim" not in b.card("p2")


REPEATING = [reminder("d1", "Daily report", "Summarize", repeats=True)]


@pytest.mark.parametrize("modes", [("local", "local"), ("links", "links")])
def test_repeating_reminder_on_the_other_mac(world, modes):
    a, b = pair(world, REPEATING, modes)
    assert a.occ("every", "d1")["status"] == "ok"
    a.tick()
    assert a.state("d1", a.o) == "active" and a.claim_owners("d1") == [LOW]
    sync_all(a, b)
    before = b.snap("d1")
    for action in ("every", "ready"):
        answer = b.occ(action, "d1")
        assert (answer["status"], answer["reason"], answer["mac"]) == (
            "conflict", "other_mac", "Studio")
        assert answer["tasks"] == []
    assert not b.worker.tasks and b.snap("d1") == before
    card = b.card("d1")
    assert card["elsewhere"]["mac"] == "Studio" and card["column"] == "In progress"
    # Take over goes through the usual occurrence choice.
    assert b.occ("ready", "d1", take_over=True)["status"] == "ok"
    assert b.claim_owners("d1") == [HIGH] and b.row("d1", b.o)["scope"] == "this_occurrence"
    wait(world)
    b.tick()
    assert b.state("d1", b.o) == "active"
    sync_all(b, a)
    a.tick()
    a.tick()
    released = a.row("d1", a.o)
    assert released["status"] == "stopped" and released["released"]["reason"] == "taken_over"
    assert a.state("d1", a.o) == "stopped" and len(a.rows("d1", a.o)) == 1
    assert a.card("d1")["elsewhere"]["mac"] == "MacBook Air"
    # B finishes its occurrence. The next date keeps B's claim; A prepares nothing for it.
    b.worker.tasks[b.row("d1", b.o)["task_id"]] = "result"
    b.tick()
    assert b.occ("accept", occurrence_id=b.row("d1", b.o)["key"])["status"] == "ok"
    assert b.snap("d1")["due"]["day"] == 7
    sync_all(b, a)
    a.tick()
    assert len(a.rows(service=a.o)) == 1 and len(a.worker.tasks) == 1
    # And A can take it back, as a new task with the released one kept as history.
    assert a.occ("every", "d1", take_over=True)["status"] == "ok"
    assert a.claim_owners("d1") == [LOW] and len(a.rows(service=a.o)) == 2


def test_take_over_of_every_occurrence_with_every_occurrence(world):
    a, b = pair(world, REPEATING)
    a.occ("every", "d1")
    a.tick()
    sync_all(a, b)
    assert b.occ("every", "d1", take_over=True)["status"] == "ok"
    assert b.row("d1", b.o)["scope"] == "every_occurrence" and b.claim_owners("d1") == [HIGH]
    sync_all(b, a)
    a.tick()
    assert a.row("d1", a.o)["released"]["reason"] == "taken_over"


def test_next_occurrence_inherits_the_claim(world):
    a, b = pair(world, REPEATING)
    Links(a.home).mark_foreign()
    a.occ("every", "d1")
    wait(world)
    a.tick()
    first = a.row("d1", a.o)
    line = claims(a.notes("d1"))[0]["line"]
    a.worker.tasks[first["task_id"]] = "result"
    a.tick()
    assert a.occ("accept", occurrence_id=first["key"])["status"] == "ok"
    a.tick()
    a.tick()
    rows = a.rows(service=a.o)
    assert len(rows) == 2 and rows[1]["predecessor"] == first["key"]
    # Rolled to the next date with the same line: no second claim, no settle wait.
    assert a.notes("d1").count(line) == 1 and len(claims(a.notes("d1"))) == 1
    assert rows[1]["claimed_at"] == 0 and a.worker.tasks[rows[1]["task_id"]] == "active"
    assert rows[1]["destination"] == first["destination"]
    sync_all(a, b)
    assert b.occ("ready", "d1")["tasks"] == []
    cards = {}
    with b.reads() as human:
        for card in human.board()["cards"]:
            cards[card["column"]] = card
    assert cards["In progress"]["elsewhere"]["mac"] == "Studio"
    assert "elsewhere" not in cards["Done"]


def test_both_choose_every_occurrence_inside_the_sync_window(world):
    a, b = pair(world, REPEATING)
    a.occ("every", "d1")
    b.occ("every", "d1")
    a.tick()
    b.tick()
    line_a, line_b = (claims(mac.notes("d1"))[0]["line"] for mac in (a, b))
    merge("d1", f"Summarize\n\n{line_b}\n\n{line_a}", a, b)
    b.tick()
    a.tick()
    sync_all(a, b)
    b.tick()
    a.tick()
    assert a.state("d1", a.o) == "active" and a.row("d1", a.o)["status"] == "active"
    assert b.row("d1", b.o)["released"]["reason"] == "yielded"
    assert a.claim_owners("d1") == b.claim_owners("d1") == [LOW]


def test_legacy_local_row_gets_its_claim_backfilled(world):
    # A row delegated before claims existed: "Only on this Mac" wrote nothing.
    a = world("Studio", ONE, "local", LOW, writer=False)
    b = world("MacBook Air", ONE, "local", HIGH)
    a.act("activate")
    a.act("ready", "r1")
    a.tick()
    assert a.notes("r1") == "Window seat" and a.state("r1") == "active"
    assert "claim" not in a.row("r1") or a.row("r1")["claim"] is None
    with a.d.store.locked() as db:
        legacy = a.d._rows(db)[0]
        del legacy["claim_start"]
        a.d._save(db, legacy)
    a.restart(write_link=a.store.link)
    a.tick()
    link = a.row("r1")["destination"]["link_id"]
    # A row from before claims has no start time: its line reads as the earliest.
    assert a.notes("r1") == f"Window seat\n\nIn Hermes on Studio (ref {LOW[:8]}.{link[:8]}.0)"
    assert a.row("r1")["claim"] and a.row("r1")["backfill"] == "done"
    writes = a.store.writes
    a.tick()
    a.tick()
    # Written once, and not mistaken for changed instructions.
    assert a.store.writes == writes and a.state("r1") == "active"
    assert a.row("r1")["status"] == "active" and a.admission.starts == 1
    sync(a, b, "r1")
    assert b.card("r1")["elsewhere"]["mac"] == "Studio"


def test_switching_to_links_replaces_the_local_claim_line(world):
    a = world("Studio", ONE, "local", LOW)
    a.act("activate")
    a.act("ready", "r1")
    a.tick()
    link = a.row("r1")["destination"]["link_id"]
    start = claims(a.notes("r1"))[0]["start"]
    assert a.notes("r1").endswith(f"(ref {LOW[:8]}.{link[:8]}.{base36(start)})") and start
    a.restart(origin="https://studio.tail.ts.net")
    a.tick()
    found = claims(a.notes("r1"))
    assert [(c["owner"], c["link"], c["mac"]) for c in found] == [(LOW[:8], link[:8], "Studio")]
    # The same run: the link line keeps the start time the local line had.
    assert found[0]["start"] == start
    assert found[0]["url"].startswith(a.row("r1")["destination"]["url"] + "&t=")
    assert "In Hermes on" not in a.notes("r1")
    assert a.notes("r1") == f"Window seat\n\nOpen in Hermes: {found[0]['url']}"
    a.tick()
    assert a.state("r1") == "active" and a.row("r1")["status"] == "active"


@pytest.mark.parametrize("modes", [("local", "local"), ("links", "links")])
def test_claim_lines_never_read_as_changed_instructions(world, modes):
    a, b = pair(world, ONE, modes)
    a.act("ready", "r1")
    a.tick()
    b.act("ready", "r1")
    own, theirs = (claims(mac.notes("r1"))[0]["line"] for mac in (a, b))
    # B's line arrives, A (the smaller id) removes it again: two note changes, no pause.
    merge("r1", f"Window seat\n\n{own}\n\n{theirs}", a)
    a.tick()
    assert a.claim_owners("r1") == [LOW]
    a.tick()
    assert a.row("r1")["status"] == "active" and a.state("r1") == "active"
    # A real change to the text still pauses it.
    a.store.find("r1")["notes"] = f"Aisle seat\n\n{own}"
    a.tick()
    assert a.row("r1")["guard"]["reason"] == "instructions_changed"
    assert a.state("r1") == "paused"


@pytest.mark.parametrize("modes", [("local", "local"), ("links", "links")])
def test_duplicated_reminder_and_doubled_claim_keep_their_holds(world, modes):
    rows = ONE + [reminder("r2", "Pay rent", "Two")]
    a, _ = pair(world, rows, modes)
    a.act("ready", "r1")
    a.act("ready", "r2")
    a.tick()
    # r1 duplicated in Reminders: the same single claim now sits on two reminders.
    copied = dict(a.snap("r1"), id="Studio:copy", externalId="ext-copy")
    a.store.rows.append(copied)
    # r2 with two claims from this same install.
    a.store.find("r2")["notes"] += "\n\n" + local_line(LOW, uuid4(), "Studio", 5)
    a.tick()
    assert a.row("r1")["guard"]["reason"] == "multiple_candidates"
    assert a.row("r2")["guard"]["reason"] == "conflicting_links"
    assert a.state("r1") == a.state("r2") == "paused"
    assert "released" not in a.row("r1") and "released" not in a.row("r2")
    # The copy is nobody's task: the board never starts it.
    assert a.act("ready", expected=copied)["status"] == "attention"


def test_stored_rows_survive_json_round_trip(world):
    a, b = pair(world, ONE)
    a.act("ready", "r1")
    sync(a, b, "r1")
    b.act("take_over", "r1")
    json.dumps(b.rows() + a.rows())


def test_taking_it_back_and_forth(world):
    a, b = pair(world, ONE, ("links", "local"))
    a.act("ready", "r1")
    a.tick()
    sync(a, b, "r1")
    b.act("take_over", "r1")
    sync(b, a, "r1")
    a.tick()
    first = a.row("r1")
    assert first["released"]["reason"] == "taken_over"
    # A plain Delegate on A still passes over it; Take over brings it back as a new task.
    assert len(a.act("ready", "r1")["tasks"]) == 1 and a.claim_owners("r1") == [HIGH]
    assert a.act("take_over", "r1")["status"] == "ok"
    assert a.claim_owners("r1") == [LOW] and len(a.rows("r1")) == 2
    assert a.row("r1")["key"] != first["key"] and a.row("r1")["status"] == "ready"
    sync(a, b, "r1")
    b.tick()
    assert b.row("r1")["released"]["reason"] == "taken_over" and b.state("r1") == "stopped"
    wait(world)
    a.tick()
    assert a.state("r1") == "active" and a.admission.starts == 2


def test_take_over_routes(world):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from reminders_kanban.api import delegation, occurrence, recurring

    rows = ONE + REPEATING + [reminder("d2", "Weekly review", "Review", repeats=True)]
    a, b = pair(world, rows)
    a.act("ready", "r1")
    a.occ("every", "d1")
    a.occ("ready", "d2")
    sync_all(a, b)
    app = FastAPI()
    for module in (delegation, occurrence, recurring):
        app.include_router(module.router)
    app.dependency_overrides[delegation.service] = lambda: b.d
    app.dependency_overrides[occurrence.service] = lambda: b.o
    client = TestClient(app)

    def post(path, **body):
        response = client.post(path, json=body)
        assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
        return response.json()

    assert post("/delegation/actions", action="ready", expected=b.snap("r1"))["tasks"] == []
    assert post("/occurrences/actions", action="ready", expected=b.snap("d2"))["tasks"] == []
    assert post("/delegation/actions", action="take_over", expected=b.snap("r1"))["status"] == "ok"
    assert post("/occurrences/actions", action="ready", expected=b.snap("d2"),
                take_over=True)["status"] == "ok"
    assert post("/recurring/actions", action="every", expected=b.snap("d1"),
                take_over=True)["status"] == "ok"
    assert [b.claim_owners(rid) for rid in ("r1", "d1", "d2")] == [[HIGH]] * 3


# Releasing the claim: the reminder is the person's again.


@pytest.mark.parametrize("modes", [("local", "local"), ("links", "links")])
def test_stop_gives_the_reminder_back_on_both_macs(world, modes):
    a, b = pair(world, ONE, modes)
    a.act("ready", "r1")
    a.tick()
    writes = a.store.writes
    assert a.d.stop(a.row("r1")["task_id"])["outcome"] == "stopped"
    # Stop itself never touches Reminders; the next check takes the line off.
    assert a.store.writes == writes and a.claim_owners("r1") == [LOW]
    a.tick()
    assert a.notes("r1") == "Window seat" and a.store.writes == writes + 1
    a.tick()
    assert a.store.writes == writes + 1
    # A's own stopped card is as before: its row, its task, its link to the conversation.
    stopped = a.row("r1")
    assert stopped["status"] == "stopped" and stopped["destination"]["link_id"]
    assert a.card("r1")["owner"] == "human" and "claim" not in a.card("r1")
    # On the other Mac it is an ordinary reminder again.
    sync(a, b, "r1")
    card = b.card("r1")
    assert "elsewhere" not in card and "claim" not in card and card["owner"] == "human"
    assert b.human("edit", "r1", title="Book trains")["status"] == "ok"
    sync(b, a, "r1")
    # Delegating again writes a fresh claim.
    assert a.act("ready", "r1")["status"] == "ok"
    assert a.claim_owners("r1") == [LOW] and len(a.rows("r1")) == 2


def test_release_is_retried_and_never_blocks(world):
    a, _ = pair(world, ONE)
    a.act("ready", "r1")
    a.tick()
    a.worker.tasks[a.row("r1")["task_id"]] = "failed"
    a.tick()
    real, calls = a.store.link, []

    def flaky(expected, notes):
        calls.append(notes)
        if len(calls) == 1:
            raise HelperError("conflict", "Source changed")
        return real(expected, notes)

    a.restart(write_link=flaky)
    assert a.d.stop(a.row("r1")["task_id"])["outcome"] == "stopped"
    a.tick()
    assert a.claim_owners("r1") == [LOW] and a.row("r1")["status"] == "stopped"
    # Reminders unreadable: nothing happens, nothing breaks.
    a.store.down = True
    a.act("tick")
    a.occ("tick")
    assert a.row("r1")["status"] == "stopped" and len(calls) == 1
    a.store.down = False
    a.tick()
    # A failed pass waits before the next one.
    assert len(calls) == 1 and a.claim_owners("r1") == [LOW]
    world.clock.at += 61
    a.tick()
    assert a.notes("r1") == "Window seat" and len(calls) == 2


def test_accepted_one_off_keeps_its_line_until_reopened(world):
    a, b = pair(world, ONE, ("links", "links"))
    a.act("ready", "r1")
    a.tick()
    a.worker.tasks[a.row("r1")["task_id"]] = "result"
    a.tick()
    a.act("accept", "r1")
    writes = a.store.writes
    a.card("r1")
    a.tick()
    # Complete: the notes are left alone.
    assert a.snap("r1")["completed"] and a.claim_owners("r1") == [LOW]
    assert a.store.writes == writes
    # Unchecked in Reminders: the board treats it as the person's again.
    a.store.find("r1")["completed"] = False
    a.store.touch(a.store.find("r1"))
    a.tick()
    assert a.claim_owners("r1") == [LOW]
    # A finished reminder is looked at again every ten minutes.
    world.clock.at += 601
    a.tick()
    assert a.notes("r1") == "Window seat" and a.row("r1")["status"] == "done"
    sync(a, b, "r1")
    assert "elsewhere" not in b.card("r1")


def test_this_occurrence_does_not_leave_its_claim_on_the_next_date(world):
    a, b = pair(world, REPEATING, ("links", "links"))
    a.occ("ready", "d1")
    a.tick()
    first = a.row("d1", a.o)
    a.worker.tasks[first["task_id"]] = "result"
    a.tick()
    assert a.occ("accept", occurrence_id=first["key"])["status"] == "ok"
    a.tick()
    # Rolled to the next date without the line; the completed copy keeps its own.
    assert a.snap("d1")["due"]["day"] == 7 and a.notes("d1") == "Summarize"
    done = next(r for r in a.store.rows if r["completed"])
    assert len(claims(done["notes"])) == 1
    sync_all(a, b)
    card = b.card("d1")
    assert "elsewhere" not in card and card["owner"] == "human"
    assert b.human("progress", "d1", column="In progress")["status"] == "ok"
    # The next explicit Ready on A continues the same task link with a fresh claim.
    assert a.occ("ready", "d1")["status"] == "ok"
    rows = a.rows(service=a.o)
    assert len(rows) == 2 and rows[1]["authorization_id"] == first["authorization_id"]
    assert rows[1]["destination"] == first["destination"] and a.claim_owners("d1") == [LOW]
    # Stopped this time: released on the next check.
    a.occ("stop", occurrence_id=rows[1]["key"])
    assert a.claim_owners("d1") == [LOW]
    a.tick()
    assert a.notes("d1") == "Summarize"


def test_every_occurrence_keeps_its_claim_until_the_series_stops(world):
    a, _ = pair(world, REPEATING)
    a.occ("every", "d1")
    a.tick()
    first = a.row("d1", a.o)
    a.worker.tasks[first["task_id"]] = "result"
    a.tick()
    a.occ("accept", occurrence_id=first["key"])
    # The series still holds the reminder: the next date inherits the line.
    assert a.claim_owners("d1") == [LOW]
    a.tick()
    a.tick()
    rows = a.rows(service=a.o)
    assert len(rows) == 2 and a.claim_owners("d1") == [LOW]
    a.occ("stop", occurrence_id=rows[1]["key"])
    a.tick()
    assert a.notes("d1") == "Summarize" and len(a.rows(service=a.o)) == 2


# Take over is decisive.


@pytest.mark.parametrize("modes", [("local", "local"), ("links", "links")])
@pytest.mark.parametrize("a_low", [True, False])
def test_take_over_wins_even_when_both_lines_survive(world, modes, a_low):
    a, b = pair(world, ONE, modes, a_low=a_low)
    a.act("ready", "r1")
    a.tick()
    line_a = claims(a.notes("r1"))[0]["line"]
    sync(a, b, "r1")
    b.act("take_over", "r1")
    taken = claims(b.notes("r1"))[0]
    assert (taken["from"], taken["take"]) == (a.owner[:8], 1)
    # Apple kept both Macs' lines.
    merge("r1", f"Window seat\n\n{line_a}\n\n{taken['line']}", a, b)
    wait(world)
    for first, second in ((a, b), (b, a)):
        first.tick()
        second.tick()
        sync(b, a, "r1")
    assert b.state("r1") == "active" and b.claim_owners("r1") == [b.owner]
    assert a.row("r1")["released"]["reason"] == "yielded" and a.state("r1") == "stopped"
    assert a.claim_owners("r1") == [b.owner]
    assert a.card("r1")["elsewhere"]["mac"] == b.name


@pytest.mark.parametrize("a_low", [True, False])
def test_taken_back_resolves_to_the_latest_taker(world, a_low):
    a, b = pair(world, ONE, ("links", "local"), a_low=a_low)
    a.act("ready", "r1")
    first = claims(a.notes("r1"))[0]["line"]
    sync(a, b, "r1")
    b.act("take_over", "r1")
    second = claims(b.notes("r1"))[0]["line"]
    sync(b, a, "r1")
    a.tick()
    a.act("take_over", "r1")
    third = claims(a.notes("r1"))[0]
    assert (third["from"], third["take"]) == (b.owner[:8], 2)
    # Every line ever written came back.
    merge("r1", f"Window seat\n\n{second}\n\n{first}\n\n{third['line']}", a, b)
    wait(world)
    for first_mac, second_mac in ((b, a), (a, b)):
        first_mac.tick()
        second_mac.tick()
        sync(a, b, "r1")
    assert a.state("r1") == "active" and a.notes("r1") == f"Window seat\n\n{third['line']}"
    assert b.row("r1")["released"]["mac"] == a.name and b.state("r1") == "stopped"


def test_three_claims_settle_on_one_mac(world):
    mid = "88888888-8888-4888-8888-888888888888"
    a = world("Studio", ONE, "local", LOW)
    b = world("MacBook Air", ONE, "local", HIGH)
    c = world("Mini", ONE, "links", mid)
    for mac in (a, b, c):
        mac.act("activate")
    a.act("ready", "r1")
    c.act("ready", "r1")
    sync(a, b, "r1")
    b.act("take_over", "r1")
    lines = [claims(mac.notes("r1"))[0]["line"] for mac in (a, b, c)]
    merge("r1", "Window seat\n\n" + "\n\n".join(lines), a, b, c)
    wait(world)
    # A lost to B's take over; B and C never met, and a take over outranks a plain claim.
    for _ in range(2):
        for mac in (a, b, c):
            mac.tick()
        sync(b, a, "r1")
        sync(b, c, "r1")
    assert [m.state("r1") for m in (a, b, c)] == ["stopped", "active", "stopped"]
    assert b.claim_owners("r1") == [HIGH] == a.claim_owners("r1")
    assert a.row("r1")["released"]["mac"] == c.row("r1")["released"]["mac"] == "MacBook Air"


# The first collision ever: no settle window yet.


@pytest.mark.parametrize("modes", MODES)
def test_first_collision_stops_the_loser_at_once_and_never_pauses_the_winner(world, modes):
    a, b = pair(world, ONE, modes)
    a.act("ready", "r1")
    b.act("ready", "r1")
    a.tick()
    b.tick()
    assert not Links(a.home).seen_foreign() and not Links(b.home).seen_foreign()
    assert a.state("r1") == b.state("r1") == "active"
    line_a, line_b = (claims(mac.notes("r1"))[0]["line"] for mac in (a, b))
    merge("r1", f"Window seat\n\n{line_b}\n\n{line_a}", a, b)
    # One check is enough: the running worker is stopped and archived, with nothing to resolve.
    b.tick()
    task = b.row("r1")["task_id"]
    assert b.worker.log == [("stop", task)] and b.state("r1") == "stopped"
    lost = b.row("r1")
    assert lost["status"] == "stopped" and lost["stop_receipt"]["worker_stop_verified"]
    assert lost["guard"]["status"] == "stopped" and lost["guard"]["reason"] == "yielded"
    assert "recovery" not in lost or lost["recovery"] is None
    card = b.card("r1")
    assert card["column"] == "In progress" and card["elsewhere"]["mac"] == "Studio"
    # The winner is never paused or held, at any check.
    for _ in range(3):
        a.tick()
        b.tick()
        sync(a, b, "r1")
        kept = a.row("r1")
        assert kept["status"] == "active" and kept["guard"]["status"] == "active"
        assert kept["guard"].get("reason") is None
    assert not a.row("r1").get("contested") and a.claim_owners("r1") == [LOW]
    assert a.worker.log == [] and a.state("r1") == "active" and a.admission.starts == 1
    assert b.worker.log == [("stop", task)] and b.admission.starts == 1


# Review round: established work, stuck states, cheap release.

READY = [reminder("r1", "[Agent · Ready] Book flights", "Window seat")]


@pytest.mark.parametrize("a_low", [True, False])
@pytest.mark.parametrize("b_phase", ["active", "failed", "question", "result", "ran_3_minutes"])
@pytest.mark.parametrize("arrives", ["merge", "b_wins", "a_wins"])
def test_the_mac_that_was_there_first_keeps_its_work(world, a_low, b_phase, arrives):
    # A has finished work waiting. B wakes with an old copy and pickup on, and its duplicate
    # gets as far as it likes (it may itself fail, ask or finish) before A's claim reaches it.
    a = world("Studio", READY, "local", LOW if a_low else HIGH)
    b = world("MacBook Air", READY, "local", HIGH if a_low else LOW)
    Links(b.home).mark_foreign()
    a.act("activate")
    a.tick()
    task_a = a.row("r1")["task_id"]
    a.worker.tasks[task_a] = "result"
    a.tick()
    world.clock.at += 3600
    b.act("activate")
    b.tick()
    wait(world)
    b.tick()
    task_b = b.row("r1")["task_id"]
    assert b.worker.tasks[task_b] == "active"
    if b_phase == "ran_3_minutes":
        world.clock.at += 180
    else:
        b.worker.tasks[task_b] = b_phase
    b.tick()
    line_a, line_b = (claims(mac.notes("r1"))[0]["line"] for mac in (a, b))
    if arrives == "merge":
        merge("r1", f"Window seat\n\n{line_a}\n\n{line_b}", a, b)
    elif arrives == "b_wins":
        sync(b, a, "r1")
    else:
        sync(a, b, "r1")
    for turn in range(6):
        a.tick()
        b.tick()
        # iCloud: the later writer wins, each direction in turn.
        source, target = (b, a) if turn % 2 == 0 else (a, b)
        sync(source, target, "r1")
    # A's finished work is untouched; B's duplicate is the one that stops.
    assert "released" not in a.row("r1") and a.worker.tasks[task_a] == "result"
    assert a.worker.log == []
    assert b.row("r1")["released"]["mac"] == "Studio" and b.worker.tasks[task_b] == "stopped"
    # Nothing but a person's Take over ever writes a take over into a claim.
    assert [(c["owner"], c["from"], c["take"]) for c in claims(a.notes("r1"))] == [
        (a.owner[:8], None, 0)]
    assert a.notes("r1") == f"Window seat\n\n{line_a}" == b.notes("r1")


@pytest.mark.parametrize("a_low", [True, False])
def test_crossed_writes_never_leave_nobody_holding_the_reminder(world, a_low):
    a, b = pair(world, ONE, a_low=a_low)
    a.act("ready", "r1")
    world.clock.at += 30
    b.act("ready", "r1")
    for mac in (a, b):
        mac.tick()
        mac.worker.tasks[mac.row("r1")["task_id"]] = "result"
        mac.tick()
    # Each Mac receives only the other's line (its own was lost on the way).
    line_a, line_b = (claims(mac.notes("r1"))[0]["line"] for mac in (a, b))
    merge("r1", f"Window seat\n\n{line_b}", a)
    merge("r1", f"Window seat\n\n{line_a}", b)
    a.tick()
    b.tick()
    # Then the two answers cross again: each gets the other's result.
    notes_a, notes_b = a.notes("r1"), b.notes("r1")
    merge("r1", notes_b, a)
    merge("r1", notes_a, b)
    for _ in range(4):
        a.tick()
        b.tick()
        sync(a, b, "r1")
    # The earlier claim keeps it on both Macs, and exactly one holds it.
    assert "released" not in a.row("r1") and a.state("r1") == "result"
    assert b.row("r1")["released"]["mac"] == "Studio"
    assert a.claim_owners("r1") == [a.owner] == b.claim_owners("r1")


@pytest.mark.parametrize("a_low", [True, False])
@pytest.mark.parametrize("why", ["unchanged", "notes_edited", "due_moved"])
def test_take_over_cannot_be_undone_by_the_other_macs_late_copy(world, a_low, why):
    a, b = pair(world, ONE, a_low=a_low)
    a.act("ready", "r1")
    a.tick()
    a.worker.tasks[a.row("r1")["task_id"]] = "question"
    a.tick()
    sync(a, b, "r1")
    assert b.act("take_over", "r1")["status"] == "ok"
    taken = claims(b.notes("r1"))[0]["line"]
    row = a.store.find("r1")
    if why == "notes_edited":
        row["notes"] = row["notes"].replace("Window seat", "Window seat, row 12")
        a.store.touch(row)
    elif why == "due_moved":
        row["due"] = {"year": 2026, "month": 12, "day": 1}
        a.store.touch(row)
    # A's version (still carrying only A's line) lands on B after B's write.
    sync(a, b, "r1")
    for _ in range(4):
        world.clock.at += 20
        b.tick()
        sync(b, a, "r1")
        a.tick()
    # B wrote its line back; the person's choice stands on both Macs.
    assert claims(b.notes("r1"))[0]["line"] == taken and b.claim_owners("r1") == [b.owner]
    assert "released" not in b.row("r1")
    assert a.row("r1")["released"]["reason"] == "taken_over" and a.state("r1") == "stopped"


def test_explicit_take_over_still_takes_established_work(world):
    a, b = pair(world, ONE)
    a.act("ready", "r1")
    a.tick()
    a.worker.tasks[a.row("r1")["task_id"]] = "result"
    a.tick()
    sync(a, b, "r1")
    b.act("take_over", "r1")
    sync(b, a, "r1")
    a.tick()
    assert a.row("r1")["released"]["reason"] == "taken_over" and b.claim_owners("r1") == [HIGH]


def test_keeper_whose_claim_write_lost_its_answer_keeps_the_reminder(world):
    a, b = pair(world, ONE)
    real = a.store.link

    def lost_response(expected, notes):
        real(expected, notes)
        raise HelperError("uncertain", "helper did not finish delegation-link in 60s")

    a.restart(write_link=lost_response)
    assert a.act("ready", "r1")["status"] == "uncertain"
    assert a.row("r1")["status"] == "preparing" and a.claim_owners("r1") == [LOW]
    b.act("ready", "r1")
    b.tick()
    line_a, line_b = (claims(mac.notes("r1"))[0]["line"] for mac in (a, b))
    merge("r1", f"Window seat\n\n{line_a}\n\n{line_b}", a, b)
    a.restart(write_link=real)
    wait(world)
    for _ in range(3):
        b.tick()
        a.tick()
        sync(a, b, "r1")
    wait(world)
    a.tick()
    # The smaller id keeps it, though it was still linking; exactly one Mac runs.
    assert "released" not in a.row("r1") and a.state("r1") == "active"
    assert b.row("r1")["released"]["reason"] == "yielded" and b.state("r1") == "stopped"
    assert a.claim_owners("r1") == [LOW]


def test_a_line_left_by_a_closed_mac_does_not_strand_the_reminder(world):
    a, b = pair(world, ONE)
    a.act("ready", "r1")
    a.tick()
    a.d.stop(a.row("r1")["task_id"])
    line_a = claims(a.notes("r1"))[0]["line"]
    # A's Hermes is closed before its line comes off. B, with an old copy, delegates.
    b.act("ready", "r1")
    b.tick()
    line_b = claims(b.notes("r1"))[0]["line"]
    merge("r1", f"Window seat\n\n{line_a}\n\n{line_b}", a, b)
    b.tick()
    b.tick()
    # B let go to the smaller id, and took its own line off: it holds nothing.
    assert b.row("r1")["released"]["reason"] == "yielded" and b.claim_owners("r1") == [LOW]
    # A opens later: nothing of its own is live, so its line goes too.
    a.tick()
    sync(a, b, "r1")
    b.tick()
    sync(b, a, "r1")
    a.tick()
    for mac in (a, b):
        assert mac.notes("r1") == "Window seat"
        card = mac.card("r1")
        assert "elsewhere" not in card and card["capabilities"]["complete"]
    assert b.act("ready", "r1")["status"] == "ok" and b.claim_owners("r1") == [HIGH]


def test_keeper_that_cannot_remove_the_other_line_still_starts(world):
    a, b = pair(world, ONE)
    Links(a.home).mark_foreign()
    a.act("ready", "r1")
    b.act("ready", "r1")
    b.tick()
    line_a, line_b = (claims(mac.notes("r1"))[0]["line"] for mac in (a, b))
    merge("r1", f"Window seat\n\n{line_a}\n\n{line_b}", a, b)
    tries = []

    def broken(expected, notes):
        tries.append(notes)
        raise HelperError("bad_request", "Only claim lines may change")

    a.restart(write_link=broken)
    wait(world)
    for _ in range(3):
        a.tick()
    # A refused write is not hammered: one try, then a wait.
    assert a.admission.starts == 0 and len(tries) == 1
    a.tick()
    a.tick()
    # Still the keeper by a fresh read: it starts, and keeps trying the cleanup now and then.
    assert a.admission.starts == 1 and a.state("r1") == "active"
    world.clock.at += 61
    a.tick()
    assert len(tries) == 2
    b.tick()
    assert b.row("r1")["released"]["reason"] == "yielded"


def test_one_off_given_a_repeat_then_stopped_is_released_and_delegable(world):
    a = world("Studio", ONE, "local", LOW)
    a.act("activate")
    a.act("ready", "r1")
    a.tick()
    row = a.store.find("r1")
    row.update(rules=["daily"], due=DUE)
    a.store.touch(row)
    a.tick()
    assert a.row("r1")["guard"]["reason"] == "source_ineligible"
    assert a.d.stop(a.row("r1")["task_id"])["outcome"] == "stopped"
    a.tick()
    assert a.notes("r1") == "Window seat"
    assert a.occ("every", "r1")["status"] == "ok"
    assert a.row("r1", a.o)["scope"] == "every_occurrence" and a.claim_owners("r1") == [LOW]


def test_release_reads_nothing_under_the_lock_and_backs_off(world):
    rows = [reminder(f"r{n}", f"Task {n}", f"Notes {n}") for n in range(1, 7)]
    a = world("Studio", rows, "links", LOW)
    a.act("activate")
    for n in range(1, 7):
        a.act("ready", f"r{n}")
    a.tick()
    calls = []
    real = a.store.__class__.__call__

    def counting(op, **fields):
        calls.append(op)
        return real(a.store, op, **fields)

    a.restart(call=counting)
    for row in a.rows():
        a.d.stop(row["task_id"])
    # Stop, Delegate and Accept never read Reminders on release's account.
    assert calls == []
    with a.reads() as human:
        human.board()
    a.store.down = True
    for _ in range(3):
        calls.clear()
        a.act("tick")
        a.occ("tick")
        # One read of the lists per pass at most; none while it waits to try again.
        assert calls.count("read") == 0 and len(calls) <= 2
    a.store.down = False
    world.clock.at += 61
    released = []
    for _ in range(4):
        calls.clear()
        before = a.store.writes
        a.act("tick")
        a.occ("tick")
        released.append(a.store.writes - before)
        assert "read" not in calls and calls.count("read_many") <= 2
        with a.reads() as human:
            human.board()
    # A few per tick, not every stopped reminder at once.
    assert released == [3, 3, 0, 0]
    assert all(a.notes(f"r{n}") == f"Notes {n}" for n in range(1, 7))


def test_failed_take_over_leaves_the_other_macs_reminder_guarded(world):
    a, b = pair(world, [reminder("p1", "Plain task", "Some notes")])
    a.act("ready", "p1")
    a.tick()
    sync(a, b, "p1")

    def broken(expected, notes):
        raise HelperError("bad_request", "Only claim lines may change")

    b.restart(write_link=broken)
    assert b.act("take_over", "p1")["status"] == "bad_request"
    assert b.row("p1")["status"] == "preparing" and not b.row("p1").get("destination")
    card = b.card("p1")
    assert card["elsewhere"]["mac"] == "Studio" and not card["capabilities"]["complete"]
    out = b.human("complete", "p1")
    assert (out["status"], out["reason"]) == ("conflict", "other_mac")
    assert not b.snap("p1")["completed"]


@pytest.mark.parametrize("successor", ["not_yet", "prepared"])
def test_take_over_of_an_every_series_leaves_no_hold(world, successor):
    from reminders_kanban.workflow.reconciliation import snapshot

    a, b = pair(world, REPEATING)
    a.occ("every", "d1")
    a.tick()
    first = a.row("d1", a.o)
    a.worker.tasks[first["task_id"]] = "result"
    a.tick()
    a.occ("accept", occurrence_id=first["key"])
    if successor == "prepared":
        a.tick()
        a.tick()
    sync_all(a, b)
    assert b.occ("every", "d1", take_over=True)["status"] == "ok"
    sync_all(b, a)
    for _ in range(3):
        a.tick()
    rows = a.rows(service=a.o)
    assert rows[-1]["released"]["reason"] == "taken_over"
    assert all(r.get("series_state") != "needs_reconciliation" for r in rows)
    assert snapshot(a.o)["cases"] == [] and snapshot(a.o)["status"] == "ok"
    assert len(a.rows(service=a.o)) == len(rows)
    assert a.card("d1")["elsewhere"]["mac"] == "MacBook Air"


@pytest.mark.parametrize("modes", [("local", "local"), ("links", "links")])
def test_a_missing_claim_is_written_back(world, modes):
    a, b = pair(world, ONE, modes)
    a.act("ready", "r1")
    a.tick()
    line = claims(a.notes("r1"))[0]["line"]
    # The person deleted the line (or another Mac's late write wiped it).
    row = a.store.find("r1")
    row["notes"] = "Window seat"
    a.store.touch(row)
    a.tick()
    assert a.notes("r1") == f"Window seat\n\n{line}"
    a.tick()
    a.tick()
    kept = a.row("r1")
    assert kept["status"] == "active" and kept["guard"]["status"] == "active"
    assert a.state("r1") == "active" and a.worker.log == []
    sync(a, b, "r1")
    assert b.card("r1")["elsewhere"]["mac"] == "Studio"


def test_a_late_release_cannot_wipe_a_take_over(world):
    a, b = pair(world, ONE)
    a.act("ready", "r1")
    a.tick()
    sync(a, b, "r1")
    a.d.stop(a.row("r1")["task_id"])
    b.act("take_over", "r1")
    wait(world)
    b.tick()
    taken = b.notes("r1")
    a.tick()  # A releases against its own old copy,
    assert a.notes("r1") == "Window seat"
    sync(a, b, "r1")  # and that later write wins.
    b.tick()
    assert b.notes("r1") == taken and b.state("r1") == "active"
    sync(b, a, "r1")
    assert a.card("r1")["elsewhere"]["mac"] == "MacBook Air"
    assert a.act("ready", "r1")["tasks"][-1]["status"] == "stopped"


def test_a_copied_install_id_is_another_mac(world):
    a = world("Studio", READY, "local", LOW)
    b = world("MacBook Air", READY, "local", LOW)
    a.act("activate")
    a.tick()
    sync(a, b, "r1")
    card = b.card("r1")
    assert card["claim"] == "foreign" and card["elsewhere"]["mac"] == "Studio"
    b.act("activate")
    for _ in range(3):
        a.tick()
        b.tick()
    assert not b.worker.tasks and a.state("r1") == "active"
    assert a.row("r1")["status"] == "active"
    # Taking it over still works, and the two tell their claims apart.
    assert b.act("take_over", "r1")["status"] == "ok"
    sync(b, a, "r1")
    a.tick()
    assert a.row("r1")["released"]["mac"] == "MacBook Air"


def test_settle_flag_needs_an_open_reminder_and_lapses(world):
    a, b = pair(world, ONE + [reminder("r2", "Pay rent", "Two")])
    a.act("ready", "r1")
    a.tick()
    sync(a, b, "r1")
    b.store.find("r1")["completed"] = True
    # A finished reminder with the other Mac's line is no sign of two Macs at work.
    b.card("r1")
    b.tick()
    assert not Links(b.home).seen_foreign()
    b.store.find("r1")["completed"] = False
    b.card("r1")
    links = Links(b.home)
    assert links.seen_foreign()
    seen = links._foreign_seen_at()
    assert links.seen_foreign(seen + 29 * 24 * 3600)
    assert not links.seen_foreign(seen + 31 * 24 * 3600)


def test_take_over_gives_hermes_the_reminders_own_notes(world):
    a, b = pair(world, ONE, ("links", "links"))
    a.act("ready", "r1")
    sync(a, b, "r1")
    bodies = []
    create = b.worker.create
    b.worker.create = lambda key, title, body, **kw: bodies.append(body) or create(
        key, title, body, **kw)
    b.act("take_over", "r1")
    assert bodies and "Open in Hermes" not in bodies[0] and "studio" not in bodies[0]
    assert bodies[0].startswith("Window seat\n")


def test_other_mac_is_named_before_a_stale_snapshot(world):
    a, b = pair(world, [reminder("p1", "Plain task", "Some notes")])
    opened = b.snap("p1")
    a.act("ready", "p1")
    sync(a, b, "p1")
    # The edit form was open when the other Mac claimed it.
    with b.reads() as human:
        out = human.apply(Action(operation_id=str(uuid4()), action="edit", expected=opened,
                                 fields=dict(title="Edited")))
    assert (out["status"], out["reason"], out["mac"]) == ("conflict", "other_mac", "Studio")


def test_take_over_of_a_reminder_this_mac_finished_earlier(world):
    a, b = pair(world, ONE)
    b.act("ready", "r1")
    b.tick()
    b.worker.tasks[b.row("r1")["task_id"]] = "result"
    b.tick()
    b.act("accept", "r1")
    done = b.row("r1")
    assert done["status"] == "done"
    # Reopened in Reminders; the other Mac delegates it.
    row = b.store.find("r1")
    row["completed"] = False
    b.store.touch(row)
    b.tick()
    sync(b, a, "r1")
    a.act("ready", "r1")
    sync(a, b, "r1")
    assert b.card("r1")["elsewhere"]["mac"] == "Studio"
    answer = b.act("take_over", "r1")
    assert answer["status"] == "ok"
    fresh = b.row("r1")
    # A new task, with the finished one kept as history: not "ok" with nothing done.
    assert fresh["key"] != done["key"] and fresh["status"] == "ready" and len(b.rows("r1")) == 2
    assert b.claim_owners("r1") == [HIGH] and claims(b.notes("r1"))[0]["from"] == LOW[:8]


# Review round two.


def test_claims_are_released_with_no_board_open(world):
    rows = READY + [reminder("d1", "Water plants", "Balcony", repeats=True)]
    mini, air = pair(world, rows, ("links", "links"))

    def ticks(count):
        # The background ticker alone: nothing ever reads the board on this Mac.
        for _ in range(count):
            assert mini.act("tick")["status"] == "ok" and mini.occ("tick")["status"] == "ok"
            world.clock.at += 5

    ticks(2)
    mini.occ("ready", "d1")
    ticks(2)
    assert mini.claim_owners("r1") == [LOW] == mini.claim_owners("d1")
    mini.d.stop(mini.row("r1")["task_id"])
    row = mini.row("d1", mini.o)
    mini.worker.tasks[row["task_id"]] = "result"
    ticks(1)
    mini.occ("accept", occurrence_id=row["key"])
    ticks(3)
    assert mini.notes("r1") == "Window seat" and mini.notes("d1") == "Balcony"
    sync_all(mini, air)
    assert "elsewhere" not in air.card("r1") and "elsewhere" not in air.card("d1")
    # Quiet afterwards: the lists are not read again for a finished reminder for ten minutes.
    calls = []
    real = mini.store.__class__.__call__
    mini.restart(call=lambda op, **fields: calls.append(op) or real(mini.store, op, **fields))
    assert mini.act("tick")["status"] == "ok"
    assert calls == []


def test_a_claim_write_goes_to_the_op_that_takes_the_reminder(world):
    a = world("Studio", ONE, "local", LOW)
    a.act("activate")
    a.act("ready", "r1")
    a.tick()
    row = a.store.find("r1")
    row.update(rules=["daily"], due=DUE, notes="Window seat")
    a.store.touch(row)
    refused, real = [], a.store.link

    def one_off_only(expected, notes):
        if expected.get("rules"):
            refused.append(1)
            raise HelperError("conflict", "Source changed")  # What delegation-link answers.
        return real(expected, notes)

    a.restart(write_link=one_off_only, write_other=None)
    for _ in range(10):
        a.tick()
    # No writer for a repeating reminder here: never asked, not retried every tick.
    assert refused == []
    a.restart(write_link=one_off_only, write_other=real)
    a.tick()
    assert a.claim_owners("r1") == [LOW]


@pytest.mark.parametrize("history", ["question_then_running", "queued_for_an_hour"])
def test_the_earlier_claim_wins_whatever_state_its_work_is_in(world, history):
    a, b = pair(world, ONE, a_low=False)
    a.act("ready", "r1")
    if history == "question_then_running":
        a.tick()
        task = a.row("r1")["task_id"]
        a.worker.tasks[task] = "question"
        a.tick()
        a.worker.tasks[task] = "active"
        a.tick()
        world.clock.at += 10
    else:
        world.clock.at += 3600
    # B, the smaller id, claims from an old copy.
    b.act("ready", "r1")
    b.tick()
    line_a, line_b = (claims(mac.notes("r1"))[0]["line"] for mac in (a, b))
    merge("r1", f"Window seat\n\n{line_a}\n\n{line_b}", a, b)
    for _ in range(3):
        a.tick()
        sync(a, b, "r1")
        b.tick()
    assert "released" not in a.row("r1") and a.claim_owners("r1") == [HIGH]
    assert b.row("r1")["released"]["mac"] == "Studio"


def test_delegate_on_a_link_from_an_unknown_install_says_whose_it_is(world):
    old = ("Text\n\nOpen in Hermes: https://old-mini.tail.ts.net/reminders?"
           "owner=11111111-1111-4111-8111-111111111111"
           "&link=22222222-2222-4222-8222-222222222222&profile=default")
    a = world("Studio", [reminder("r1", "Old one", old)], "links", LOW)
    a.act("activate")
    answer = a.act("ready", "r1")
    assert (answer["status"], answer["reason"], answer["mac"]) == (
        "conflict", "other_mac", "old-mini")
    assert not a.worker.tasks and a.notes("r1") == old
    assert a.act("take_over", "r1")["status"] == "ok"


@pytest.mark.parametrize("choice", ["ready", "every"])
def test_repeating_take_over_on_a_mac_that_stopped_it_earlier(world, choice):
    a, b = pair(world, REPEATING, ("links", "links"))
    b.occ("ready", "d1")
    b.tick()
    stopped = b.row("d1", b.o)
    b.occ("stop", occurrence_id=stopped["key"])
    b.tick()
    assert not claims(b.notes("d1"))
    sync_all(b, a)
    assert a.occ("ready", "d1")["status"] == "ok"
    a.tick()
    sync_all(a, b)
    assert b.card("d1")["elsewhere"]["mac"] == "Studio"
    assert b.occ(choice, "d1", take_over=True)["status"] == "ok"
    rows = b.rows(service=b.o)
    assert len(rows) == 2 and rows[1]["rerun_of"] == stopped["key"]
    assert b.claim_owners("d1") == [HIGH]


def test_a_mac_takes_back_every_occurrence_after_its_this_occurrence_was_taken(world):
    a, b = pair(world, REPEATING, ("links", "links"))
    b.occ("ready", "d1")
    b.tick()
    sync_all(b, a)
    assert a.occ("ready", "d1", take_over=True)["status"] == "ok"
    sync_all(a, b)
    b.tick()
    b.tick()
    assert b.row("d1", b.o)["released"]["reason"] == "taken_over"
    assert b.occ("every", "d1", take_over=True)["status"] == "ok"
    assert b.rows(service=b.o)[-1]["scope"] == "every_occurrence"


def test_the_first_action_after_stop_does_not_bounce(world):
    a, _ = pair(world, ONE, ("links", "links"))
    a.act("ready", "r1")
    a.tick()
    a.d.stop(a.row("r1")["task_id"])
    board = a.snap("r1")  # What the board still holds: the claim line is in the notes.
    a.tick()
    assert claims(board["notes"]) and not claims(a.notes("r1"))

    def human(action, **fields):
        with a.reads() as person:
            return person.apply(Action(operation_id=str(uuid4()), action=action,
                                       expected=copy.deepcopy(board), fields=fields))

    assert human("progress", column="In progress")["status"] == "ok"
    assert human("edit", title="Book trains")["status"] == "ok"
    board = dict(board, title="Book trains")
    assert a.snap("r1")["title"] == "Book trains" and a.notes("r1") == "Window seat"
    # A change to the person's own text is still a conflict.
    a.store.find("r1")["title"] = "Book buses"
    assert human("complete")["status"] == "conflict"


def test_run_again_right_after_stop_takes_the_boards_older_snapshot(world):
    a, _ = pair(world, REPEATING, ("links", "links"))
    a.occ("ready", "d1")
    a.tick()
    row = a.row("d1", a.o)
    a.occ("stop", occurrence_id=row["key"])
    stale = a.snap("d1")
    a.tick()
    assert claims(stale["notes"]) and not claims(a.notes("d1"))
    answer = a._run(a.o, "rerun", occurrence_id=row["key"], expected=stale)
    assert answer["status"] == "ok" and answer["task"]["rerun_of"] == row["key"]
    # One-off: Delegate again with the older snapshot.
    b = world("Mini", ONE, "links", MID)
    b.act("activate")
    b.act("ready", "r1")
    b.tick()
    b.d.stop(b.row("r1")["task_id"])
    old = b.snap("r1")
    b.tick()
    assert b._run(b.d, "ready", expected=old)["status"] == "ok" and len(b.rows("r1")) == 2


def test_stale_board_take_over_and_delegate_answers(world):
    rows = ONE + [reminder("r2", "Pay rent", "Two")]
    a, b = pair(world, rows, ("links", "links"))
    # Take over on a card the other Mac has already let go of: an ordinary delegation.
    a.act("ready", "r1")
    a.tick()
    sync(a, b, "r1")
    stale = b.snap("r1")
    a.d.stop(a.row("r1")["task_id"])
    a.tick()
    sync(a, b, "r1")
    assert b._run(b.d, "take_over", expected=stale)["status"] == "ok"
    taken = claims(b.notes("r1"))
    assert [(c["owner"], c["from"]) for c in taken] == [(HIGH[:8], None)]
    # Delegate on a reminder the other Mac claimed since the board read it: told whose it is.
    unclaimed = b.snap("r2")
    a.act("ready", "r2")
    sync(a, b, "r2")
    answer = b._run(b.d, "ready", expected=unclaimed)
    assert (answer["status"], answer["reason"], answer["mac"]) == (
        "conflict", "other_mac", "Studio")
    # A real change is still refused as changed.
    b.store.find("r2")["title"] = "Pay the rent"
    assert b._run(b.d, "take_over", expected=unclaimed)["status"] == "attention"


# A person types onto the claim line (the link now sits inside other text).


def typed_onto(mac, rid, words=" thanks"):
    row = mac.store.find(rid)
    row["notes"] += words
    row["modified"] = "typed"


def test_words_typed_onto_a_running_tasks_line_are_kept_and_the_line_rewritten(world):
    a, b = pair(world, ONE, ("links", "links"))
    a.act("ready", "r1")
    a.tick()
    line = claims(a.notes("r1"))[0]["line"]
    typed_onto(a, "r1")
    a.tick()
    # The person's words stay, on a line of their own; the claim is a whole line again.
    assert a.notes("r1") == f"Window seat\n\nthanks\n\n{line}"
    writes = a.store.writes
    a.tick()
    assert a.store.writes == writes and a.claim_owners("r1") == [LOW]
    sync(a, b, "r1")
    assert b.card("r1")["elsewhere"]["mac"] == "Studio"


def test_words_typed_onto_the_line_never_strand_the_reminder(world):
    a, b = pair(world, ONE, ("links", "links"))
    a.act("ready", "r1")
    a.tick()
    a.d.stop(a.row("r1")["task_id"])
    typed_onto(a, "r1")
    sync(a, b, "r1")
    assert b.card("r1")["elsewhere"]["mac"] == "Studio"
    # A's stopped task lets go: only the link leaves the line.
    a.tick()
    assert a.notes("r1") == "Window seat\n\nthanks"
    sync(a, b, "r1")
    card = b.card("r1")
    assert "elsewhere" not in card and card["owner"] == "human"
    assert b.act("ready", "r1")["status"] == "ok" and b.claim_owners("r1") == [HIGH]


def test_take_over_of_a_line_the_person_typed_onto(world):
    a, b = pair(world, ONE, ("links", "links"))
    a.act("ready", "r1")
    a.tick()
    typed_onto(a, "r1", " call first")
    sync(a, b, "r1")
    # A is closed. B takes the reminder over: the person's words stay, A's link goes.
    assert b.act("take_over", "r1")["status"] == "ok"
    assert b.claim_owners("r1") == [HIGH]
    assert b.notes("r1").startswith("Window seat\n\ncall first\n\nOpen in Hermes: ")
    sync(b, a, "r1")
    a.tick()
    assert a.row("r1")["released"]["reason"] == "taken_over"


def test_an_old_link_of_this_macs_is_never_another_macs(world):
    a = world("Studio", ONE, "links", LOW)
    a.act("activate")
    # A link from before links named their Mac, whose task record is gone; this Mac's address
    # starts with a different word than its name.
    old = f"https://nickys-mac.tail.ts.net/reminders?owner={LOW}&link={MID}&profile=default"
    merge("r1", f"Window seat\n\nOpen in Hermes: {old}", a)
    card = a.card("r1")
    assert card.get("claim") != "foreign" and "elsewhere" not in card
