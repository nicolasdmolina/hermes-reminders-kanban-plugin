"""Cross-feature checks; these controlled adapters are not live evidence."""

import copy
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from test_occurrence import setup as setup  # noqa: F401
from test_recurring import enable
from test_views import card

from reminders_kanban.workflow.views import query_board


@pytest.mark.parametrize("change", ["notes", "completed"])
def test_reconnect_observes_source_before_due_recurring_dispatch(setup, change):
    service, source, owner, admission = setup
    first = enable(setup)
    owner.tasks[first["task_id"]] = "result"
    service.apply("accept", occurrence_id=first["key"])
    service.apply("tick")
    successor = service.preview()["tasks"][-1]
    source.denied = True
    service.clock = lambda: datetime(2026, 11, 7, 12, tzinfo=UTC).timestamp()
    service.apply("tick")
    if change == "notes":
        source.rows[0]["notes"] += " changed offline"
    else:
        source("complete-occurrence", expected=copy.deepcopy(source.rows[0]))
    source.denied = False
    admission.queue.add(successor["task_id"])
    service.apply("tick")
    service.apply("tick")
    assert admission.starts == 1
    assert service.preview()["tasks"][-1]["status"] == "needs_reconciliation"


def test_hidden_attention_survives_capacity_recovery(setup):
    service, source, owner, admission = setup
    first = enable(setup)
    task = first["task_id"]
    owner.backend = SimpleNamespace(_resolve_rate_limit_cooldown_seconds=lambda: 1)
    owner._workers_stopped = lambda _: True
    failed = dict(id=1, ended_at=1, outcome="rate_limited", metadata=dict(exit_code=75))
    owner.observe = lambda task: dict(state=owner.tasks[task], runs=[failed])
    owner.tasks[task] = "ready"
    admission.queue.add(task)
    state = service.apply("tick")["tasks"][0]
    assert state["recovery"]["action"] == "reconcile"
    cards = [card(task, owner="agent", recurring=True, column="Needs you", action="reconcile")]
    filtered = query_board(cards, owner="human", queue=[task])
    assert filtered["attention"]["hidden"][0]["id"] == task
    service.reconcile_attempt(first["key"], run_id=1, evidence="No external writes occurred")
    admission.queue.add(task)
    service.apply("tick")
    assert admission.starts == 2 and source.writes == 0
    assert filtered["queue"] == [task]
