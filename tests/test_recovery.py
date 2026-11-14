import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from reminders_kanban.api import recovery as api
from reminders_kanban.api.delegation import service
from reminders_kanban.execution.recovery import Recovery


class Control:
    backend = SimpleNamespace(_resolve_rate_limit_cooldown_seconds=lambda: 300)

    def __init__(self, code=75, outcome="rate_limited"):
        self.observed = dict(state="paused", host_status="scheduled", runs=[dict(
            id=1, ended_at=int(time.time()) - 301, outcome=outcome,
            metadata=dict(exit_code=code))])
        self.alive = False
        self.comments = []

    def observe(self, task):
        return self.observed

    def _workers_stopped(self, task):
        return not self.alive

    def comment(self, *args):
        if args not in self.comments:
            self.comments.append(args)


@pytest.mark.parametrize('cause,code,outcome', [
    ('capacity', 75, 'rate_limited'), ('balance', 75, 'rate_limited'),
    ('access', 78, 'crashed'), ('ordinary', 1, 'crashed')])
def test_policy_and_restart(cause, code, outcome):
    control = Control(code, outcome)
    row = dict(task_id='t')
    recovery = Recovery(control)
    assert not recovery.permit(row)
    assert row['recovery']['action'] == 'reconcile'
    recovery.reconcile(row, run_id=1, evidence='No external writes in inspected worker',
                       cause=cause if code == 75 else None)
    recovery = Recovery(control)
    assert row['recovery']['column'] == ('In progress' if cause == 'capacity' else 'Needs you')
    if cause == 'access':
        assert not recovery.permit(row)
        recovery.reconcile(row, run_id=1, evidence='No external writes; access verified',
                           access_repaired=True)
    if cause == 'ordinary':
        assert not recovery.permit(row)
        assert not recovery.permit(row, deliberate=True, run_id=2)
        assert recovery.permit(row, deliberate=True, run_id=1)
    assert recovery.permit(row)
    assert recovery.permit(row)
    assert len(control.comments) == 1
    control.observed['runs'][-1]['id'] = 2
    assert not recovery.permit(row)
    assert row['recovery']['reconciliation'] == 'required'


def test_cooldown_and_surviving_worker():
    control = Control()
    row = dict(task_id='t')
    recovery = Recovery(control)
    control.alive = True
    with pytest.raises(ValueError, match='worker still alive'):
        recovery.reconcile(row, run_id=1, evidence='Inspected')
    assert row['recovery']['occupied']
    control.alive = False
    control.observed['runs'][-1]['ended_at'] = int(time.time())
    recovery.reconcile(row, run_id=1, evidence='Inspected')
    assert not recovery.permit(row)
    assert row['recovery']['next_check_at']
    control.observed.update(state='active', host_status='running')
    assert recovery.observe(row).get('recovery') is None


def test_explicit_transient_block_never_automatically_retries():
    control = Control(None, 'blocked')
    control.observed['state'] = 'failed'
    row = dict(task_id='t')
    recovery = Recovery(control)
    recovery.reconcile(row, run_id=1, evidence='Inspected explicit block')
    assert row['recovery']['cause'] == 'ordinary'
    assert not recovery.permit(row)


def test_frontend_cannot_supply_reconciliation_or_owner():
    app = FastAPI()
    app.include_router(api.router)
    app.dependency_overrides[service] = lambda: None
    client = TestClient(app)
    assert client.get('/recovery').json()['status'] == 'setup_required'
    for field in ('evidence', 'board', 'access_repaired', 'cause'):
        assert client.post('/recovery/actions', json={
            'action': 'retry', 'source_id': 'a', 'run_id': 1, field: 'forged'
        }).status_code == 422


@pytest.mark.parametrize('pickup_enabled', [True, False])
@pytest.mark.parametrize('outcome', ['reclaimed', 'timed_out', 'future_interruption'])
def test_interruption_recovered_by_admission_requires_receipt_and_retry(
    tmp_path, outcome, pickup_enabled
):
    from test_delegation import Admission, Owner, Source

    from reminders_kanban.execution.recovery import reconcile
    from reminders_kanban.workflow.delegation import Delegation

    class InterruptedOwner(Owner):
        runs = []

        def observe(self, task):
            return dict(state=self.tasks[task], runs=self.runs)

        def _workers_stopped(self, task):
            return True

    class ReclaimingAdmission(Admission):
        reclaim = False

        def admit(self, before_dispatch):
            if self.reclaim:
                # Native maintenance runs after the workflow's initial observation.
                self.reclaim = False
                owner.runs = [dict(id=1, ended_at=int(time.time()), outcome=outcome)]
                self.ready(task)
            return super().admit(before_dispatch)

    owner, source = InterruptedOwner(), Source()
    admission = ReclaimingAdmission(owner)
    workflow = Delegation(tmp_path, admission, origin='https://owner.example',
                          call=source, write_link=source.link, control_factory=lambda *_: owner)
    with workflow.setup.locked() as db:
        state = workflow.setup.read(db)
        state.update(selected_list_ids=['list'], selection_saved=True)
        workflow.setup.save(db, state)
    workflow.apply('activate')
    result = workflow.apply('ready', expected=dict(source.rows[0]))
    workflow.apply('tick')
    task = result['tasks'][0]['task_id']
    assert admission.starts == 1
    admission.reclaim = True
    result = workflow.apply('tick')
    assert admission.starts == 1
    state = result['tasks'][0]['recovery']
    assert state['cause'] == 'ordinary' and state['action'] == 'reconcile'
    # A synthetic scheduling receipt cannot hide the interrupted run.
    owner.runs.append(dict(id=2, ended_at=int(time.time()), outcome='scheduled'))
    admission.ready(task)
    assert workflow.apply('tick')['tasks'][0]['recovery']['run_id'] == 1
    assert admission.starts == 1
    reconcile(workflow, 'a', run_id=1, evidence='Verified prior external writes; finish review')
    admission.ready(task)
    workflow.apply('tick')
    assert admission.starts == 1
    if not pickup_enabled:
        workflow.apply('deactivate')
    response = api.retry(workflow, 'a', 1)
    assert response['status'] == 'ok'
    if not pickup_enabled:
        assert response['tasks'][0]['recovery']['authorized']
        assert admission.starts == 1 and task in admission.queue
        workflow.apply('activate')
    assert admission.starts == 2


def test_retry_acts_on_the_current_run_not_the_stopped_one_kept_beside_it():
    from contextlib import contextmanager

    seen = []

    @contextmanager
    def held():
        yield object()

    stopped = {"key": "old", "storage_key": "old", "expected": {"id": "a"}, "task_id": "t_old"}
    current = {"key": "new", "expected": {"id": "a"}, "task_id": "t_new",
               "guard": {"status": "paused"}}
    owner = SimpleNamespace(
        store=SimpleNamespace(locked=held),
        admission=SimpleNamespace(serialized=held, kb=None),
        control_factory=lambda conn, kb: Control(),
        _active=lambda db: True,
        _rows=lambda db: [stopped, current],
        _observe=lambda db, row, conn: seen.append(row["key"]) or row,
    )
    assert api.retry(owner, "a", 1)["task"]["key"] == "new"
    assert seen == ["new"]
