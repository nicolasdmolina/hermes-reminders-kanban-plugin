import copy

import pytest
from test_delegation import Admission, Owner, Source

from reminders_kanban.claims import same_but_claims
from reminders_kanban.reminders.helper import HelperError
from reminders_kanban.workflow.delegation import Delegation
from reminders_kanban.workflow.occurrence import OccurrenceDelegation


class RecurringSource(Source):
    def __init__(self):
        super().__init__()
        self.rows[0].update(rules=["daily"], due={"year": 2026, "month": 11, "day": 6})
        self.successor_due = {"year": 2026, "month": 11, "day": 7}
        self.ended = False
        self.lost_response = False

    def __call__(self, op, **fields):
        if op != "complete-occurrence":
            return super().__call__(op, **fields)
        assert fields["expected"] == self.rows[0]
        self.writes += 1
        if self.uncertain:
            raise RuntimeError("before save")
        history = copy.deepcopy(self.rows[0])
        history.update(id=f"history-{self.writes}", completed=True)
        if self.ended:
            self.rows[0]["completed"] = True
        else:
            self.rows.append(history)
            self.rows[0]["due"] = self.successor_due
        if self.lost_response:
            raise RuntimeError("response lost after save")


@pytest.fixture
def setup(tmp_path):
    source, owner = RecurringSource(), Owner()
    admission = Admission(owner)
    kwargs = dict(
        origin="https://owner.example",
        call=source,
        write_link=source.link,
        control_factory=lambda *_: owner,
    )
    base = Delegation(tmp_path, admission, **kwargs)
    with base.setup.locked() as db:
        state = base.setup.read(db)
        state.update(selected_list_ids=["list"], selection_saved=True)
        base.setup.save(db, state)
    base.apply("activate")
    return OccurrenceDelegation(tmp_path, admission, **kwargs), source, owner, admission


def ready(setup):
    service, source, _, _ = setup
    return service.apply("ready", expected=copy.deepcopy(source.rows[0]))["tasks"][-1]


def test_review_replay_restart_successor_and_separate_history(setup):
    service, source, owner, admission = setup
    first = ready(setup)
    ready(setup)
    assert admission.starts == 1
    owner.tasks[first["task_id"]] = "result"
    service.apply("tick")
    assert source.writes == 0
    source.lost_response = True
    assert service.apply("accept", occurrence_id=first["key"])["tasks"][0]["status"] == "done"
    restarted = OccurrenceDelegation(
        service.home,
        admission,
        call=source,
        origin=service.origin,
        write_link=source.link,
        control_factory=lambda *_: owner,
    )
    restarted.apply("accept", occurrence_id=first["key"])
    restarted.apply("tick")
    assert source.writes == admission.starts == 1
    second = ready((restarted, source, owner, admission))
    assert second["key"] != first["key"] and second["task_id"] != first["task_id"]
    assert second["authorization_id"] == first["authorization_id"]
    assert second["destination"] == first["destination"]
    assert source.rows[0]["notes"].count("Open in Hermes:") == 1
    restarted.apply("accept", occurrence_id=first["key"])
    assert source.writes == 1 and admission.starts == 2
    with restarted.completion.store.locked() as db:
        assert db.execute("SELECT count(*) FROM occurrences").fetchone()[0] == 2
        assert all('"every":false' in r[0] for r in db.execute("SELECT state FROM series"))


@pytest.mark.parametrize("change", ["copy", "identity", "due", "rules", "notes"])
def test_conflicts_stop_authority(setup, change):
    service, source, owner, admission = setup
    row = ready(setup)
    if change == "copy":
        source.rows.append(dict(source.rows[0], id="copy"))
    elif change == "identity":
        source.rows[0]["externalId"] = "new"
    elif change == "denied":
        source.denied = True
    else:
        source.rows[0][change] = "changed"
    result = service.apply("tick")["tasks"][0]
    assert result["status"] == "needs_reconciliation"
    assert owner.tasks[row["task_id"]] == "paused"
    assert source.writes == 0


def test_uncertain_before_save_never_retries(setup):
    service, source, owner, _ = setup
    row = ready(setup)
    owner.tasks[row["task_id"]] = "result"
    source.uncertain = True
    service.apply("accept", occurrence_id=row["key"])
    service.apply("accept", occurrence_id=row["key"])
    assert source.writes == 1
    assert service.preview()["tasks"][0]["status"] == "needs_reconciliation"


@pytest.mark.parametrize(
    "due,next_due",
    [
        (
            {"year": 2026, "month": 3, "day": 7, "hour": 9, "timeZone": "America/New_York"},
            {"year": 2026, "month": 3, "day": 8, "hour": 9, "timeZone": "America/New_York"},
        ),
        ({"year": 2026, "month": 10, "day": 1}, {"year": 2026, "month": 11, "day": 7}),
        ({"year": 2027, "month": 1, "day": 1}, {"year": 2027, "month": 1, "day": 4}),
    ],
)
def test_source_schedule_is_not_calculated(setup, due, next_due):
    service, source, owner, admission = setup
    source.rows[0].update(due=due, rules=[{"frequency": "weekly", "positions": [1, -1]}])
    source.successor_due = next_due
    row = ready(setup)
    owner.tasks[row["task_id"]] = "result"
    outcome = service.apply("accept", occurrence_id=row["key"])["tasks"][0]
    assert outcome["completion"]["successor"]["due"] == next_due
    assert admission.starts == 1


def test_ended_series(setup):
    service, source, owner, _ = setup
    source.ended = True
    row = ready(setup)
    owner.tasks[row["task_id"]] = "result"
    outcome = service.apply("accept", occurrence_id=row["key"])["tasks"][0]
    assert outcome["status"] == "done" and outcome["completion"]["successor"] is None


def test_http_contract_and_historical_links(setup):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from reminders_kanban.api import occurrence
    from reminders_kanban.links import Links

    service, source, owner, admission = setup
    app = FastAPI()
    app.include_router(occurrence.router)
    app.dependency_overrides[occurrence.service] = lambda: service
    client = TestClient(app)
    assert client.get("/occurrences").headers["Cache-Control"] == "no-store"
    first = client.post(
        "/occurrences/actions", json={"action": "ready", "expected": source.rows[0]}
    ).json()["tasks"][0]
    owner.tasks[first["task_id"]] = "result"
    assert (
        client.post(
            "/occurrences/actions", json={"action": "accept", "occurrence_id": first["key"]}
        ).json()["tasks"][0]["status"]
        == "done"
    )
    second = ready(setup)

    def observe(**binding):
        return dict(
            task={"assignee": "default", "result": "retained result"},
            state=owner.tasks[binding["task"]],
            runs=[],
            comments=[],
        )

    destination = first["destination"]
    links = Links(service.home)
    historical = links.resolve(
        destination["owner_id"], destination["link_id"], observe, occurrence=first["key"]
    )
    assert historical["historical"] and historical["actions"] == []
    assert historical["result"] == "retained result"
    current = links.resolve(destination["owner_id"], destination["link_id"], observe)
    assert current["selected_occurrence_id"] == second["key"]
    assert (
        client.post("/occurrences/actions", json={"action": "accept", "occurrence_id": "a"}).json()[
            "status"
        ]
        == "attention"
    )
    assert (
        client.post("/occurrences/actions", json={"action": "ready", "board": "other"}).status_code
        == 422
    )


@pytest.mark.parametrize("phase", ["result", "active"])
def test_source_checkoff_accepts_only_review(setup, phase):
    service, source, owner, admission = setup
    first = ready(setup)
    owner.tasks[first["task_id"]] = phase
    source("complete-occurrence", expected=copy.deepcopy(source.rows[0]))
    result = service.apply("tick")["tasks"][0]
    assert result["status"] == ("done" if phase == "result" else "needs_reconciliation")
    assert source.writes == 1
    if phase == "result":
        service.apply("accept", occurrence_id=first["key"])
        assert source.writes == 1 and owner.accepts == 1 and admission.starts == 1
        second = ready(setup)
        assert second["key"] != first["key"] and admission.starts == 2


def test_source_checkoff_ambiguous_history_never_accepts(setup):
    service, source, owner, _ = setup
    first = ready(setup)
    owner.tasks[first["task_id"]] = "result"
    source("complete-occurrence", expected=copy.deepcopy(source.rows[0]))
    source.rows.append(dict(source.rows[-1], id="duplicate-history"))
    result = service.apply("tick")["tasks"][0]
    assert result["status"] == "needs_reconciliation"
    assert owner.accepts == 0 and source.writes == 1


def test_source_checkoff_waits_for_worker_and_recovers_lost_accept(setup):
    from reminders_kanban.execution import UnsupportedControl

    service, source, owner, _ = setup
    first = ready(setup)
    owner.tasks[first["task_id"]] = "result"
    source("complete-occurrence", expected=copy.deepcopy(source.rows[0]))
    accept = owner.accept

    def unsettled(task):
        raise UnsupportedControl("worker still alive")

    owner.accept = unsettled
    assert service.apply("tick")["tasks"][0]["status"] == "result"
    assert owner.accepts == 0

    def lost_response(task):
        accept(task)
        raise RuntimeError("response lost")

    owner.accept = lost_response
    with pytest.raises(RuntimeError):
        service.apply("tick")
    owner.accept = accept
    assert service.apply("tick")["tasks"][0]["status"] == "done"
    assert owner.accepts == source.writes == 1


@pytest.mark.parametrize("phase", ["queued", "active", "result"])
def test_stop_occurrence_http_restart_and_no_advancement(setup, phase):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from reminders_kanban.api import occurrence

    service, source, owner, admission = setup
    if phase == "queued":
        admission.admit = lambda before_dispatch: admission.observe()
    row = ready(setup)
    if phase != "queued":
        owner.tasks[row["task_id"]] = phase
    before = copy.deepcopy(source.rows)
    app = FastAPI()
    app.include_router(occurrence.router)
    app.dependency_overrides[occurrence.service] = lambda: service
    client = TestClient(app)
    body = dict(action="stop", occurrence_id=row["key"])
    response = client.post("/occurrences/actions", json=body)
    assert response.headers["Cache-Control"] == "no-store"
    stopped = response.json()
    assert stopped["outcome"] == "stopped"
    assert (stopped["column"], stopped["label"]) == ("To do", "Stopped")
    stamp = stopped["task"]["stopped_at"]
    assert stamp and stopped["task"]["stop_intent"]
    assert not stopped["task"]["accepted"]
    restarted = OccurrenceDelegation(
        service.home, admission, call=source, control_factory=lambda *_: owner
    )
    assert restarted.apply(**body)["outcome"] == "already_stopped"
    assert restarted.apply("accept", occurrence_id=row["key"])["tasks"][0]["status"] == "stopped"
    final = restarted.apply("tick")["tasks"][0]
    assert final["status"] == "stopped"
    assert final["stopped_at"] == stamp
    assert source.rows == before and source.writes == owner.accepts == 0


def test_stop_reconciles_uncertain_exit_and_durable_intent(setup):
    service, source, owner, _ = setup
    row = ready(setup)
    stop = owner.stop

    def uncertain(task):
        import json
        import sqlite3

        with sqlite3.connect(service.store.path) as db:
            persisted = json.loads(db.execute("SELECT state FROM delegated").fetchone()[0])
        assert persisted["stop_intent"]
        raise RuntimeError("termination response lost")

    owner.stop = uncertain
    result = service.apply("stop", occurrence_id=row["key"])
    assert result["outcome"] == "needs_reconciliation"
    assert result["task"]["stop_intent"]
    assert not result["task"].get("stopped_at")
    owner.stop = stop
    assert service.apply("tick")["tasks"][0]["status"] == "stopped"
    assert service.apply("stop", occurrence_id=row["key"])["outcome"] == "already_stopped"
    assert source.writes == 0


def test_stop_missing_deleted_and_other_owner(setup, tmp_path):
    service, source, owner, admission = setup
    row = ready(setup)
    other = OccurrenceDelegation(
        tmp_path / "other", admission, call=source, control_factory=lambda *_: owner
    )
    assert other.apply("stop", occurrence_id=row["key"])["outcome"] == "not_found"
    assert service.apply("stop", occurrence_id="missing")["outcome"] == "not_found"
    source.rows.clear()
    assert service.apply("stop", occurrence_id=row["key"])["outcome"] == "stopped"


def test_stop_does_not_replay_pending_acceptance(setup):
    service, source, owner, _ = setup
    row = ready(setup)
    owner.tasks[row["task_id"]] = "result"
    with service.store.locked() as db:
        stored = service._rows(db)[0]
        stored.update(accepted=True, accept_intent=True)
        service._save(db, stored)
    assert service.apply("stop", occurrence_id=row["key"])["outcome"] == "stopped"
    service.apply("tick")
    assert source.writes == owner.accepts == 0


def test_stop_fully_completed_occurrence_is_already_finished(setup):
    service, source, owner, _ = setup
    row = ready(setup)
    owner.tasks[row["task_id"]] = "result"
    service.apply("accept", occurrence_id=row["key"])
    before = copy.deepcopy(source.rows)
    assert service.apply("stop", occurrence_id=row["key"])["outcome"] == "already_finished"
    service.apply("tick")
    # Nothing but this install's claim line came off the next date (it is the person's again).
    assert same_but_claims(source.rows[0], before[0]) and source.rows[1:] == before[1:]
    assert source.writes == 1


def test_stop_after_host_acceptance_prevents_completion_replay(setup):
    service, source, owner, admission = setup
    row = ready(setup)
    owner.tasks[row["task_id"]] = "result"

    def interrupted(*args, **kwargs):
        raise RuntimeError("interrupted immediately before completion.accept")

    service.completion.accept = interrupted
    with pytest.raises(RuntimeError, match="interrupted"):
        service.apply("accept", occurrence_id=row["key"])
    assert owner.tasks[row["task_id"]] == "done"
    assert source.writes == 0
    before = copy.deepcopy(source.rows)
    restarted = OccurrenceDelegation(
        service.home, admission, call=source, control_factory=lambda *_: owner
    )
    stopped = restarted.apply("stop", occurrence_id=row["key"])
    assert stopped["outcome"] == "stopped"
    assert stopped["task"]["stop_intent"] and stopped["task"]["stopped_at"]
    assert stopped["task"]["host_accepted"]
    assert not stopped["task"]["accepted"]
    assert restarted.apply("tick")["tasks"][0]["status"] == "stopped"
    restarted.apply("accept", occurrence_id=row["key"])
    assert source.rows == before and source.writes == 0


@pytest.mark.parametrize("http", [False, True])
@pytest.mark.parametrize(
    "case", ["stopped", "due", "rules", "notes", "stale", "identity", "alive", "effects"]
)
def test_explicit_rerun(setup, http, case):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from reminders_kanban.api import occurrence

    service, source, owner, admission = setup
    first = ready(setup)
    if case in {"due", "rules", "notes"}:
        source.rows[0][case] = (
            {"year": 2026, "month": 12, "day": 2}
            if case == "due"
            else ["weekly"]
            if case == "rules"
            else source.rows[0]["notes"] + " Updated instructions"
        )
        service.apply("tick")
    else:
        service.apply("stop", occurrence_id=first["key"])
    expected = copy.deepcopy(source.rows[0])
    if case == "stale":
        source.rows[0]["title"] = "new title"
    if case == "identity":
        source.rows[0]["externalId"] = "replaced"
        expected = copy.deepcopy(source.rows[0])
    if case == "alive":
        owner._workers_stopped = lambda _: False
    if case == "effects":
        observe = owner.observe
        owner.observe = lambda task: dict(observe(task), runs=[{"id": "run", "outcome": "unknown"}])
    app = FastAPI()
    app.include_router(occurrence.router)
    app.dependency_overrides[occurrence.service] = lambda: service
    client = TestClient(app)
    body = dict(action="rerun", occurrence_id=first["key"], expected=expected)

    def apply():
        if http:
            return client.post("/occurrences/actions", json=body).json()
        try:
            return service.apply(**body)
        except (ValueError, KeyError, HelperError) as exc:
            return dict(status="attention", reason=str(exc))

    result = apply()
    if case in {"stale", "identity", "alive", "effects"}:
        assert result["status"] != "ok"
        assert len(owner.tasks) == admission.starts == 1
        if case != "effects":
            return
        service.reconcile_rerun(first["key"], evidence="Inspected run: no external writes")
        result = apply()
    assert result["status"] == "ok", result
    second = result["task"]
    assert second["key"] != first["key"] and second["task_id"] != first["task_id"]
    assert second["scope"] == "this_occurrence"
    assert apply()["task"]["key"] == second["key"]
    assert admission.starts == 2 and len(owner.tasks) == 2
    assert source.rows[0] == expected
    assert source.writes == owner.accepts == 0
    assert result["tasks"][0]["status"] == "stopped"
    assert result["tasks"][0]["stopped_at"]
    assert not source.rows[0]["completed"]


def test_rerun_double_click_and_restart(setup):
    from concurrent.futures import ThreadPoolExecutor

    service, source, owner, admission = setup
    first = ready(setup)
    service.apply("stop", occurrence_id=first["key"])
    body = dict(action="rerun", occurrence_id=first["key"], expected=copy.deepcopy(source.rows[0]))
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda _: service.apply(**body), range(2)))
    assert results[0]["task"]["key"] == results[1]["task"]["key"]
    restarted = OccurrenceDelegation(service.home, admission, call=source,
                                    control_factory=lambda *_: owner)
    assert restarted.apply(**body)["task"]["key"] == results[0]["task"]["key"]
    assert admission.starts == len(owner.tasks) == 2


def test_rerun_refuses_completion_uncertainty(setup):
    service, source, owner, admission = setup
    first = ready(setup)
    owner.tasks[first["task_id"]] = "result"
    source.uncertain = True
    service.apply("accept", occurrence_id=first["key"])
    service.apply("stop", occurrence_id=first["key"])
    service.reconcile_rerun(first["key"], evidence="No external worker effects")
    with pytest.raises(ValueError, match="completion needs reconciliation"):
        service.apply("rerun", occurrence_id=first["key"], expected=source.rows[0])
    assert admission.starts == 1 and source.writes == 1


def test_accepting_rerun_keeps_link_for_next_explicit_occurrence(setup):
    service, source, owner, admission = setup
    first = ready(setup)
    service.apply("stop", occurrence_id=first["key"])
    second = service.apply("rerun", occurrence_id=first["key"],
                           expected=copy.deepcopy(source.rows[0]))["task"]
    owner.tasks[second["task_id"]] = "result"
    service.apply("accept", occurrence_id=second["key"])
    third = ready(setup)
    assert third["destination"] == first["destination"]
    assert source.rows[0]["notes"].count("Open in Hermes:") == 1
    assert admission.starts == 3


def test_get_stored_snapshots_without_helper_or_lifecycle_locks(setup, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from reminders_kanban.api import occurrence

    service, source, owner, admission = setup
    row = ready(setup)
    owner.tasks[row['task_id']] = 'result'
    service.apply('tick')
    expected = copy.deepcopy(source.rows[0])
    source.rows[0]['title'] = 'Changed outside the plugin'
    calls = []

    def forbidden(*args, **kwargs):
        calls.append(args)
        raise AssertionError('GET must not read the helper or acquire lifecycle locks')

    app = FastAPI()
    app.include_router(occurrence.router)
    app.dependency_overrides[occurrence.service] = lambda: service
    with monkeypatch.context() as patch:
        for store in [service.store, service.setup, service.activation_store]:
            patch.setattr(store, 'locked', forbidden)
        patch.setattr(service, 'call', forbidden)
        patch.setattr(admission, 'serialized', forbidden)
        result = TestClient(app).get('/occurrences').json()
    assert calls == []
    assert result['current'] == [expected]
    assert result['observed_at']
    assert result['tasks'][0]['review_available']
    assert result['tasks'][0]['history']['state'] == 'result'
    # A cached snapshot cannot authorize new work against changed source state.
    service.apply('stop', occurrence_id=row['key'])
    response = TestClient(app).post('/occurrences/actions', json={
        'action': 'rerun', 'occurrence_id': row['key'], 'expected': expected,
    }).json()
    assert response['status'] != 'ok'
    assert admission.starts == 1 and source.writes == 0


def test_get_uses_newer_board_observation_and_filters_selected_lists(setup):
    service, source, _, _ = setup
    service.apply('tick')
    fresh = dict(source.rows[0], title='[RK-35] New board observation')
    with service.setup.locked() as db:
        state = service.setup.read(db)
        state.update(cards=[{'source': fresh}, {'source': dict(fresh, calendarId='other')}],
                     observed_at='2099-01-01T00:00:00+00:00')
        service.setup.save(db, state)
    result = service.preview()
    assert result['current'] == [fresh]
    assert result['observed_at'] == '2099-01-01T00:00:00+00:00'
    source.denied = True
    service.apply('tick')
    assert service.preview()['current'] == [fresh]


def test_pickup_off_blocks_successors_but_allows_acceptance(setup):
    service, source, owner, admission = setup
    from test_recurring import enable

    first = enable(setup)
    base = Delegation(service.home, admission, origin=service.origin, call=source,
                      write_link=source.link, control_factory=lambda *_: owner)
    base.apply('deactivate')
    assert service.apply('ready', expected=source.rows[0]) == {'status': 'inactive'}
    assert service.apply('every', expected=source.rows[0]) == {'status': 'inactive'}
    owner.tasks[first['task_id']] = 'result'
    assert service.apply('accept', occurrence_id=first['key'])['tasks'][0]['status'] == 'done'
    for _ in range(2):
        assert len(service.apply('tick')['tasks']) == 1
    assert admission.starts == source.writes == 1
    base.apply('activate')
    service.apply('tick')
    assert len(service.preview()['tasks']) == 2


def test_pickup_off_allows_explicit_rerun_but_holds_its_start(setup):
    service, source, owner, admission = setup
    first = ready(setup)
    base = Delegation(service.home, admission, origin=service.origin, call=source,
                      write_link=source.link, control_factory=lambda *_: owner)
    base.apply('deactivate')
    assert service.apply('stop', occurrence_id=first['key'])['outcome'] == 'stopped'
    body = dict(action='rerun', occurrence_id=first['key'], expected=copy.deepcopy(source.rows[0]))
    second = service.apply(**body)['task']
    assert second['key'] != first['key']
    assert service.apply(**body)['task']['key'] == second['key']
    assert admission.starts == 1
    base.apply('activate')
    service.apply('tick')
    assert admission.starts == 2


def test_deactivate_waits_for_occurrence_pass_and_prevents_later_dispatch(setup):
    import threading
    from concurrent.futures import ThreadPoolExecutor

    service, source, owner, admission = setup
    base = Delegation(service.home, admission, call=source, control_factory=lambda *_: owner)
    entered, release, disabling = threading.Event(), threading.Event(), threading.Event()
    original = admission.admit

    def held_admission(**kwargs):
        entered.set()
        assert release.wait(3)
        return original(**kwargs)

    admission.admit = held_admission
    with ThreadPoolExecutor(2) as pool:
        pending = pool.submit(service.apply, 'ready', expected=copy.deepcopy(source.rows[0]))
        assert entered.wait(2)

        def deactivate():
            disabling.set()
            return base.apply('deactivate')

        off = pool.submit(deactivate)
        assert disabling.wait(2)
        try:
            assert not off.done()
        finally:
            release.set()
        pending.result(timeout=3)
        assert not off.result(timeout=3)['pickup_enabled']
    admission.admit = original
    service.apply('tick')
    assert admission.starts == 1 and owner.tasks['0'] == 'active'


def test_a_pass_holding_admission_never_waits_for_the_one_off_store(setup):
    """A one-off action takes its store, then admission; a repeating pass holds admission when
    it asks whether pickup is on. Waiting for the store there froze both for good."""
    from concurrent.futures import ThreadPoolExecutor

    service, *_ = setup
    with service.activation_store.locked(), ThreadPoolExecutor(1) as pool:
        # An action is in flight: no worker is started on a guess, and the pass moves on.
        assert pool.submit(service._active_to_dispatch, None).result(timeout=2) is False
        # Reads that only report pickup's state use the last committed value.
        assert pool.submit(service._active, None).result(timeout=2) is True
    assert service._active_to_dispatch(None) is True


def _accept_first(setup):
    service, _, owner, _ = setup
    first = ready(setup)
    owner.tasks[first["task_id"]] = "result"
    assert service.apply("accept", occurrence_id=first["key"])["tasks"][0]["status"] == "done"
    return first


@pytest.mark.parametrize("action", ["ready", "every"])
@pytest.mark.parametrize(
    "change", ["untouched", "edited", "notes_rewritten", "checked_off_by_hand"])
def test_a_reminder_can_be_delegated_again_after_an_accepted_occurrence(setup, action, change):
    """Once an occurrence was accepted, any later touch of the reminder used to make every
    further delegation fail with "successor needs reconciliation", for good."""
    service, source, *_ = setup
    first = _accept_first(setup)
    if change == "edited":
        source.rows[0]["notes"] = "This week: focus on X\n\n" + (source.rows[0]["notes"] or "")
    elif change == "notes_rewritten":
        # The whole note replaced, task link line and all.
        source.rows[0]["notes"] = "This week: focus on X"
    elif change == "checked_off_by_hand":
        done = copy.deepcopy(source.rows[0])
        done.update(id="hand-1", completed=True)
        source.rows.append(done)
        source.rows[0]["due"] = {"year": 2026, "month": 11, "day": 8}
    service.apply("tick")
    if action == "every":
        # The fake source answers the schedule read an Every occurrence delegation makes.
        from datetime import UTC, datetime

        original = service.call

        def call(op, **kwargs):
            if op == "occurrence-schedule":
                due = source.rows[0]["due"]
                return dict(due_at=datetime(
                    due["year"], due["month"], due["day"], tzinfo=UTC).timestamp())
            return original(op, **kwargs)

        service.call = call
        service.clock = lambda: datetime(2026, 12, 1, tzinfo=UTC).timestamp()
    row = service.apply(action, expected=copy.deepcopy(source.rows[0]))["tasks"][-1]
    assert row["key"] != first["key"] and row["status"] != "done"
    assert row["scope"] == ("every_occurrence" if action == "every" else "this_occurrence")


def test_finished_occurrences_are_not_read_from_hermes_again(setup):
    """Every poll used to re-read each task ever run; an accepted one cannot change."""
    from reminders_kanban.workflow.attention import Attention

    service, _, owner, _ = setup
    first = _accept_first(setup)

    def gone(task_id):
        raise AssertionError(f"read finished task {task_id}")

    owner.observe = gone
    row = next(r for r in service.preview()["tasks"] if r["key"] == first["key"])
    assert row["state"] == "done" and row["required_action"] is None
    assert row["review_available"] is False and row["history"] is None
    task = next(t for t in Attention(service).feed()["tasks"] if t["task_id"] == first["task_id"])
    assert task["state"] == "done" and task["attention"] is None
    assert task["history"]["task"]["title"] == first["expected"]["title"]
