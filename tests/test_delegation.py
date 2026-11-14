import copy
import sqlite3
from contextlib import contextmanager
from datetime import UTC
from types import SimpleNamespace

import pytest

from reminders_kanban.reminders.helper import HelperError
from reminders_kanban.workflow.delegation import Delegation


class Source:
    def __init__(self):
        self.rows = [
            dict(
                id="a",
                externalId="ext",
                calendarId="list",
                title="Task",
                notes="My notes",
                url="https://original.example",
                due=None,
                rules=[],
                completed=False,
                modified="before",
            )
        ]
        self.writes = 0
        self.denied = False
        self.uncertain = False

    def __call__(self, op, **fields):
        if self.denied:
            raise HelperError("access_denied", "denied")
        if op == "lists":
            return [dict(id="list", writable=True)]
        if op in {"read_many", "completion-read"}:
            return copy.deepcopy(self.rows)
        row = next((r for r in self.rows if r["id"] == fields.get("id", "a")), None)
        if row is None:
            raise HelperError("not_found", "deleted")
        if op == "read":
            return copy.deepcopy(row)
        assert op == "complete-occurrence"
        assert fields["expected"] == row
        self.writes += 1
        if self.uncertain:
            raise HelperError("uncertain", "timeout")
        row["completed"] = True

    def link(self, expected, notes):
        assert self.rows[0] == expected
        self.rows[0]["notes"] = notes
        return copy.deepcopy(self.rows[0])


class Owner:
    def __init__(self):
        self.tasks = {}
        self.keys = {}
        self.accepts = 0

    def create(self, key, title, body, **kwargs):
        if key not in self.keys:
            self.keys[key] = str(len(self.tasks))
            self.tasks[self.keys[key]] = "ready"
        return self.keys[key]

    def observe(self, task):
        return dict(state=self.tasks[task])

    def _workers_stopped(self, task):
        return True

    def pause(self, task):
        self.tasks[task] = "paused"
        return dict(worker_stop_verified=True)

    def stop(self, task):
        self.tasks[task] = "stopped"
        return dict(worker_stop_verified=True)

    def accept(self, task):
        assert self.tasks[task] == "result"
        self.tasks[task] = "done"
        self.accepts += 1
        return True

    def comment(self, *args):
        pass

    def resume(self, task):
        self.tasks[task] = "ready"
        return True


class Admission:
    board = "rk-test-12"
    kb = SimpleNamespace(get_task=lambda _, task: SimpleNamespace(id=task))

    def __init__(self, owner):
        self.owner = owner
        self.conn = sqlite3.connect(":memory:", check_same_thread=False)
        self.conn.execute("CREATE TABLE rk_admission (task_id TEXT, park_event INTEGER)")
        self.queue = set()
        self.starts = 0

    @contextmanager
    def serialized(self):
        yield self.conn

    reading = serialized

    def _parked(self, conn, task):
        return task.id in self.queue

    def hold(self, conn, task):
        self.owner.tasks[task] = "paused"
        self.queue.discard(task)

    def observe(self):
        return dict(effective_limit=3)

    def ready(self, task, **kwargs):
        self.queue.add(task)
        self.owner.tasks[task] = "paused"

    def admit(self, before_dispatch):
        for task in list(self.queue):
            if before_dispatch(self.conn, task):
                self.owner.tasks[task] = "active"
                self.starts += 1
                self.queue.remove(task)
        return self.observe()


@pytest.fixture
def setup(tmp_path):
    source, owner = Source(), Owner()
    admission = Admission(owner)
    service = Delegation(
        tmp_path,
        admission,
        origin="https://owner.example",
        call=source,
        write_link=source.link,
        control_factory=lambda *_: owner,
    )
    with service.setup.locked() as db:
        state = service.setup.read(db)
        state.update(selected_list_ids=["list"], selection_saved=True)
        service.setup.save(db, state)
    return service, source, owner, admission


def ready(setup):
    service, source, owner, admission = setup
    expected = copy.deepcopy(source.rows[0])
    service.apply("activate")
    service.apply("ready", expected=expected)
    service.apply("tick")
    return expected


def test_import_activation_ready_restart_and_accept(setup):
    service, source, owner, admission = setup
    assert not service.preview()["pickup_enabled"]
    service.apply("activate")
    assert not owner.tasks
    expected = ready(setup)
    service.apply("ready", expected=expected)
    service.apply("activate")
    assert admission.starts == 1 and len(owner.tasks) == 1
    assert source.rows[0]["notes"].count("Open in Hermes:") == 1
    assert source.rows[0]["url"] == expected["url"]
    owner.tasks["0"] = "result"
    service.apply("tick")
    assert source.writes == 0
    restarted = Delegation(service.home, admission, call=source, control_factory=lambda *_: owner)
    restarted.apply("accept", expected=expected)
    restarted.apply("accept", expected=expected)
    assert source.writes == owner.accepts == 1
    assert restarted.preview()["tasks"][0]["status"] == "done"


def test_failed_activation_does_not_enable(setup):
    service, source, owner, admission = setup
    source.denied = True
    with pytest.raises(HelperError):
        service.apply("activate")
    source.denied = False
    assert not service.preview()["pickup_enabled"]
    service.write_link = None
    assert service.apply("activate")["status"] == "setup_required"
    assert not service.preview()["pickup_enabled"]
    assert not owner.tasks


@pytest.mark.parametrize("phase,accepted", [("active", False), ("result", True)])
def test_source_completion_distinguishes_running_and_review(setup, phase, accepted):
    service, source, owner, admission = setup
    ready(setup)
    owner.tasks["0"] = phase
    source.rows[0]["completed"] = True
    result = service.apply("tick")["tasks"][0]
    assert result["accepted"] == accepted
    assert result["status"] == ("done" if accepted else "stopped")
    assert source.writes == 0


def test_deleted_source_stops(setup):
    service, source, owner, admission = setup
    ready(setup)
    source.rows.clear()
    assert service.apply("tick")["tasks"][0]["status"] == "deleted"
    assert owner.tasks["0"] == "stopped"


def test_uncertain_completion_never_rewrites(setup):
    service, source, owner, admission = setup
    expected = ready(setup)
    owner.tasks["0"] = "result"
    source.uncertain = True
    service.apply("accept", expected=expected)
    service.apply("accept", expected=expected)
    assert source.writes == 1
    assert service.preview()["tasks"][0]["status"] == "needs_reconciliation"
    source.rows[0]["completed"] = True
    assert service.apply("tick")["tasks"][0]["status"] == "done"


def test_instruction_resume_requires_owner_reconciliation(setup):
    service, source, owner, admission = setup
    expected = ready(setup)
    source.rows[0]["notes"] += "\nChanged instructions"
    service.apply("tick")
    assert owner.tasks["0"] == "paused"
    service.apply("resume", expected=expected, instruction_version=2)
    assert admission.starts == 1
    service._guard(owner).reconcile("0", instruction_version=2, evidence="No external effects")
    service.apply("resume", expected=expected, instruction_version=2)
    assert admission.starts == 2


def test_resumed_instructions_can_be_accepted(setup):
    service, source, owner, admission = setup
    expected = ready(setup)
    source.rows[0]["notes"] += "\nNew instruction"
    service.apply("tick")
    service._guard(owner).reconcile("0", instruction_version=2, evidence="No external effects")
    service.apply("resume", expected=expected, instruction_version=2)
    service.apply("resume", expected=expected, instruction_version=2)
    assert admission.starts == 2
    owner.tasks["0"] = "result"
    assert service.apply("accept", expected=expected)["tasks"][0]["status"] == "done"


def test_removed_selection_stops_execution(setup):
    service, source, owner, admission = setup
    ready(setup)
    with service.setup.locked() as db:
        state = service.setup.read(db)
        state["selected_list_ids"] = []
        service.setup.save(db, state)
    assert service.apply("tick")["tasks"][0]["status"] == "paused"
    assert owner.tasks["0"] == "paused"


@pytest.mark.parametrize(
    "field,value",
    [("title", "Changed"), ("due", {"day": 5}), ("externalId", "other"), ("rules", ["daily"])],
)
def test_changed_completed_source_does_not_accept_review(setup, field, value):
    service, source, owner, admission = setup
    ready(setup)
    owner.tasks["0"] = "result"
    source.rows[0].update({field: value, "completed": True})
    result = service.apply("tick")["tasks"][0]
    assert not result["accepted"]
    assert owner.accepts == 0
    assert result["status"] == ("paused" if field == "externalId" else "stopped")


def test_priority_edit_still_completes_review_once(setup):
    service, source, owner, admission = setup
    expected = ready(setup)
    owner.tasks["0"] = "result"
    source.rows[0]["priority"] = 1
    result = service.apply("accept", expected=expected)["tasks"][0]
    assert result["status"] == "done"
    service.apply("accept", expected=expected)
    assert source.writes == owner.accepts == 1


def test_link_conflict_stays_parked_and_can_recover(setup):
    service, source, owner, admission = setup
    service.apply("activate")
    original = copy.deepcopy(source.rows[0])
    target = []

    def uncertain(expected, notes):
        target.append(notes)
        raise HelperError("uncertain", "late save")

    service.write_link = uncertain
    with pytest.raises(HelperError):
        service.apply("ready", expected=original)
    assert owner.tasks["0"] == "paused"
    result = service.apply("tick")
    assert result["tasks"][0]["status"] == "preparation_attention"
    assert admission.starts == 0
    source.rows[0]["notes"] = target[0]
    service.apply("tick")
    assert len(target) == 1
    assert admission.starts == 1


def test_stop_replay_and_refresh_never_restart_or_complete(setup):
    service, source, owner, admission = setup
    expected = ready(setup)
    response = service.stop("0")
    assert response["outcome"] == "stopped"
    assert response["column"] == "To do" and response["label"] == "Stopped"
    assert response["reminder_owner"] == "human"
    assert not source.rows[0]["completed"] and source.writes == 0
    owner.stop = lambda _: pytest.fail("duplicate stop")
    restarted = Delegation(service.home, admission, call=source, control_factory=lambda *_: owner)
    assert restarted.stop("0")["outcome"] == "already_stopped"
    restarted.apply("tick")
    restarted.apply("resume", expected=expected, instruction_version=1)
    restarted.apply("accept", expected=expected)
    assert restarted.preview()["tasks"][0]["state"] == "stopped"
    assert admission.starts == 1 and source.writes == 0


@pytest.mark.parametrize(
    "state,outcome",
    [("done", "already_finished"), ("stopped", "already_stopped"), ("deleted", "already_deleted")],
)
def test_stop_terminal_noops(setup, state, outcome):
    service, source, owner, admission = setup
    ready(setup)
    if state == "deleted":
        source.rows.clear()
        service.apply("tick")
    else:
        owner.tasks["0"] = state
    owner.stop = lambda _: pytest.fail("terminal task must not be stopped again")
    assert service.stop("0")["outcome"] == outcome
    assert source.writes == 0


def test_stop_lost_response_reconciles_termination_only(setup):
    service, source, owner, admission = setup
    ready(setup)
    original = owner.stop

    def lost(task):
        original(task)
        raise TimeoutError("lost receipt")

    owner.stop = lost
    assert service.stop("0")["outcome"] == "needs_reconciliation"
    assert service.preview()["tasks"][0]["required_action"] == "reconcile"
    assert service.preview()["tasks"][0]["stopped_at"] is None
    owner.stop = original
    assert service.stop("0")["outcome"] == "stopped"
    assert service.stop("0")["outcome"] == "already_stopped"
    assert admission.starts == 1 and source.writes == 0


def test_stop_route_scopes_id_and_disables_cache(setup):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from reminders_kanban.api.delegation import router
    from reminders_kanban.api.delegation import service as dependency

    service, source, owner, admission = setup
    ready(setup)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[dependency] = lambda: service
    client = TestClient(app)
    assert client.post("/delegation/foreign/stop").json()["outcome"] == "not_found"
    response = client.post("/delegation/0/stop")
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["outcome"] == "stopped"


def test_terminal_stop_does_not_reread_source(setup):
    service, source, owner, admission = setup
    ready(setup)
    service.stop("0")
    owner.stop = lambda _: pytest.fail("verified stop must not repeat")
    source.rows.clear()
    row = service.apply("tick")["tasks"][0]
    assert row["status"] == "stopped"
    assert row["stop_receipt"]["worker_stop_verified"] and row["stop_intent"]
    assert service.preview()["tasks"][0]["state"] == "stopped"
    assert service.stop("0")["outcome"] == "already_stopped"
    assert admission.starts == 1 and source.writes == 0


@pytest.mark.parametrize("running", [False, True], ids=["queued", "running"])
def test_stop_timestamp_persists_in_delegation_and_attention(setup, monkeypatch, running):
    from datetime import datetime

    from reminders_kanban.workflow.attention import Attention

    service, source, owner, admission = setup
    if not running:
        monkeypatch.setattr(admission, "admit", lambda **_: admission.observe())
    monkeypatch.setattr(admission.kb, "list_events", lambda *_: [], raising=False)
    ready(setup)
    assert admission.starts == int(running)
    before = datetime.now(UTC)
    response = service.stop("0")
    stopped_at = response["task"]["stopped_at"]
    parsed = datetime.fromisoformat(stopped_at)
    assert parsed.utcoffset().total_seconds() == 0
    assert before <= parsed <= datetime.now(UTC)
    restarted = Delegation(service.home, admission, call=source, control_factory=lambda *_: owner)
    owner.stop = lambda _: pytest.fail("duplicate stop")
    repeated = restarted.stop("0")
    assert repeated["outcome"] == "already_stopped"
    assert repeated["task"]["stopped_at"] == stopped_at
    assert restarted.apply("tick")["tasks"][0]["stopped_at"] == stopped_at
    assert restarted.preview()["tasks"][0]["stopped_at"] == stopped_at
    assert Attention(restarted).feed()["tasks"][0]["stopped_at"] == stopped_at
    assert admission.starts == int(running) and source.writes == 0


def test_explicit_ready_after_stop_keeps_history(setup):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from reminders_kanban.api import delegation

    service, source, owner, admission = setup
    ready(setup)
    stopped = service.stop("0")
    assert stopped["column"] == "To do"
    app = FastAPI()
    app.include_router(delegation.router)
    app.dependency_overrides[delegation.service] = lambda: service
    client = TestClient(app)
    body = dict(action="ready", expected=copy.deepcopy(source.rows[0]))
    result = client.post("/delegation/actions", json=body).json()
    assert result["status"] == "ok", result
    assert len(result["tasks"]) == 2
    assert result["tasks"][0]["stopped_at"] == stopped["task"]["stopped_at"]
    assert (
        client.post("/delegation/actions", json=body).json()["tasks"][-1]["key"]
        == result["tasks"][-1]["key"]
    )
    service.apply("tick")
    assert admission.starts == 2 and source.writes == 0
    assert source.rows[0]["notes"].count("Open in Hermes:") == 1


@pytest.mark.parametrize("case", ["stale", "identity", "alive", "effects", "recurring"])
def test_reready_refuses_unsafe_source_or_effects(setup, case):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from reminders_kanban.api import delegation

    service, source, owner, admission = setup
    ready(setup)
    service.stop("0")
    expected = copy.deepcopy(source.rows[0])
    if case == "stale":
        source.rows[0]["title"] = "changed"
    elif case == "identity":
        source.rows[0]["externalId"] = "replacement"
        expected = copy.deepcopy(source.rows[0])
    elif case == "alive":
        owner._workers_stopped = lambda _: False
    elif case == "effects":
        observe = owner.observe
        owner.observe = lambda task: dict(observe(task), runs=[{"id": 1}])
    else:
        source.rows[0]["rules"] = ["daily"]
        expected = copy.deepcopy(source.rows[0])
    app = FastAPI()
    app.include_router(delegation.router)
    app.dependency_overrides[delegation.service] = lambda: service
    response = TestClient(app).post(
        "/delegation/actions", json=dict(action="ready", expected=expected)
    )
    assert response.json()["status"] != "ok"
    assert admission.starts == len(owner.tasks) == 1 and source.writes == 0


@pytest.mark.parametrize("action", ["stop", "accept", "run_again"])
def test_action_does_not_wait_for_background_snapshot(setup, action):
    import threading
    from concurrent.futures import ThreadPoolExecutor

    service, source, owner, admission = setup
    expected = ready(setup)
    if action == "accept":
        owner.tasks["0"] = "result"
    if action == "run_again":
        service.stop("0")
        observe = owner.observe
        owner.observe = lambda task: dict(observe(task), runs=[dict(id="run", ended_at=1)])
        background_source = dict(source.rows[0], id="b", externalId="background",
                                 notes="Background")
        source.rows.append(background_source)
        owner.tasks["background"] = "active"
        service._guard(owner).bind("background", background_source)
        with service.store.locked() as db:
            service._save(db, dict(expected=background_source, source=background_source,
                                   key="background", task_id="background", status="active",
                                   accepted=False, resources=[]))
    entered, release = threading.Event(), threading.Event()
    original = service.call

    def held_read(op, **fields):
        if threading.current_thread().name.startswith("background") and op == "read_many":
            result = original(op, **fields)
            entered.set()
            assert release.wait(5)
            return result
        return original(op, **fields)

    service.call = held_read
    with ThreadPoolExecutor(thread_name_prefix="background") as background:
        pending = background.submit(service.apply, "tick")
        assert entered.wait(2)
        try:
            with ThreadPoolExecutor() as actions:
                if action == "stop":
                    result = actions.submit(service.stop, "0").result(timeout=1)
                    assert result["task"]["status"] == "stopped"
                elif action == "accept":
                    result = actions.submit(service.apply, "accept", expected=expected).result(1)
                    assert result["tasks"][0]["status"] == "done"
                else:
                    def rerun():
                        consent = service.confirm_rerun(task_id="0", run_id="run")
                        assert consent["status"] == "ok"
                        return service.apply("ready", expected=copy.deepcopy(source.rows[0]))
                    result = actions.submit(rerun).result(1)
                    assert any(r["status"] == "ready" for r in result["tasks"])
        finally:
            release.set()
        pending.result(timeout=2)
    if action != "run_again":
        wanted = "stopped" if action == "stop" else "done"
        assert service.preview()["tasks"][0]["status"] == wanted
    assert admission.starts == 1


def test_stale_accept_cannot_override_stop_intent(setup):
    service, source, owner, _ = setup
    expected = ready(setup)
    service.stop("0")
    owner.tasks["0"] = "result"
    service.apply("accept", expected=expected)
    assert source.writes == owner.accepts == 0
    assert service.preview()["tasks"][0]["status"] == "stopped"


def test_stop_does_not_require_reminders_access(setup):
    service, _, _, _ = setup
    ready(setup)
    service.call = lambda *args, **kwargs: pytest.fail("Stop must not wait for Reminders")
    assert service.stop("0")["outcome"] == "stopped"


def test_pickup_off_route_is_idempotent_durable_and_does_not_import(setup):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from reminders_kanban.api import delegation

    service, source, owner, admission = setup
    source.rows[0]['title'] = '[Agent · Ready] Task'
    original = copy.deepcopy(source.rows)
    app = FastAPI()
    app.include_router(delegation.router)
    app.dependency_overrides[delegation.service] = lambda: service
    client = TestClient(app)
    for _ in range(2):
        response = client.post('/delegation/actions', json={'action': 'deactivate'})
        assert response.status_code == 200
        assert response.json()['pickup_enabled'] is False
    restarted = Delegation(service.home, admission, call=source, control_factory=lambda *_: owner)
    assert not restarted.preview()['pickup_enabled']
    assert restarted.apply('ready', expected=source.rows[0]) == {'status': 'inactive'}
    restarted.apply('tick')
    assert not owner.tasks and source.rows == original
    service.apply('activate')
    assert admission.starts == 1


def test_pickup_off_holds_queue_then_reactivates_same_task(setup):
    service, source, owner, admission = setup
    service.apply('activate')
    row = service.apply('ready', expected=copy.deepcopy(source.rows[0]))['tasks'][0]
    original = copy.deepcopy(source.rows)
    service.apply('deactivate')
    restarted = Delegation(service.home, admission, call=source, control_factory=lambda *_: owner)
    assert not restarted.preview()['pickup_enabled']
    for _ in range(2):
        assert not service.apply('tick')['pickup_enabled']
    assert admission.starts == 0 and source.rows == original
    assert service.apply('activate')['tasks'][0]['key'] == row['key']
    assert admission.starts == 1 and len(owner.tasks) == 1


def test_pickup_off_keeps_running_observation_and_acceptance(setup):
    service, source, owner, admission = setup
    expected = ready(setup)
    service.apply('deactivate')
    assert owner.tasks['0'] == 'active'
    owner.tasks['0'] = 'question'
    assert service.apply('tick')['tasks'][0]['status'] == 'question'
    owner.tasks['0'] = 'result'
    assert service.apply('tick')['tasks'][0]['status'] == 'result'
    assert service.apply('accept', expected=expected)['tasks'][0]['status'] == 'done'
    assert source.writes == owner.accepts == admission.starts == 1


def test_pickup_off_still_observes_source_stop(setup):
    service, source, owner, admission = setup
    ready(setup)
    service.apply('deactivate')
    source.rows[0]['completed'] = True
    assert service.apply('tick')['tasks'][0]['status'] == 'stopped'
    assert owner.tasks['0'] == 'stopped' and admission.starts == 1


def test_pickup_off_resume_and_stop_keep_existing_task_controls(setup):
    service, source, owner, admission = setup
    expected = ready(setup)
    service.apply('deactivate')
    source.rows[0]['notes'] += '\nChanged instructions'
    service.apply('tick')
    service._guard(owner).reconcile('0', instruction_version=2, evidence='No external effects')
    response = service.apply('resume', expected=expected, instruction_version=2)
    assert response['tasks'][0]['guard']['status'] == 'active'
    assert not response['pickup_enabled'] and admission.starts == 1
    assert '0' in admission.queue
    assert service.stop('0')['outcome'] == 'stopped'
    observe = owner.observe
    owner.observe = lambda task: dict(observe(task), runs=[dict(id='run', ended_at=1)])
    assert service.apply('confirm_rerun', task_id='0', run_id='run')['status'] == 'ok'


def test_pickup_off_defers_interrupted_preparation(setup):
    service, source, owner, admission = setup
    service.apply('activate')
    service.write_link = lambda *_: (_ for _ in ()).throw(HelperError('uncertain', 'lost'))
    with pytest.raises(HelperError):
        service.apply('ready', expected=copy.deepcopy(source.rows[0]))
    service.apply('deactivate')
    service._prepare = lambda *_: pytest.fail('preparation while pickup is off')
    service.apply('tick')
    assert admission.starts == 0


def test_activation_schema_upgrade_preserves_enabled_board(setup):
    service, source, owner, admission = setup
    with service.store.locked() as db:
        db.execute('DROP TABLE activation')
        db.execute('CREATE TABLE activation (id INTEGER PRIMARY KEY, board TEXT)')
        db.execute('INSERT INTO activation VALUES (1, ?)', (admission.board,))
        db.commit()
    restarted = Delegation(service.home, admission, call=source, control_factory=lambda *_: owner)
    assert restarted.preview()['pickup_enabled']
    restarted.apply('deactivate')
    assert not restarted.preview()['pickup_enabled']


def test_tick_passes_follow_open_work_not_history(setup):
    service, source, owner, admission = setup
    ready(setup)
    passes, real = [], service._tick

    def counted(db, *, keys=None):
        passes.append(keys)
        return real(db, keys=keys)

    service._tick = counted
    key = service.preview()["tasks"][0]["key"]
    service.apply("tick")
    assert passes == [{key}]  # Open work: its own pass.
    service.stop("0")
    passes.clear()
    assert service.apply("tick")["tasks"][0]["status"] == "stopped"
    # Finished: no pass of its own, only the one that keeps admission moving.
    assert passes == [{None}]
