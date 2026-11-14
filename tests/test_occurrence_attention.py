from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from test_occurrence import ready, setup  # noqa: F401

from reminders_kanban.api.attention import router
from reminders_kanban.api.delegation import service
from reminders_kanban.execution import OperationConflict
from reminders_kanban.workflow.attention import Attention


@pytest.fixture
def conversation(setup):  # noqa: F811
    delegation, source, owner, admission = setup
    ready(setup)
    events, comments = [], {}
    admission.kb = SimpleNamespace(list_events=lambda *_: events,
                                   get_task=lambda _, task: SimpleNamespace(id=task))
    admission._parked = lambda conn, task: task.id in admission.queue
    original_observe = owner.observe
    owner.observe = lambda task: dict(
        original_observe(task), comments=list(comments.values()), runs=[])
    owner._workers_stopped = lambda task: True

    def comment(task, key, text):
        comments.setdefault(key, text.strip())
        return list(comments).index(key) + 1

    owner.comment = comment
    owner.request_changes = lambda task, key, text: owner.resume(task)

    def phase(state):
        owner.tasks["0"] = state
        events.append(SimpleNamespace(
            id=len(events) + 1, run_id=len(events) + 1,
            kind={"question": "blocked", "result": "review_requested"}.get(state, "progress"),
            payload={"kind": "needs_input", "reason": "Which color?"},
        ))

    from reminders_kanban.workflow.delegation import Delegation
    base = Delegation(delegation.home, admission, call=source,
                      control_factory=lambda *_: owner)
    return Attention(base), source, owner, admission, phase, comments


def submission(attention, action="reply", key="one"):
    return dict(key=key, task_id="0", token=attention.feed()["tasks"][0]["attention"]["token"],
                action=action, text="blue")


def test_reply_changes_history_and_restart(conversation):
    attention, source, owner, admission, phase, comments = conversation
    phase("question")
    body = submission(attention)
    assert attention.submit(**body)["status"] == "submitted"
    restarted = Attention(attention.owner)
    assert restarted.submit(**body)["status"] == "submitted"
    assert len(comments) == 1 and admission.starts == 2
    phase("result")
    changes = submission(restarted, "request_changes", "two")
    assert restarted.submit(**changes)["status"] == "submitted"
    phase("result")
    assert restarted.submit(**changes)["status"] == "submitted"
    assert len(comments) == 2 and admission.starts == 3
    assert source.writes == 0
    assert source.rows[0]["notes"].startswith("My notes\n\nOpen in Hermes:")
    with pytest.raises(OperationConflict):
        restarted.submit(**dict(body, text="red"))


def test_feed_reconnect_and_progress(conversation):
    attention, _, _, _, phase, _ = conversation
    for state in ("active", "question", "ready", "result", "failed"):
        phase(state)
    feed = attention.feed()
    assert [e["kind"] for e in feed["events"]] == ["question", "result"]
    assert attention.feed()["events"] == feed["events"]
    assert Attention(attention.owner).feed(after=feed["cursor"])["events"] == []
    assert feed["tasks"][0]["required_action"] == "retry"
    assert feed["needs_you_count"] == 1


def test_stale_token_and_source_veto(conversation):
    attention, source, _, admission, phase, comments = conversation
    phase("question")
    old = submission(attention)
    phase("question")
    assert attention.submit(**old)["status"] == "conflict"
    body = submission(attention)
    source.rows[0]["notes"] = "Changed instructions"
    assert attention.submit(**body)["reason"] == "source_veto"
    assert not comments and admission.starts == 1


def test_lost_comment_response_replays_once(conversation):
    attention, _, owner, admission, phase, comments = conversation
    phase("question")
    body = submission(attention)
    original = owner.comment

    def lost(*args):
        original(*args)
        raise OSError("lost response")

    owner.comment = lost
    with pytest.raises(OSError):
        attention.submit(**body)
    owner.comment = original
    assert Attention(attention.owner).submit(**body)["status"] == "submitted"
    assert len(comments) == 1 and admission.starts == 2


def test_lost_transition_response_never_restarts_later_question(conversation):
    attention, _, owner, admission, phase, comments = conversation
    phase("question")
    body = submission(attention)
    original = owner.resume

    def lost(*args):
        original(*args)
        raise OSError("lost response")

    owner.resume = lost
    with pytest.raises(OSError):
        attention.submit(**body)
    phase("question")
    owner.resume = original
    assert Attention(attention.owner).submit(**body)["status"] == "needs_reconciliation"
    assert len(comments) == 1 and admission.starts == 1


def test_http_contract(conversation):
    attention, _, _, _, phase, _ = conversation
    phase("question")
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[service] = lambda: attention.owner
    client = TestClient(app)
    response = client.get("/attention")
    assert response.headers["cache-control"] == "no-store"
    body = submission(attention)
    assert client.post("/attention/submissions", json=body).json()["status"] == "submitted"
    assert client.post("/attention/submissions", json=dict(body, board="other")).status_code == 422
    assert client.get("/attention?after=-1").status_code == 422


def test_second_client_cannot_duplicate_pending_comment(conversation):
    attention, _, owner, _, phase, comments = conversation
    phase("question")
    body = submission(attention)
    original = owner.comment

    def lost(*args):
        original(*args)
        raise OSError("lost response")

    owner.comment = lost
    with pytest.raises(OSError):
        attention.submit(**body)
    assert attention.submit(**dict(body, key="other"))["reason"] == "attention_already_submitted"
    assert len(comments) == 1
    assert attention.feed()["submissions"][0]["status"] == "pending"


def test_worker_exit_and_denied_source(conversation):
    attention, source, owner, admission, phase, comments = conversation
    phase("question")
    body = submission(attention)
    owner._workers_stopped = lambda _: False
    assert attention.submit(**body)["reason"] == "worker_still_alive"
    owner._workers_stopped = lambda _: True
    source.denied = True
    assert attention.submit(**body)["reason"] == "source_veto"
    assert not comments and admission.starts == 1



@pytest.mark.parametrize("field,value", [("due", {}), ("rules", []), ("completed", True)])
def test_occurrence_source_changes_never_advance(conversation, field, value):
    attention, source, _, admission, phase, comments = conversation
    phase("result")
    body = submission(attention, "request_changes")
    source.rows[0][field] = value
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[service] = lambda: attention.owner
    result = TestClient(app).post("/attention/submissions", json=body).json()
    assert result["reason"] == "source_veto"
    assert source.writes == 0 and not comments and admission.starts == 1


def test_occurrence_http_changes_and_exact_notification(conversation):
    attention, source, _, _, phase, _ = conversation
    phase("result")
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[service] = lambda: attention.owner
    client = TestClient(app)
    feed = client.get("/attention").json()
    task = feed["tasks"][0]
    event = feed["events"][0]
    assert event["occurrence_id"] == task["occurrence_id"]
    assert event["task_id"] == task["task_id"]
    assert feed["needs_you_count"] == 1
    response = client.post("/attention/submissions", json=submission(attention, "request_changes"))
    assert response.json()["status"] == "submitted"
    assert response.headers["cache-control"] == "no-store"
    assert source.writes == 0
    assert client.get(f'/attention?after={feed["cursor"]}').json()["events"] == []


def test_populated_feed_never_waits_for_lifecycle_or_source(conversation, monkeypatch):
    import copy
    import fcntl
    from collections import Counter

    from reminders_kanban.workflow.delegation import Delegation

    attention, _, owner, admission, phase, _ = conversation
    phase("question")
    recurring = attention.owners[1]
    with recurring.store.locked() as db:
        template = recurring._rows(db)[0]
    for workflow, indices in ((attention.owner, range(1, 301)), (recurring, range(301, 308))):
        with workflow.store.locked() as db:
            for index in indices:
                row = copy.deepcopy(template)
                row.update(key=str(index), task_id=str(index))
                row['expected']['id'] = str(index)
                workflow._save(db, row)
                owner.tasks[str(index)] = 'ready'

    calls = Counter()
    original_rows, original_observe = Delegation._rows, owner.observe

    def rows(workflow, db):
        calls['rows'] += 1
        return original_rows(workflow, db)

    def observe(task):
        calls['observe'] += 1
        return original_observe(task)

    def forbidden(*args, **kwargs):
        pytest.fail('GET attention must not acquire lifecycle locks or call Reminders')

    monkeypatch.setattr(fcntl, 'flock', forbidden)
    monkeypatch.setattr(admission, 'serialized', forbidden)
    monkeypatch.setattr(Delegation, '_rows', rows)
    monkeypatch.setattr(owner, 'observe', observe)
    base = Delegation(attention.owner.home, admission, call=forbidden,
                      control_factory=lambda *_: owner)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[service] = lambda: base
    client = TestClient(app)
    response = client.get('/attention')
    feed = response.json()
    assert response.headers['cache-control'] == 'no-store'
    assert feed['status'] == 'ok'
    assert len(feed['tasks']) == 308
    assert calls == {'rows': 2, 'observe': 308}
    assert [t['task_id'] for t in feed['tasks']] == [
        *map(str, range(1, 301)), '0', *map(str, range(301, 308))]
    assert feed['needs_you_count'] == 1
    assert feed['tasks'][300]['attention']['kind'] == 'question'
    replay = client.get(f"/attention?after={feed['cursor']}").json()
    assert replay['events'] == []
    assert replay['tasks'] == feed['tasks']
