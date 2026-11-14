import copy
from datetime import UTC, datetime

import pytest
from test_occurrence import setup as setup  # noqa: F401


def enable(setup):
    service, source, owner, admission = setup
    original = service.call

    def call(op, **kwargs):
        if op == "occurrence-schedule":
            assert kwargs["expected"] == source.rows[0]
            due = source.rows[0]["due"]
            return dict(
                due_at=datetime(due["year"], due["month"], due["day"], tzinfo=UTC).timestamp()
            )
        return original(op, **kwargs)

    service.call = call
    service.clock = lambda: datetime(2026, 11, 6, 12, tzinfo=UTC).timestamp()
    return service.apply("every", expected=copy.deepcopy(source.rows[0]))["tasks"][0]


def test_due_review_restart_two_occurrences(setup):
    service, source, owner, admission = setup
    first = enable(setup)
    assert admission.starts == 1
    owner.tasks[first["task_id"]] = "result"
    service.apply("tick")
    assert source.writes == 0 and len(service.preview()["tasks"]) == 1
    service.apply("accept", occurrence_id=first["key"])
    service.apply("tick")
    second = service.preview()["tasks"][-1]
    assert second["key"] != first["key"] and second["held_reason"] == "not_due"
    assert source.writes == admission.starts == 1
    # Same durable stores after a process restart; only advance the test clock.
    from reminders_kanban.workflow.occurrence import OccurrenceDelegation

    restarted = OccurrenceDelegation(
        service.home,
        admission,
        call=service.call,
        origin=service.origin,
        write_link=source.link,
        control_factory=lambda *_: owner,
        clock=lambda: datetime(2026, 11, 7, 12, tzinfo=UTC).timestamp(),
    )
    admission.queue.add(second["task_id"])
    restarted.apply("tick")
    assert admission.starts == 2
    owner.tasks[second["task_id"]] = "result"
    restarted.apply("accept", occurrence_id=first["key"])
    restarted.apply("tick")
    assert source.writes == 1
    source.successor_due = dict(year=2026, month=11, day=8)
    restarted.apply("accept", occurrence_id=second["key"])
    restarted.apply("tick")
    assert source.writes == 2
    rows = restarted.preview()["tasks"]
    assert len(rows) == 3 and rows[-1]["held_reason"] == "not_due"
    assert rows[0]["completion"]["result_id"] != rows[1]["completion"]["result_id"]
    assert len({r["destination"]["url"] for r in rows}) == 1
    with service.completion.store.locked() as db:
        assert db.execute("SELECT count(*) FROM occurrences WHERE done=0").fetchone()[0] == 1


@pytest.mark.parametrize("change", ["notes", "identity", "copy", "history"])
def test_ambiguity_never_advances(setup, change):
    service, source, owner, admission = setup
    first = enable(setup)
    owner.tasks[first["task_id"]] = "result"
    if change == "history":
        source("complete-occurrence", expected=copy.deepcopy(source.rows[0]))
        source.rows.append(dict(source.rows[-1], id="duplicate"))
    elif change == "copy":
        source.rows.append(dict(source.rows[0], id="copy"))
    else:
        source.rows[0]["notes" if change == "notes" else "externalId"] = "changed"
    result = service.apply("tick")["tasks"]
    assert len(result) == 1 and result[0]["status"] == "needs_reconciliation"
    assert admission.starts == 1


def test_ended_and_no_import_authority(setup):
    service, source, owner, admission = setup
    assert not service.apply("tick")["tasks"]
    source.ended = True
    first = enable(setup)
    owner.tasks[first["task_id"]] = "result"
    service.apply("accept", occurrence_id=first["key"])
    result = service.apply("tick")["tasks"]
    assert len(result) == 1 and result[0]["series_state"] == "ended"


def test_http_rejects_owner_clock_and_receipts(setup):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from reminders_kanban.api import recurring

    app = FastAPI()
    app.include_router(recurring.router)
    app.dependency_overrides[recurring.service] = lambda: setup[0]
    client = TestClient(app)
    assert client.get("/recurring").headers["Cache-Control"] == "no-store"
    for field in ("clock", "evidence", "board", "instruction_version"):
        assert (
            client.post("/recurring/actions", json={"action": "every", field: 1}).status_code == 422
        )


def test_capacity_recovery_holds_same_occurrence(setup):
    import time
    from types import SimpleNamespace

    service, source, owner, admission = setup
    row = enable(setup)
    task = row["task_id"]
    owner.backend = SimpleNamespace(_resolve_rate_limit_cooldown_seconds=lambda: 1)
    owner._workers_stopped = lambda _: True
    failed = dict(
        id=1, ended_at=int(time.time()) - 5, outcome="rate_limited", metadata=dict(exit_code=75)
    )
    owner.observe = lambda task: dict(state=owner.tasks[task], runs=[failed])
    owner.tasks[task] = "ready"
    admission.queue.add(task)
    result = service.apply("tick")["tasks"][0]
    assert result["recovery"]["action"] == "reconcile" and admission.starts == 1
    service.reconcile_attempt(row["key"], run_id=1, evidence="Checked: no external writes")
    admission.queue.add(task)
    service.apply("tick")
    assert admission.starts == 2 and source.writes == 0
    assert len(service.preview()["tasks"]) == 1


def test_replay_after_carry_forward_crash(setup):
    service, source, owner, admission = setup
    row = enable(setup)
    owner.tasks[row["task_id"]] = "result"
    carry = service.completion.carry_forward

    def crash(key):
        carry(key)
        raise InterruptedError("after durable successor before workflow row")

    service.completion.carry_forward = crash
    with pytest.raises(InterruptedError):
        service.apply("accept", occurrence_id=row["key"])
        service.apply("tick")
    service.completion.carry_forward = carry
    service.apply("tick")
    service.apply("tick")
    assert len(service.preview()["tasks"]) == 2 and source.writes == 1
    assert admission.starts == 1


def test_future_source_cannot_be_delegated_early_through_current_endpoint(setup):
    service, source, owner, admission = setup
    row = enable(setup)
    owner.tasks[row["task_id"]] = "result"
    service.apply("accept", occurrence_id=row["key"])
    service.apply("tick")
    service.apply("ready", expected=copy.deepcopy(source.rows[0]))
    assert admission.starts == 1


def test_explicit_every_after_current_occurrence_finishes(setup):
    service, source, owner, admission = setup
    first = service.apply("ready", expected=copy.deepcopy(source.rows[0]))["tasks"][0]
    owner.tasks[first["task_id"]] = "result"
    service.apply("accept", occurrence_id=first["key"])
    service.apply("tick")
    second = enable(setup)
    rows = service.preview()["tasks"]
    second = rows[-1]
    owner.tasks[second["task_id"]] = "result"
    source.successor_due = dict(year=2026, month=11, day=8)
    service.apply("accept", occurrence_id=second["key"])
    service.apply("tick")
    assert len(service.preview()["tasks"]) == 3


def test_recovery_reports_series_hold_after_completed_occurrence(setup):
    from reminders_kanban.workflow.reconciliation import snapshot

    service, source, owner, admission = setup
    row = enable(setup)
    owner.tasks[row["task_id"]] = "result"
    carry = service.completion.carry_forward

    def disconnected(key):
        source.denied = True
        return carry(key)

    service.completion.carry_forward = disconnected
    service.apply("accept", occurrence_id=row["key"])
    service.apply("tick")
    result = snapshot(service, refresh=True)
    assert result["status"] == "attention"
    assert result["cases"][0]["reason"] == "access_denied"
    assert result["freshness"] == "unavailable"
    assert result["tasks"][0]["completion"]["history_id"]
    assert source.writes == admission.starts == 1


def held(setup):
    service, source, owner, _ = setup
    row = enable(setup)
    owner.tasks[row["task_id"]] = "result"
    carry = service.completion.carry_forward

    def moved(key):
        source.rows[0]["due"]["day"] += 1
        return carry(key)

    service.completion.carry_forward = moved
    service.apply("accept", occurrence_id=row["key"])
    service.apply("tick")
    service.completion.carry_forward = carry
    return service.preview()["tasks"][0]


def client_for(service):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from reminders_kanban.api import recurring

    app = FastAPI()
    app.include_router(recurring.router)
    app.dependency_overrides[recurring.service] = lambda: service
    return TestClient(app)


@pytest.mark.parametrize("decision", ["end", "reauthorize"])
def test_owner_resolves_hold_http_and_replay(setup, decision):
    service, source, _, admission = setup
    row = held(setup)
    assert row["series_state"] == "needs_reconciliation"
    request = dict(
        action="resolve_series",
        occurrence_id=row["key"],
        hold_id=row["hold_id"],
        decision=decision,
        confirmed_cause=row["held_reason"],
        expected=copy.deepcopy(source.rows[0]),
    )
    client = client_for(service)
    stale = client.post("/recurring/actions", json=dict(request, hold_id="stale")).json()
    assert stale["reason"] == "stale_hold"
    result = client.post("/recurring/actions", json=request).json()
    assert result["status"] == "ok"
    assert result["task"]["series_state"] == "authorization_ended"
    assert client.post("/recurring/actions", json=request).json() == result
    assert source.writes == admission.starts == 1
    service.apply("tick")
    rows = service.preview()["tasks"]
    assert len(rows) == (2 if decision == "reauthorize" else 1)
    assert rows[0]["completion"]["history_id"] == row["completion"]["history_id"]
    if decision == "end":
        service.apply("every", expected=copy.deepcopy(source.rows[0]))
        assert len(service.preview()["tasks"]) == 2


@pytest.mark.parametrize("change", ["identity", "copy", "history", "stale", "cause"])
def test_owner_resolution_refuses_conflicts(setup, change):
    service, source, _, _ = setup
    row = held(setup)
    expected = copy.deepcopy(source.rows[0])
    if change == "identity":
        source.rows[0]["externalId"] = "replacement"
    elif change == "copy":
        source.rows.append(
            dict(source.rows[0], id="copy", notes=source.rows[0]["notes"] + " extra")
        )
    elif change == "history":
        source.rows.append(dict(source.rows[-1], id="duplicate"))
    elif change == "stale":
        source.rows[0]["priority"] = 9
    result = (
        client_for(service)
        .post(
            "/recurring/actions",
            json=dict(
                action="resolve_series",
                occurrence_id=row["key"],
                hold_id=row["hold_id"],
                decision="reauthorize",
                expected=expected,
                confirmed_cause="wrong" if change == "cause" else row["held_reason"],
            ),
        )
        .json()
    )
    assert result["status"] != "ok"
    assert len(service.preview()["tasks"]) == 1
    assert source.writes == 1


@pytest.mark.parametrize("code", ["access_denied", "failed", "uncertain", "source_unavailable"])
def test_transient_carry_resumes_http(setup, code):
    from reminders_kanban.reminders.helper import HelperError

    service, source, owner, admission = setup
    row = enable(setup)
    owner.tasks[row["task_id"]] = "result"
    call = service.completion.call
    carry = service.completion.carry_forward

    def unavailable(key):
        def fail(*args, **kwargs):
            raise HelperError(code, "temporarily unavailable")

        service.completion.call = fail
        return carry(key)

    service.completion.carry_forward = unavailable
    client = client_for(service)
    result = client.post(
        "/recurring/actions", json=dict(action="accept", occurrence_id=row["key"])
    ).json()
    assert result["tasks"][0]["status"] == "done"
    result = client.post("/recurring/actions", json=dict(action="tick")).json()
    assert result["tasks"][0]["series_state"] == "waiting_source"
    assert result["tasks"][0]["held_reason"] == code
    service.completion.call = call
    service.completion.carry_forward = carry
    result = client.post("/recurring/actions", json=dict(action="tick")).json()
    assert len(result["tasks"]) == 2
    assert result["tasks"][0]["series_state"] == "active"
    assert source.writes == admission.starts == 1


def test_route_and_trusted_owner_share_clock(setup, monkeypatch):
    from reminders_kanban.workflow import occurrence

    service, source, owner, admission = setup
    first = enable(setup)
    owner.tasks[first["task_id"]] = "result"
    service.apply("accept", occurrence_id=first["key"])
    service.apply("tick")
    second = service.preview()["tasks"][-1]
    service.clock = lambda: second["due_at"] + 1

    def fresh_owner():
        return occurrence.OccurrenceDelegation(
            service.home,
            admission,
            call=service.call,
            origin=service.origin,
            write_link=source.link,
            control_factory=lambda *_: owner,
        )

    route_owner = fresh_owner()
    trusted_owner = fresh_owner()
    assert route_owner.clock() == trusted_owner.clock() == second["due_at"] + 1
    result = client_for(route_owner).post("/recurring/actions", json={"action": "tick"}).json()
    assert result["tasks"][-1]["held_reason"] != "not_due"
    with trusted_owner.store.locked() as db, admission.serialized() as conn:
        assert (
            trusted_owner._observe(db, trusted_owner._rows(db)[-1], conn)["guard"]["status"]
            == "active"
        )


@pytest.mark.parametrize("boundary", ["before_successor", "before_end"])
def test_owner_resolution_recovers_after_journal_commit(setup, monkeypatch, boundary):
    service, source, _, _ = setup
    row = held(setup)
    request = dict(action="resolve_series", occurrence_id=row["key"], hold_id=row["hold_id"],
                   decision="reauthorize", confirmed_cause=row["held_reason"],
                   expected=copy.deepcopy(source.rows[0]))
    save = service._save
    def crash(db, value):
        if ((boundary == "before_end" and value.get("series_resolution"))
                or (boundary == "before_successor" and value.get("predecessor"))):
            raise InterruptedError("after receipt before workflow save")
        return save(db, value)
    monkeypatch.setattr(service, "_save", crash)
    with pytest.raises(InterruptedError):
        service.apply(**request)
    monkeypatch.setattr(service, "_save", save)
    client_for(service).post("/recurring/actions",
                             json=dict(action="every", expected=request["expected"]))
    result = service.apply(**request)
    assert result["status"] == "ok" and len(result["tasks"]) == 2
    assert service.apply(**request) == result
    assert source.writes == 1


@pytest.mark.parametrize("change", ["identity", "copy"])
def test_ended_series_redelegation_preserves_identity(setup, change):
    service, source, _, _ = setup
    row = held(setup)
    service.apply("resolve_series", occurrence_id=row["key"], hold_id=row["hold_id"],
                  decision="end", expected=copy.deepcopy(source.rows[0]))
    if change == "identity":
        source.rows[0]["externalId"] = "replacement"
    else:
        source.rows.append(
            dict(source.rows[0], id="copy", notes=source.rows[0]["notes"] + " extra"))
    result = client_for(service).post("/recurring/actions", json=dict(
        action="every", expected=source.rows[0])).json()
    assert result["status"] != "ok"
    assert len(service.preview()["tasks"]) == 1
