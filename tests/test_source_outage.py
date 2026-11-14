"""Outages preserve native state and queue authority; source changes still win."""

import copy

import pytest
from test_delegation import ready as ready_one
from test_delegation import setup as one_setup  # noqa: F401
from test_occurrence import ready as ready_occurrence
from test_occurrence import setup as occurrence_setup  # noqa: F401

from reminders_kanban.reminders.helper import HelperError
from reminders_kanban.workflow.reconciliation import snapshot


@pytest.fixture(params=["one_setup", "occurrence_setup"])
def workflow(request):
    setup = request.getfixturevalue(request.param)
    return setup, ready_one if request.param == "one_setup" else ready_occurrence


def project(service, admission):
    with service.store.connection() as db:
        row = service._rows(db)[0]
    return service.task_view(row, admission.conn)


@pytest.mark.parametrize("host_state", ["active", "question", "result"])
def test_outage_preserves_attempt_and_review_then_recovers(workflow, host_state):
    setup, ready = workflow
    service, source, owner, admission = setup
    ready(setup)
    task = next(iter(owner.tasks))
    owner.tasks[task] = host_state
    source.denied = True
    for _ in range(2):
        service.apply("tick")
        view = project(service, admission)
        assert view["wait_reason"] == "source_unavailable"
        assert view["waiting"] is (host_state != "result")
        assert view["required_action"] == ("review" if host_state == "result" else None)
        assert owner.tasks[task] == host_state
    source.denied = False
    service.apply("tick")
    view = project(service, admission)
    assert not view["waiting"] and view["wait_reason"] is None
    assert view["state"] == host_state
    assert admission.starts == 1


@pytest.mark.parametrize("change", [None, "completed", "notes", "identity", "deleted"])
def test_queued_outage_recovery_checks_every_source_before_automatic_start(workflow, change):
    setup, ready = workflow
    service, source, owner, admission = setup
    if ready is ready_one:
        service.apply("activate")
    admit = admission.admit
    admission.admit = lambda **_: {}
    # Each source has its own identity and link. Neither is started before the outage.
    original = copy.deepcopy(source.rows[0])
    source.rows.append(
        dict(
            original,
            id="b",
            externalId="ext-b",
            title="Different task",
            notes="Different instructions",
            url="https://different.example",
        )
    )

    def link(expected, notes):
        row = next(r for r in source.rows if r["id"] == expected["id"])
        row["notes"] = notes
        return copy.deepcopy(row)

    service.write_link = link
    for source_row in list(source.rows):
        service.apply("ready", expected=copy.deepcopy(source_row))
    source.denied = True
    admission.admit = admit
    service.apply("tick")
    assert snapshot(service)["freshness"] == "unavailable"
    assert admission.starts == 0
    source.denied = False
    if change == "deleted":
        source.rows.pop(0)
    elif change == "identity":
        source.rows[0]["externalId"] = "replaced"
    elif change == "notes":
        source.rows[0]["notes"] += "\nEdited while offline"
    elif change:
        source.rows[0][change] = True
    admission.admit = admit
    service.apply("tick")
    assert admission.starts == (2 if change is None else 1)
    assert owner.tasks["1"] == "active"
    if change:
        assert owner.tasks["0"] in {"paused", "stopped"}
    service.apply("tick")
    assert admission.starts == (2 if change is None else 1)


def test_partial_read_does_not_clear_wait_or_a_real_hold(workflow):
    setup, ready = workflow
    service, source, owner, admission = setup
    ready(setup)
    original = service.call

    def partial(op, **fields):
        if op in {"read", "read_many"}:
            raise HelperError("uncertain", "simulated partial read after enumeration")
        return original(op, **fields)

    service.call = partial
    service.apply("tick")
    assert project(service, admission)["waiting"]
    service.call = original
    source.rows[0]["notes"] += "\nChanged instructions"
    service.apply("tick")
    assert project(service, admission)["required_action"] is not None
    source.denied = True
    service.apply("tick")
    source.denied = False
    service.apply("tick")
    assert project(service, admission)["required_action"] is not None
    assert owner.tasks["0"] == "paused"


def test_http_wait_fields_are_shared_by_attention_and_occurrences(workflow, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from reminders_kanban.api import attention, occurrence
    from reminders_kanban.api.delegation import service as delegation_service

    setup, ready = workflow
    service, source, owner, admission = setup
    ready(setup)
    monkeypatch.setattr(admission.kb, "list_events", lambda *args: [], raising=False)
    app = FastAPI()
    app.include_router(attention.router)
    app.include_router(occurrence.router)
    app.dependency_overrides[delegation_service] = lambda: service
    app.dependency_overrides[occurrence.service] = lambda: service
    client = TestClient(app)
    source.denied = True
    service.apply("tick")
    # One-off preview reads Reminders; only recurring preview is cache-only.
    paths = ["/attention"] + (["/occurrences"] if ready is ready_occurrence else [])
    for path in paths:
        response = client.get(path)
        assert response.status_code == 200
        task = response.json()["tasks"][0]
        assert task["state"] == "waiting_source"
        assert task["wait_reason"] == "source_unavailable"
        assert task["waiting"] is True and task["required_action"] is None
    assert client.get("/attention").json()["needs_you_count"] == 0
    source.denied = False
    service.apply("tick")
    assert client.get("/attention").json()["tasks"][0]["wait_reason"] is None


def test_every_occurrence_partial_schedule_read_waits_and_recovers(request):
    from test_recurring import enable

    setup = request.getfixturevalue("occurrence_setup")
    service, source, owner, admission = setup
    row = enable(setup)
    original = service.call

    def unavailable(op, **fields):
        if op == "occurrence-schedule":
            raise HelperError("uncertain", "simulated schedule read failure")
        return original(op, **fields)

    service.call = unavailable
    service.apply("tick")
    assert service.preview()["tasks"][0]["wait_reason"] == "source_unavailable"
    service.call = original
    service.apply("tick")
    assert service.preview()["tasks"][0]["wait_reason"] is None
    assert owner.tasks[row["task_id"]] == "active"
    assert admission.starts == 1


def test_wait_survives_owner_restart_and_recovers_without_resume(workflow):
    setup, ready = workflow
    service, source, owner, admission = setup
    ready(setup)
    source.denied = True
    service.apply("tick")
    restarted = type(service)(
        service.home, admission, call=service.call, origin=service.origin,
        write_link=service.write_link, control_factory=lambda *_: owner,
    )
    assert project(restarted, admission)["waiting"]
    source.denied = False
    restarted.apply("tick")
    assert not project(restarted, admission)["waiting"]
    assert admission.starts == 1


def test_one_check_shares_list_read_but_next_check_is_fresh(workflow):
    setup, ready = workflow
    service, source, owner, admission = setup
    ready(setup)
    calls = []
    original = service.call

    def counted(op, **fields):
        calls.append(op)
        return original(op, **fields)

    service.call = counted
    with service.store.connection() as db:
        row = service._rows(db)[0]
    # Twenty-five delegated rows exercise the same list identity validation.
    service._rows = lambda db: [copy.deepcopy(row) for _ in range(25)]
    snapshot(service, refresh=True)
    assert calls == ["read_many"]
    calls.clear()
    # (Before the claim line: words typed onto that line get it rewritten, a read of its own.)
    source.rows[0]["notes"] = "Changed between checks. " + source.rows[0]["notes"]
    result = snapshot(service, refresh=True)
    assert calls == ["read_many"]
    assert owner.tasks["0"] == "paused"
    assert result["tasks"]


def test_delegation_display_reads_without_owner_lock_or_helper(request):
    setup = request.getfixturevalue("one_setup")
    service, source, owner, admission = setup
    ready_one(setup)
    service.call = lambda *a, **k: pytest.fail("display called Reminders")
    service.store.locked = lambda: pytest.fail("display waited for owner")
    admission.serialized = lambda: pytest.fail("display waited for admission")
    result = service.preview()
    assert len(result["tasks"]) == 1
    assert "stale" in result and "as_of" in result


@pytest.mark.parametrize("change", ["completed", "deleted"])
@pytest.mark.parametrize("refresh", [False, True])
def test_uncertain_terminal_stop_retries(request, change, refresh):
    from reminders_kanban.execution import UnsupportedControl

    setup = request.getfixturevalue("one_setup")
    service, source, owner, admission = setup
    ready_one(setup)
    stop = owner.stop

    def raced(_):
        raise UnsupportedControl("simulated worker race")

    owner.stop = raced
    if change == "deleted":
        source.rows.clear()
    else:
        source.rows[0]["completed"] = True
    service.apply("tick")
    assert owner.tasks["0"] == "active"
    owner.stop = stop
    if refresh:
        snapshot(service, refresh=True)
    else:
        service.apply("tick")
    assert owner.tasks["0"] == "stopped"


def test_accept_does_not_use_check_snapshot_after_source_edit(workflow):
    from reminders_kanban.workflow.reconciliation import read_identity, source_check

    setup, ready = workflow
    service, source, owner, admission = setup
    ready(setup)
    task = next(iter(owner.tasks))
    owner.tasks[task] = "result"
    with service.store.connection() as db:
        row = service._rows(db)[0]
    with source_check():
        read_identity(service, row["source"])
        source.rows[0]["notes"] += " Edit after scan"
        arguments = (dict(expected=row["expected"]) if ready is ready_one
                     else dict(occurrence_id=row["key"]))
        service.apply("accept", **arguments)
    assert source.writes == 0
    assert owner.accepts == 0


def test_dispatch_does_not_use_prior_check_snapshot(workflow):
    setup, ready = workflow
    service, source, owner, admission = setup
    admit = admission.admit
    admission.admit = lambda **kwargs: {}
    ready(setup)

    def edit_then_dispatch(**kwargs):
        source.rows[0]["notes"] += " Edit after owner scan"
        return admit(**kwargs)

    admission.admit = edit_then_dispatch
    service.apply("tick")
    assert admission.starts == 0
