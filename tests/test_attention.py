from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from test_delegation import ready, setup  # noqa: F401

from reminders_kanban.api.attention import router
from reminders_kanban.api.delegation import router as delegation_router
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

    return Attention(delegation), source, owner, admission, phase, comments


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


def test_queued_work_is_not_attention_but_source_pause_is(conversation):
    attention, source, owner, admission, phase, _ = conversation
    admission.ready("0")
    feed = attention.feed()
    assert feed["tasks"][0]["state"] == "ready"
    assert feed["needs_you_count"] == 0
    source.rows[0]["notes"] = "Changed"
    with attention.owner.store.locked() as db:
        row = attention.owner._rows(db)[0]
        row["guard"] = attention.owner._guard(owner).observe("0")
        attention.owner._save(db, row)
    assert attention.feed()["tasks"][0]["required_action"] == "resume"


def test_uncertain_completion_remains_attention(conversation):
    attention, source, _, _, phase, _ = conversation
    phase("result")
    source.uncertain = True
    attention.owner.apply("accept", expected={"id": "a"})
    feed = attention.feed()
    assert feed["tasks"][0]["state"] == "needs_reconciliation"
    assert feed["tasks"][0]["required_action"] == "reconcile"
    assert feed["needs_you_count"] == 1


def test_answered_question_is_not_reclassified_as_failed_work(conversation):
    attention, _, owner, admission, phase, comments = conversation
    phase("question")
    observe = owner.observe
    owner.observe = lambda task: dict(
        observe(task), task={"block_kind": "needs_input"},
        runs=[dict(id=1, ended_at=1, outcome="blocked", metadata=None)],
    )
    assert attention.submit(**submission(attention))["status"] == "submitted"
    assert admission.starts == 2
    assert len(comments) == 1
    assert not attention.owner.preview()["tasks"][0].get("recovery")


@pytest.mark.parametrize("cause,action,resolved,expected", [
    ("capacity", "wait", True, None),
    ("balance", "fund_account", True, "fund_account"),
    ("access", "repair_access", True, "repair_access"),
    ("ordinary", "retry", True, "retry"),
    ("capacity", "reconcile", False, "reconcile"),
])
@pytest.mark.parametrize("owner_state", ["failed", "ready"])
def test_recovery_attention_http(conversation, cause, action, resolved, expected, owner_state):
    attention, _, control, _, phase, _ = conversation
    phase(owner_state)
    observe = control.observe
    control.observe = lambda task: dict(
        observe(task), runs=[dict(id=1, ended_at=1, outcome="rate_limited",
                                 metadata={"exit_code": 75})])
    with attention.owner.store.locked() as db:
        row = attention.owner._rows(db)[0]
        row["recovery"] = dict(run_id=1, cause=cause, action=action,
                               reconciliation="resolved" if resolved else "required")
        attention.owner._save(db, row)
    app = FastAPI()
    app.include_router(router)
    app.include_router(delegation_router)
    app.dependency_overrides[service] = lambda: attention.owner
    client = TestClient(app)
    feed = client.get("/attention").json()
    assert feed["needs_you_count"] == int(expected is not None)
    task = feed["tasks"][0]
    assert task["required_action"] == expected
    assert task["waiting"] == (expected is None)
    assert task["recovery"]["cause"] == cause
    assert task["attention"] is None
    assert feed["events"] == []
    saved = client.get("/delegation").json()["tasks"][0]
    for field in ("state", "required_action", "waiting", "recovery"):
        assert saved[field] == task[field]


@pytest.mark.parametrize("cause,action", [("capacity", "wait"), ("balance", "fund_account")])
def test_old_wait_does_not_hide_new_failure(conversation, cause, action):
    attention, _, control, _, phase, _ = conversation
    phase("failed")
    observe = control.observe
    control.observe = lambda task: dict(
        observe(task), runs=[dict(id=2, ended_at=2, outcome="failed")])
    with attention.owner.store.locked() as db:
        row = attention.owner._rows(db)[0]
        row["recovery"] = dict(run_id=1, cause=cause, action=action, reconciliation="resolved")
        attention.owner._save(db, row)
    feed = attention.feed()
    assert feed["needs_you_count"] == 1
    assert feed["tasks"][0]["required_action"] == "retry"
    assert feed["tasks"][0]["waiting"] is False


@pytest.mark.parametrize("phase_name,runs,held,expected,waiting,recovery", [
    ("ready", [dict(id=1, ended_at=1, outcome="rate_limited"),
               dict(id=2, ended_at=2, outcome="scheduled")], False, None, True, True),
    ("active", [dict(id=1, ended_at=1, outcome="rate_limited"),
                dict(id=2, ended_at=None, outcome=None)], False, None, False, False),
    ("ready", [dict(id=2, ended_at=2, outcome="failed")], False, None, False, False),
    ("ready", [dict(id=1, ended_at=1, outcome="rate_limited")], True, "resume", False, True),
])
def test_recovery_views_follow_attempt_and_source(
    conversation, phase_name, runs, held, expected, waiting, recovery
):
    attention, _, control, _, phase, _ = conversation
    phase(phase_name)
    observe = control.observe
    control.observe = lambda task: dict(observe(task), runs=runs)
    with attention.owner.store.locked() as db:
        row = attention.owner._rows(db)[0]
        row["recovery"] = dict(run_id=1, cause="capacity", action="wait",
                               reconciliation="resolved", next_check_at="2026-11-06T16:05:00+00:00")
        if held:
            row["guard"] = dict(status="paused")
        attention.owner._save(db, row)
    app = FastAPI()
    app.include_router(router)
    app.include_router(delegation_router)
    app.dependency_overrides[service] = lambda: attention.owner
    client = TestClient(app)
    feed = client.get("/attention").json()
    task = feed["tasks"][0]
    saved = client.get("/delegation").json()["tasks"][0]
    assert task["required_action"] == expected
    assert task["waiting"] is waiting
    assert bool(task["recovery"]) is recovery
    assert feed["needs_you_count"] == int(expected is not None)
    for field in ("state", "required_action", "waiting", "recovery"):
        assert saved[field] == task[field]


@pytest.mark.parametrize('action,state', [('reply', 'question'), ('request_changes', 'result')])
def test_task_model_is_applied_before_continuation_and_replayed(conversation, action, state):
    attention, source, owner, admission, phase, comments = conversation
    phase(state)
    choices = []
    owner.set_model_choice = lambda task, choice: choices.append((task, choice.model_dump()))
    body = dict(submission(attention, action), model_choice={
        'model': 'task-model', 'provider': 'sandbox', 'effort': 'high'})
    original = owner.resume

    def resume(task):
        assert choices[-1] == ('0', body['model_choice'])
        return original(task)

    owner.resume = resume
    assert attention.submit(**body)['status'] == 'submitted'
    assert Attention(attention.owner).submit(**body)['status'] == 'submitted'
    assert len(choices) == 1 and len(comments) == 1 and admission.starts == 2
    with pytest.raises(OperationConflict):
        attention.submit(**dict(body, model_choice=dict(body['model_choice'], effort='low')))
    assert source.writes == 0


def test_stale_submission_never_changes_model(conversation):
    attention, _, owner, _, phase, _ = conversation
    phase('result')
    body = dict(submission(attention, 'request_changes'), model_choice={'effort': 'none'})
    phase('result')
    owner.set_model_choice = lambda *_: pytest.fail('stale choice applied')
    assert attention.submit(**body)['status'] == 'conflict'


def test_invalid_model_choice_rejected_before_submission(conversation):
    attention, _, _, _, phase, _ = conversation
    phase('question')
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[service] = lambda: attention.owner
    client = TestClient(app)
    assert client.post('/attention/submissions', json=dict(
        submission(attention), model_choice={'model': 'missing provider'})).status_code == 422


def test_lost_model_save_retries_without_starting_worker(conversation):
    attention, _, owner, admission, phase, comments = conversation
    phase('result')
    body = dict(submission(attention, 'request_changes'), model_choice={'effort': 'none'})
    saves = []

    def interrupted(task, choice):
        saves.append(choice.model_dump())
        raise OSError('lost settings response')

    owner.set_model_choice = interrupted
    with pytest.raises(OSError):
        attention.submit(**body)
    assert admission.starts == 1 and not comments
    owner.set_model_choice = lambda task, choice: saves.append(choice.model_dump())
    assert Attention(attention.owner).submit(**body)['status'] == 'submitted'
    assert saves[0] == saves[1] and len(comments) == 1 and admission.starts == 2


@pytest.mark.parametrize("resumed", ["unblocked", "specified"], ids=["first", "follow-up"])
def test_a_reply_interrupted_after_hermes_resumed_finishes_by_itself(conversation, resumed):
    attention, _, owner, admission, phase, comments = conversation
    phase("question")
    body = submission(attention)
    original = admission.ready
    events = admission.kb.list_events()

    def lost(*args, **kwargs):
        # Hermes did resume the task (its own event says so); queueing never answered.
        # (A follow-up question leaves triage with `specified`, not `unblocked`.)
        events.append(SimpleNamespace(id=len(events) + 1, run_id=None, kind=resumed,
                                      payload=None))
        raise OSError("lost response")

    admission.ready = lost
    with pytest.raises(OSError):
        attention.submit(**body)
    admission.ready = original
    starts = admission.starts
    # No press needed: the next feed read settles it, queues the task and ticks.
    feed = Attention(attention.owner).feed()
    assert [s["status"] for s in feed["submissions"]] == ["submitted"]
    assert len(comments) == 1 and admission.starts == starts + 1
    assert attention.submit(**body)["status"] == "submitted"


def test_a_reply_interrupted_before_hermes_resumed_is_applied_once(conversation):
    attention, _, owner, admission, phase, comments = conversation
    phase("question")
    body = submission(attention)
    original = owner.resume
    resumes = []

    def refused(*args):
        raise OSError("lost before the task was resumed")

    owner.resume = refused
    with pytest.raises(OSError):
        attention.submit(**body)
    owner.resume = lambda *args: (resumes.append(args), original(*args))[1]
    feed = Attention(attention.owner).feed()
    assert [s["status"] for s in feed["submissions"]] == ["submitted"]
    assert len(resumes) == 1 and len(comments) == 1
    Attention(attention.owner).feed()
    assert len(resumes) == 1


def test_an_interrupted_reply_whose_task_is_gone_is_abandoned_and_not_retried(conversation):
    attention, _, owner, admission, phase, comments = conversation
    phase("question")
    body = submission(attention)

    def refused(*args):
        raise OSError("lost before the task was resumed")

    original = owner.resume
    owner.resume = refused
    with pytest.raises(OSError):
        attention.submit(**body)
    owner.resume = original
    admission.kb.get_task = lambda *_: None
    feed = Attention(attention.owner).feed()
    assert [s["status"] for s in feed["submissions"]] == ["abandoned"]
    assert owner.tasks["0"] == "question"  # nothing was resumed
    assert Attention(attention.owner).recover() is None
