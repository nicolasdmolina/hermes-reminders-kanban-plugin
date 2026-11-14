import copy
import json
import time
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from reminders_kanban.api import router
from reminders_kanban.api.human import Action, Human, service
from reminders_kanban.reminders import helper


def action(kind, expected=None, **fields):
    return Action(operation_id=str(uuid4()), action=kind, expected=expected, fields=fields)


@pytest.fixture
def world(tmp_path, monkeypatch):
    rows = [
        {
            "id": "one",
            "externalId": "one",
            "calendarId": "list",
            "title": "Task",
            "notes": None,
            "url": None,
            "due": None,
            "rules": [],
            "completed": False,
        }
    ]
    calls = []

    def call(op, **kw):
        calls.append(op)
        if op == "lists":
            return [{"id": "list", "title": "Test", "writable": True}]
        if op in {"read_many", "completion-read"}:
            return copy.deepcopy(rows)
        if op == "read":
            return copy.deepcopy(rows[0])
        if op == "complete-occurrence":
            rows[0]["completed"] = True
        if op == "human-edit":
            rows[0].update(kw["patch"])
            return copy.deepcopy(rows[0])
        if op == "human-create":
            return {**rows[0], **kw["fields"]}

    monkeypatch.setattr(helper, "run", call)
    human = Human(tmp_path, call=call)
    with human.store.locked() as db:
        state = human.store.read(db)
        state["selected_list_ids"] = ["list"]
        state["selection_saved"] = True
        human.store.save(db, state)
    return human, rows, calls


def test_progress_restart_external_edits_and_gate(world):
    human, rows, calls = world
    before = human.board()["cards"][0]
    assert human.apply(action("progress", rows[0], column="In progress"))["status"] == "ok"
    assert Human(human.home, call=human.call).board()["cards"][0]["column"] == "In progress"
    draft = action("edit", copy.deepcopy(rows[0]), title="My draft", rules=[])
    assert human.apply(draft)["status"] == "gated_field"
    rows[0]["title"] = "Phone edit"
    result = human.apply(draft)
    assert result["status"] == "conflict"
    assert result["draft"]["fields"]["title"] == "My draft"
    current = human.board()["cards"][0]
    assert current["id"] == before["id"] and current["source"]["title"] == "Phone edit"
    assert not any(op in calls for op in ["human-fixture", "human-create", "complete-occurrence"])


def test_complete_replay_and_human_never_delegates(world):
    human, rows, calls = world
    request = action("complete", copy.deepcopy(rows[0]))
    assert human.apply(request)["status"] == "ok"
    assert Human(human.home, call=human.call).apply(request)["status"] == "ok"
    assert calls.count("complete-occurrence") == 1
    with human.store.locked() as db:
        assert all(
            not __import__("json").loads(r[0])["every"]
            for r in db.execute("SELECT state FROM series")
        )


def test_uncertain_create_never_retried_even_new_key(world):
    human, rows, calls = world
    real = human.call

    def interrupted(op, **kw):
        if op == "human-create":
            calls.append(op)
            raise helper.HelperError("uncertain", "response lost")
        return real(op, **kw)

    human.call = interrupted
    request = action("create", title="New", calendarId="list")
    assert human.apply(request)["status"] == "uncertain"
    reopened = Human(human.home, call=interrupted)
    assert reopened.apply(request)["status"] == "uncertain"
    assert (
        reopened.apply(action("create", title="Again", calendarId="list"))["status"] == "uncertain"
    )
    assert calls.count("human-create") == 1


def test_routes_labels_and_denied(world):
    human, rows, calls = world
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[service] = lambda: human
    client = TestClient(app)
    result = client.post(
        "/human/actions", json=action("labels", agent="[Bot]", ready="[Go]").model_dump()
    )
    assert result.json()["status"] == "ok"
    rows[0]["title"] = "[Go] Task"
    board = client.get("/human/board").json()
    assert board["cards"][0]["owner"] == "agent"
    assert not board["cards"][0]["eligible"]
    assert not board["pickup_enabled"]
    assert (
        client.post("/human/actions", json={"action": "edit", "proofToken": "bad"}).status_code
        == 422
    )
    assert human.apply(action("complete", rows[0]))["reason"] == "agent_owned"

    def denied(*args, **kwargs):
        raise helper.HelperError("access_denied", "denied")

    human.call = denied
    result = human.apply(action("progress", rows[0], column="In progress"))
    assert result["status"] == "access_denied"


def test_interrupted_completion_reconciles_read_only(world):
    human, rows, calls = world
    original = human.call

    def crash(op, **kw):
        result = original(op, **kw)
        if op == "complete-occurrence":
            raise SystemExit("process died after native save")
        return result

    human.call = crash
    request = action("complete", copy.deepcopy(rows[0]))
    with pytest.raises(SystemExit):
        human.apply(request)
    reopened = Human(human.home, call=original)
    assert reopened.apply(request)["status"] == "ok"
    assert calls.count("complete-occurrence") == 1


def test_recurring_successor_and_new_request_cannot_complete_old_snapshot(world):
    human, rows, calls = world
    rows[0]["due"] = {"day": 1}
    rows[0]["rules"] = [{"interval": 1}]
    original = human.call

    def recurring(op, **kw):
        if op == "complete-occurrence":
            calls.append(op)
            rows.append(
                {
                    **copy.deepcopy(rows[0]),
                    "id": "history",
                    "externalId": "history",
                    "completed": True,
                }
            )
            rows[0]["due"] = {"day": 2}
            return None
        return original(op, **kw)

    human.call = recurring
    expected = copy.deepcopy(rows[0])
    assert human.apply(action("progress", expected, column="In progress"))["status"] == "ok"
    request = action("complete", expected)
    completed = human.apply(request)
    assert completed["status"] == "ok"
    assert completed["completion"]["successor"]["due"] == {"day": 2}
    assert human.apply(request) == completed
    assert human.apply(action("complete", expected))["status"] == "conflict"
    assert calls.count("complete-occurrence") == 1
    assert human.board()["cards"][0]["column"] == "To do"


def test_ordinary_completion_ignores_matching_completed_history(world):
    human, rows, calls = world
    rows.append({**rows[0], "id": "old", "externalId": "old", "completed": True})
    request = action("complete", copy.deepcopy(rows[0]))
    result = human.apply(request)
    assert result["status"] == "ok"
    assert result["completion"]["history_id"] == "one"
    assert human.apply(request) == result
    assert human.apply(action("labels", agent="[Bot]", ready="[Go]"))["status"] == "ok"


def test_native_completion_conflict_keeps_draft_and_allows_fresh_action(world):
    human, rows, calls = world
    original = human.call

    def phone_edit(op, **kw):
        if op == "complete-occurrence":
            rows[0]["title"] = "Changed on phone"
            raise helper.HelperError("conflict", "Source changed", copy.deepcopy(rows[0]))
        return original(op, **kw)

    human.call = phone_edit
    request = action("complete", copy.deepcopy(rows[0]))
    result = human.apply(request)
    assert result["status"] == "conflict"
    assert result["draft"] == request.model_dump()
    assert result["current"]["title"] == "Changed on phone"
    assert not rows[0]["completed"]
    assert (
        human.apply(action("progress", copy.deepcopy(rows[0]), column="In progress"))["status"]
        == "ok"
    )


def test_proved_edits_and_unproved_fields(world):
    human, rows, calls = world
    for fields in (
        {"title": "Updated"},
        {"notes": "Original"},
        {"notes": "Original\nAppended"},
        {"priority": 1},
        {"due": {"calendar": "gregorian", "year": 2030, "month": 3, "day": 10}},
        {"due": None},
    ):
        request = action("edit", copy.deepcopy(rows[0]), **fields)
        result = human.apply(request)
        assert result["status"] == "ok"
        assert all(result["current"][k] == v for k, v in fields.items())
        assert human.apply(request) == result
    assert calls.count("human-edit") == 6
    for fields in (
        {"notes": "Replacement"},
        {"notes": None},
    ):
        request = action("edit", copy.deepcopy(rows[0]), **fields)
        result = human.apply(request)
        assert result["status"] == "gated_field"
        assert result["draft"] == request.model_dump()
    assert calls.count("human-edit") == 6
    capabilities = human.board()["cards"][0]["capabilities"]
    assert capabilities["edit"]
    assert capabilities["edit_fields"] == ["title", "notes", "priority", "calendarId", "due"]
    assert capabilities["notes_mode"] == "append"


def test_refused_move_is_durable_and_does_not_block_other_edits(world):
    human, rows, calls = world
    original = human.call

    def refuse(op, **kw):
        if op == "human-edit":
            calls.append(op)
            raise helper.HelperError("move_refused", "Move in Reminders", copy.deepcopy(rows[0]))
        return original(op, **kw)

    human.call = refuse
    request = action("edit", copy.deepcopy(rows[0]), calendarId="list")
    result = human.apply(request)
    assert result["status"] == "move_refused"
    assert result["current"] == rows[0]
    assert result["draft"] == request.model_dump()
    assert result["reason"] == "move_in_reminders"
    assert human.apply(request) == result
    assert calls.count("human-edit") == 1
    human.call = original
    result = human.apply(action("edit", copy.deepcopy(rows[0]), title="Still editable"))
    assert result["status"] == "ok"


def test_move_cannot_partially_apply_other_edits(world):
    human, rows, calls = world
    result = human.apply(action("edit", copy.deepcopy(rows[0]), calendarId="list", title="Mixed"))
    assert result["status"] == "bad_request"
    assert result["reason"] == "move_separately"
    assert "human-edit" not in calls


@pytest.mark.parametrize("column", ["To do", "In progress"])
@pytest.mark.parametrize("crash", [False, True])
def test_reopen_preserves_and_reconciles_without_second_save(world, column, crash):
    human, rows, calls = world
    rows[0].update(completedAt=None, priority=5, alarms=[{"x": 1}])
    assert human.apply(action("complete", copy.deepcopy(rows[0])))["status"] == "ok"
    rows[0]["completedAt"] = "yesterday"
    original = human.call

    def reopen(op, **kw):
        if op == "human-reopen":
            calls.append(op)
            rows[0].update(completed=False, completedAt=None)
            if crash:
                raise SystemExit()
            return copy.deepcopy(rows[0])
        return original(op, **kw)

    human.call = reopen
    request = action("reopen", copy.deepcopy(rows[0]), column=column)
    if crash:
        with pytest.raises(SystemExit):
            human.apply(request)
    else:
        assert human.apply(request)["status"] == "ok"
    restarted = Human(human.home, call=reopen)
    result = restarted.apply(request)
    assert result["status"] == "ok"
    assert result["column"] == column
    assert result["current"]["alarms"] == [{"x": 1}]
    assert restarted.board()["cards"][0]["column"] == column
    assert restarted.apply(request) == result
    assert calls.count("human-reopen") == 1


@pytest.mark.parametrize("kind", ["recurring", "label", "link", "record"])
def test_reopen_refuses_recurring_and_delegated(world, kind):
    import sqlite3

    human, rows, calls = world
    rows[0]["completed"] = True
    if kind == "recurring":
        rows[0]["rules"] = [{"interval": 1}]
    elif kind == "label":
        rows[0]["title"] = "[Agent] Done"
    elif kind == "link":
        rows[0]["notes"] = "Open in Hermes: https://example.invalid/task"
    else:
        with sqlite3.connect(human.home / "reminders-kanban/delegation.sqlite3") as db:
            db.execute("CREATE TABLE delegated (source TEXT PRIMARY KEY, state TEXT)")
            db.execute("INSERT INTO delegated VALUES ('one', '{}')")
    result = human.apply(action("reopen", copy.deepcopy(rows[0]), column="To do"))
    assert result["status"] == (
        "reopen_recurring_unsupported" if kind == "recurring" else "agent_workflow_required"
    )
    assert not human.board()["cards"][0]["capabilities"]["reopen"]
    assert "human-reopen" not in calls


def test_reopen_uncertainty_blocks_new_writes_and_changed_source(world):
    human, rows, calls = world
    assert human.apply(action("complete", copy.deepcopy(rows[0])))["status"] == "ok"
    original = human.call

    def lost(op, **kw):
        if op == "human-reopen":
            calls.append(op)
            raise helper.HelperError("uncertain", "lost")
        return original(op, **kw)

    human.call = lost
    request = action("reopen", copy.deepcopy(rows[0]), column="To do")
    assert human.apply(request)["status"] == "uncertain"
    assert human.apply(request)["status"] == "uncertain"
    assert human.apply(action("reopen", rows[0], column="To do"))["status"] == "uncertain"
    rows[0].update(completed=False, title="Phone edit")
    assert human.apply(request)["status"] == "uncertain"
    assert calls.count("human-reopen") == 1


def test_reopen_conflicts_and_invalid_destination(world):
    human, rows, calls = world
    rows[0]["completed"] = True
    stale = copy.deepcopy(rows[0])
    rows[0]["notes"] = "changed"
    assert human.apply(action("reopen", stale, column="To do"))["status"] == "conflict"
    assert human.apply(action("reopen", rows[0], column="Done"))["status"] == "bad_request"
    assert "human-reopen" not in calls


def test_reopen_cannot_infer_one_off_from_empty_history_rules(world):
    import json

    human, rows, calls = world
    rows[0]["completed"] = True
    assert human.apply(action("reopen", rows[0], column="To do"))[
        "status"
    ] == "reopen_origin_unverified"
    with human.store.locked() as db:
        db.execute("INSERT INTO series VALUES ('s', 'task', '{}')")
        db.execute(
            "INSERT INTO occurrences (id, series, state, done) VALUES (?, ?, ?, ?)",
            ("history", "s", json.dumps({
                "expected": {**rows[0], "rules": [{"interval": 1}]},
                "outcome": {"status": "completed", "history_id": "one"},
            }), 1),
        )
        db.commit()
    assert human.apply(action("reopen", rows[0], column="To do"))[
        "status"
    ] == "reopen_recurring_unsupported"
    assert "human-reopen" not in calls


def test_due_timezone_gate_preserves_draft_and_never_writes(world):
    human, rows, calls = world
    for start, target, allowed in (
        (None, None, True),
        ({"timeZone": None}, None, True),
        ({"timeZone": "America/New_York"}, None, True),
        ({"timeZone": None}, {"timeZone": "America/New_York"}, False),
        ({"timeZone": "America/New_York"}, {"timeZone": "Europe/London"}, False),
        ({"timeZone": "America/New_York"}, {"timeZone": "America/New_York"}, True),
    ):
        rows[0]["start"] = start
        request = action("edit", copy.deepcopy(rows[0]), due=target)
        count = calls.count("human-edit")
        result = human.apply(request)
        assert result["status"] == ("ok" if allowed else "gated_field")
        assert result["draft"] == request.model_dump()
        assert calls.count("human-edit") == count + int(allowed)
        if not allowed:
            assert result["reason"] == "due_start_timezone"
        modes = human.board()["cards"][0]["capabilities"]["due_modes"]
        assert modes["clear"] is True
        assert modes["all_day"] == (not (start or {}).get("timeZone"))
        assert modes["timed"] == (start is None or bool(start.get("timeZone")))


@pytest.mark.parametrize("start", [None, {"timeZone": None}, {"timeZone": "America/New_York"}])
def test_recurring_due_clear_refused_before_native_write(world, start):
    human, rows, calls = world
    rows[0]["rules"] = [{"interval": 1}]
    rows[0]["start"] = start
    request = action("edit", copy.deepcopy(rows[0]), due=None)
    result = human.apply(request)
    assert result["status"] == "gated_field"
    assert result["reason"] == "due_recurring"
    assert result["draft"] == request.model_dump()
    assert "human-edit" not in calls
    modes = human.board()["cards"][0]["capabilities"]["due_modes"]
    assert not modes["clear"]
    assert modes["clear_reason"] == "Repeating reminders need a date"


def lose(human, calls, op_name, then=None):
    """Makes `op_name` raise as an unanswered helper would; `then` runs first (it saved)."""
    real = human.call

    def lost(op, **kw):
        if op == op_name:
            calls.append(op)
            if then:
                then(kw)
            raise helper.HelperError("uncertain", "no answer", request="/tmp/rk-request.json")
        return real(op, **kw)

    human.call = lost


def test_unanswered_edit_settles_from_a_fresh_read_once_its_helper_is_gone(world):
    human, rows, calls = world
    alive = {"value": True}
    human.running = lambda request: alive["value"]
    human.grace = 0
    lose(human, calls, "human-edit")
    request = action("edit", copy.deepcopy(rows[0]), title="Mine")
    assert human.apply(request)["status"] == "uncertain"
    # While that helper could still save: blocked, as before, under any key.
    assert human.apply(request)["status"] == "uncertain"
    assert human.apply(action("create", title="Other", calendarId="list"))["status"] == "uncertain"
    alive["value"] = False
    # Gone, and Reminders is unchanged: it did not save. Recorded, so a replay answers the same.
    assert human.apply(request)["status"] == "not_saved"
    assert human.apply(request)["status"] == "not_saved"
    assert calls.count("human-edit") == 1
    # The board is free again.
    assert human.apply(action("progress", rows[0], column="In progress"))["status"] == "ok"


def test_unanswered_edit_that_landed_is_confirmed_and_grace_holds_it_first(world):
    human, rows, calls = world
    human.running = lambda request: False
    lose(human, calls, "human-edit", then=lambda kw: rows[0].update(kw["patch"]))
    request = action("edit", copy.deepcopy(rows[0]), title="Mine")
    assert human.apply(request)["status"] == "uncertain"
    # Inside the grace period nothing is concluded, even with no helper in sight.
    assert human.apply(request)["status"] == "uncertain"
    human.grace = 0
    result = human.apply(request)
    assert result["status"] == "ok" and result["current"]["title"] == "Mine"
    assert calls.count("human-edit") == 1


def test_unanswered_edit_over_someone_elses_change_is_a_conflict(world):
    human, rows, calls = world
    human.running = lambda request: False
    human.grace = 0
    lose(human, calls, "human-edit")
    request = action("edit", copy.deepcopy(rows[0]), title="Mine")
    assert human.apply(request)["status"] == "uncertain"
    rows[0]["title"] = "Phone edit"
    assert human.apply(request)["status"] == "conflict"


def test_unanswered_create_settles_and_a_new_write_behind_it_goes_through(world):
    human, rows, calls = world
    human.running = lambda request: False
    human.grace = 0
    lose(human, calls, "human-create")
    lost = action("create", title="New", calendarId="list")
    assert human.apply(lost)["status"] == "uncertain"
    # Nothing by that title was made: a different write settles the old one first, then saves.
    assert human.apply(action("progress", rows[0], column="In progress"))["status"] == "ok"
    assert human.apply(lost)["status"] == "not_saved"

    landed = action("create", title="Landed", calendarId="list")
    made = {**rows[0], "id": "two", "title": "Landed", "created": "2999-01-01T00:00:00Z"}
    lose(human, calls, "human-create", then=lambda kw: rows.append(made))
    assert human.apply(landed)["status"] == "uncertain"
    result = human.apply(landed)
    assert result["status"] == "ok" and result["current"]["id"] == "two"
    assert calls.count("human-create") == 2


def test_a_reminder_older_than_the_lost_create_is_not_mistaken_for_it(world):
    human, rows, calls = world
    human.running = lambda request: False
    human.grace = 0
    rows.append({**rows[0], "id": "old", "title": "Same name", "created": "2001-01-01T00:00:00Z"})
    lose(human, calls, "human-create")
    request = action("create", title="Same name", calendarId="list")
    assert human.apply(request)["status"] == "uncertain"
    assert human.apply(request)["status"] == "not_saved"


def test_unsure_completion_still_answers_uncertain_not_a_crash(world):
    human, rows, calls = world
    real = human.call

    def never_completes(op, **kw):
        if op == "complete-occurrence":
            calls.append(op)
            return None
        return real(op, **kw)

    human.call = never_completes
    assert human.apply(action("complete", copy.deepcopy(rows[0])))["status"] == "uncertain"


def test_a_saved_due_date_edit_is_confirmed_despite_the_fuller_stored_shape(world):
    human, rows, calls = world
    human.running = lambda request: False
    human.grace = 0
    due = {"calendar": "gregorian", "year": 2030, "month": 11, "day": 2}
    stored = {**due, "hour": None, "minute": None, "second": None, "timeZone": None,
              "isLeapMonth": False}
    lose(human, calls, "human-edit", then=lambda kw: rows[0].update(due=stored))
    request = action("edit", copy.deepcopy(rows[0]), due=due)
    assert human.apply(request)["status"] == "uncertain"
    assert human.apply(request)["status"] == "ok"


def test_grace_counts_from_when_the_helper_was_first_seen_gone(world):
    human, rows, calls = world
    alive = {"value": True}
    human.running = lambda request: alive["value"]
    lose(human, calls, "human-edit")
    request = action("edit", copy.deepcopy(rows[0]), title="Mine")
    assert human.apply(request)["status"] == "uncertain"
    with human.store.locked() as db:
        # The write failed long ago, but its helper only just went away.
        db.execute("UPDATE human_pending SET failed=failed-3600, at=at-3600")
        db.commit()
    alive["value"] = False
    assert human.apply(request)["status"] == "uncertain"
    human.grace = 0
    assert human.apply(request)["status"] == "not_saved"


def test_a_pending_table_from_before_the_gone_column_keeps_working(world):
    human, rows, calls = world
    with human.store.locked() as db:
        db.executescript(
            "DROP TABLE human_pending;"
            "CREATE TABLE human_pending (id TEXT PRIMARY KEY, request TEXT, at REAL, failed REAL);"
        )
    upgraded = Human(human.home, call=human.call, running=lambda request: False)
    upgraded.grace = 0
    lose(upgraded, calls, "human-edit")
    request = action("edit", copy.deepcopy(rows[0]), title="Mine")
    assert upgraded.apply(request)["status"] == "uncertain"
    assert upgraded.apply(request)["status"] == "not_saved"


def test_a_lost_mark_done_settles_whether_or_not_it_landed(world):
    human, rows, calls = world
    human.running = lambda request: False
    human.grace = 0
    real = human.call

    # The helper never completed it: the reminder is exactly as it was.
    human.call = lambda op, **kw: None if op == "complete-occurrence" else real(op, **kw)
    request = action("complete", copy.deepcopy(rows[0]))
    assert human.apply(request)["status"] == "uncertain"
    assert human.apply(request)["status"] == "not_saved"
    assert human.apply(action("progress", rows[0], column="In progress"))["status"] == "ok"

    # The read before the write timed out: nothing was started, and the board is not stuck.
    def no_read(op, **kw):
        if op == "completion-read":
            raise helper.HelperError("uncertain", "no answer", request="/tmp/rk-request.json")
        return real(op, **kw)

    human.call = no_read
    request = action("complete", copy.deepcopy(rows[0]))
    assert human.apply(request)["status"] == "uncertain"
    human.call = real
    assert human.apply(request)["status"] == "not_saved"
    assert human.apply(action("complete", copy.deepcopy(rows[0])))["status"] == "ok"


def test_a_lost_reopen_settles_whether_or_not_it_landed(world):
    human, rows, calls = world
    assert human.apply(action("complete", copy.deepcopy(rows[0])))["status"] == "ok"
    human.running = lambda request: False
    human.grace = 0
    lose(human, calls, "human-reopen")
    request = action("reopen", copy.deepcopy(rows[0]), column="To do")
    assert human.apply(request)["status"] == "uncertain"
    assert human.apply(request)["status"] == "not_saved"

    lose(human, calls, "human-reopen", then=lambda kw: rows[0].update(completed=False))
    request = action("reopen", copy.deepcopy(rows[0]), column="In progress")
    assert human.apply(request)["status"] == "uncertain"
    result = human.apply(request)
    assert result["status"] == "ok" and result["column"] == "In progress"
    assert calls.count("human-reopen") == 2


@pytest.mark.parametrize("repeating", [False, True])
def test_moving_the_due_date_keeps_a_reminder_in_progress(world, repeating):
    human, rows, calls = world
    if repeating:
        rows[0]["rules"] = [{"interval": 1}]
        rows[0]["due"] = {"calendar": "gregorian", "year": 2030, "month": 3, "day": 1}
    assert human.apply(action("progress", copy.deepcopy(rows[0]), column="In progress"))[
        "status"
    ] == "ok"
    due = {"calendar": "gregorian", "year": 2030, "month": 3, "day": 10}
    assert human.apply(action("edit", copy.deepcopy(rows[0]), due=due))["status"] == "ok"
    assert human.board()["cards"][0]["column"] == "In progress"
    # A date changed in Apple Reminders: a one-off stays put, a repeating one starts over.
    rows[0]["due"] = {"calendar": "gregorian", "year": 2030, "month": 4, "day": 1}
    assert human.board()["cards"][0]["column"] == ("To do" if repeating else "In progress")
    if repeating:
        # Rolled progress is forgotten: removing the repeat later doesn't bring In progress back.
        rows[0]["rules"] = []
        assert human.board()["cards"][0]["column"] == "To do"


def test_progress_saved_before_repeats_were_recorded_keeps_the_old_rule():
    old = {"column": "In progress", "due": {"day": 1}}
    assert Human.kept_column(old, {"due": {"day": 1}, "rules": []}) == "In progress"
    assert Human.kept_column(old, {"due": {"day": 2}, "rules": []}) == "To do"
    assert Human.kept_column(None, {"due": None}) == "To do"


def test_a_one_off_given_a_repeat_later_follows_the_repeating_rule(world):
    human, rows, calls = world
    rows[0]["due"] = {"calendar": "gregorian", "year": 2030, "month": 3, "day": 1}
    assert human.apply(action("progress", copy.deepcopy(rows[0]), column="In progress"))[
        "status"
    ] == "ok"
    rows[0]["rules"] = [{"interval": 1}]
    assert human.board()["cards"][0]["column"] == "In progress"
    rows[0]["due"] = {"calendar": "gregorian", "year": 2030, "month": 3, "day": 2}
    assert human.board()["cards"][0]["column"] == "To do"
    rows[0]["rules"] = []
    assert human.board()["cards"][0]["column"] == "To do"


def test_a_due_edit_that_settles_later_keeps_in_progress(world):
    human, rows, calls = world
    human.running = lambda request: False
    human.grace = 0
    rows[0]["rules"] = [{"interval": 1}]
    rows[0]["due"] = {"calendar": "gregorian", "year": 2030, "month": 3, "day": 1}
    assert human.apply(action("progress", copy.deepcopy(rows[0]), column="In progress"))[
        "status"
    ] == "ok"
    due = {"calendar": "gregorian", "year": 2030, "month": 3, "day": 10}
    lose(human, calls, "human-edit", then=lambda kw: rows[0].update(due=due))
    request = action("edit", copy.deepcopy(rows[0]), due=due)
    assert human.apply(request)["status"] == "uncertain"
    assert human.apply(request)["status"] == "ok"
    assert human.board()["cards"][0]["column"] == "In progress"


def test_an_undated_one_off_given_a_repeat_and_a_date_stays_in_progress_until_it_rolls(world):
    human, rows, calls = world
    assert human.apply(action("progress", copy.deepcopy(rows[0]), column="In progress"))[
        "status"
    ] == "ok"
    rows[0].update(rules=[{"interval": 1}],
                   due={"calendar": "gregorian", "year": 2030, "month": 3, "day": 1})
    assert human.board()["cards"][0]["column"] == "In progress"
    rows[0]["due"] = {"calendar": "gregorian", "year": 2030, "month": 3, "day": 2}
    assert human.board()["cards"][0]["column"] == "To do"


def test_cards_say_when_their_progress_was_last_set(world):
    human, rows, calls = world
    assert human.board()["cards"][0]["progress_at"] is None
    before = time.time()
    assert human.apply(action("progress", copy.deepcopy(rows[0]), column="In progress"))[
        "status"
    ] == "ok"
    assert human.board()["cards"][0]["progress_at"] >= before


def test_reopen_checks_read_the_completion_records_once_per_board(world):
    human, rows, calls = world
    assert human.apply(action("complete", copy.deepcopy(rows[0])))["status"] == "ok"
    with human.store.locked() as db:
        history = Human.reopen_history(db)
        assert list(history) == ["one"]
        expected, status = history["one"][0]
        assert status == "completed" and expected["id"] == "one"
        done = {**rows[0], "completed": True}
        assert Human.reopen_origin(db, done, history) == Human.reopen_origin(db, done) is None
        other = {**done, "id": "other"}
        assert Human.reopen_origin(db, other, history) == "reopen_origin_unverified"
    assert human.board()["cards"][0]["capabilities"]["reopen"] is True


def test_a_completed_occurrence_of_a_repeating_reminder_still_counts_as_repeating(world):
    human, rows, calls = world
    rows[0]["rules"] = [{"interval": 1}]
    rows[0]["due"] = {"calendar": "gregorian", "year": 2030, "month": 3, "day": 1}
    with human.store.locked() as db:
        # What a Mark done on that occurrence leaves behind: its completed copy, without a repeat.
        db.execute("INSERT INTO series VALUES ('s', 'human/o', '{}')")
        db.execute(
            "INSERT INTO occurrences VALUES ('o', 's', ?, 1)",
            (json.dumps({"expected": rows[0],
                         "outcome": {"status": "completed", "history_id": "copy"}}),),
        )
        db.commit()
    rows.append({**rows[0], "id": "copy", "externalId": "copy", "rules": [], "completed": True})
    cards = {c["source"]["id"]: c for c in human.board()["cards"]}
    assert cards["copy"]["recurring"] is True
    assert cards["copy"]["capabilities"]["reopen"] is False


@pytest.mark.parametrize("title", ["[Agent] Mine", "  [Agent] Mine"])
def test_an_edit_cannot_turn_a_reminder_into_an_agent_task(world, title):
    human, rows, calls = world
    result = human.apply(action("edit", copy.deepcopy(rows[0]), title=title))
    assert result["status"] == "bad_request" and result["reason"] == "human_title_required"
    assert "human-edit" not in calls
