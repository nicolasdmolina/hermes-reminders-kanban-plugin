# ruff: noqa: F811
import copy

import pytest
from test_delegation import ready, setup  # noqa: F401

from reminders_kanban.workflow.reconciliation import snapshot


@pytest.mark.parametrize("change,reason", [
    ("missing", "missing_identity"), ("replace", "identity_replaced"),
    ("copy", "multiple_candidates"), ("link", "conflicting_links"),
])
def test_identity_never_transfers_authority(setup, change, reason):
    service, source, owner, admission = setup
    ready(setup)
    if change == "missing":
        source.rows[0]["externalId"] = None
    elif change == "replace":
        source.rows[0]["id"] = "replacement"
    elif change == "copy":
        source.rows.append(dict(source.rows[0], id="copy", notes=source.rows[0]["notes"] + " edit"))
    else:
        source.rows[0]["notes"] += "\nOpen in Hermes: https://other.example/task"
    state = service.apply("tick")["tasks"][0]
    assert state["guard"]["reason"] == reason
    assert owner.tasks["0"] == "paused"
    source.rows = [copy.deepcopy(state["expected"])]
    service.apply("tick")
    assert admission.starts == 1
    assert len(owner.tasks) == 1


@pytest.mark.parametrize("change,status", [
    ("completed", "stopped"), ("deleted", "deleted"), ("notes", "paused"),
])
def test_offline_changes_win_before_dispatch(setup, change, status):
    service, source, owner, admission = setup
    # Hold the first pass to reproduce a queued task across a plugin outage.
    admit = admission.admit
    admission.admit = lambda **_: {}
    ready(setup)
    source.denied = True
    assert snapshot(service, refresh=True)["cases"][0]["reason"] == "source_unavailable"
    source.denied = False
    if change == "deleted":
        source.rows.clear()
    elif change == "notes":
        source.rows[0]["notes"] += " updated"
    else:
        source.rows[0]["completed"] = True
    admission.admit = admit
    assert service.apply("tick")["tasks"][0]["status"] == status
    assert admission.starts == 0
    assert snapshot(service)["tasks"]


def test_http_rejects_context_and_keeps_cached_state_offline(setup):
    import sqlite3

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from reminders_kanban.api import reconciliation
    from reminders_kanban.api.delegation import service
    from reminders_kanban.api.occurrence import service as recurring_service

    owner, source, _, admission = setup
    admission.conn.close()
    admission.conn = sqlite3.connect(":memory:", check_same_thread=False)
    admission.conn.execute("CREATE TABLE rk_admission (task_id TEXT, park_event INTEGER)")
    ready(setup)
    app = FastAPI()
    app.include_router(reconciliation.router)
    app.dependency_overrides[service] = lambda: owner
    app.dependency_overrides[recurring_service] = lambda: None
    client = TestClient(app)
    source.denied = True
    assert client.get("/reconciliation").json()["one_off"]["tasks"]
    response = client.post("/reconciliation/actions", json={
        "action": "recheck", "workflow": "one_off",
    })
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["cases"][0]["reason"] == "source_unavailable"
    assert client.post("/reconciliation/actions", json={
        "action": "recheck", "workflow": "one_off", "profile": "another",
    }).status_code == 422


def test_missing_list_is_not_deleted_reminder(setup):
    from reminders_kanban.reminders.helper import HelperError

    service, source, owner, admission = setup
    ready(setup)

    def missing_list(op, **kwargs):
        if op == "read_many":
            raise HelperError("not_found", "selected list unavailable")
        return source(op, **kwargs)

    service.call = missing_list
    state = service.apply("tick")["tasks"][0]
    assert state["guard"]["reason"] == "source_unavailable"
    assert not state["guard"]["hidden"]
    assert owner.tasks["0"] == "active"
    service.call = source
    state = service.apply("tick")["tasks"][0]
    assert not state["guard"]["hidden"]
    assert admission.starts == 1
