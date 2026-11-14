import copy
import sqlite3
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from reminders_kanban.api import delegation
from reminders_kanban.execution import UnsupportedControl
from reminders_kanban.execution.admission import Admission


@pytest.mark.parametrize("gateway,review", [(True, True), (True, False), (False, True)])
def test_incompatible_dispatch_settings_have_a_distinct_recoverable_status(gateway, review):
    config = {"kanban": {"dispatch_in_gateway": gateway}}
    original = copy.deepcopy(config)
    admission = Admission.__new__(Admission)
    admission.config = lambda: config
    admission.dispatch = SimpleNamespace(review_dispatch_enabled=lambda: review)
    with sqlite3.connect(":memory:", check_same_thread=False) as conn:
        owner = SimpleNamespace(preview=lambda: admission._settings(conn))
        app = FastAPI()
        app.include_router(delegation.router)
        app.dependency_overrides[delegation.service] = lambda: owner
        response = TestClient(app).get("/delegation")
    assert response.status_code == 200
    assert response.json()["status"] == "native_host_required"
    assert "Reminders board" in response.json()["reason"]
    assert config == original


def test_task_state_conflict_is_not_reported_as_a_host_upgrade_requirement():
    def preview():
        raise UnsupportedControl("previous worker has not stopped")

    assert delegation.run(SimpleNamespace(preview=preview)) == {
        "status": "attention", "reason": "previous worker has not stopped"
    }
