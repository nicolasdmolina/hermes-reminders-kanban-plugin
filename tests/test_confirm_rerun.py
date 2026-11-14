import copy

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from test_delegation import Admission, Owner, Source
from test_occurrence import RecurringSource

from reminders_kanban.api import delegation, occurrence
from reminders_kanban.reminders.helper import HelperError
from reminders_kanban.workflow.delegation import Delegation
from reminders_kanban.workflow.occurrence import OccurrenceDelegation


@pytest.mark.parametrize('recurring', [False, True])
@pytest.mark.parametrize('http', [False, True])
@pytest.mark.parametrize('case', ['success', 'stale', 'alive', 'identity', 'copied', 'new_run',
                                  'nonterminal', 'completion', 'paused', 'paused_result'])
def test_confirmation(tmp_path, recurring, http, case):
    source, worker = (RecurringSource() if recurring else Source()), Owner()
    admission = Admission(worker)
    kwargs = dict(call=source, write_link=source.link, origin='https://owner.example',
                  control_factory=lambda *_: worker)
    base = Delegation(tmp_path, admission, **kwargs)
    with base.setup.locked() as db:
        state = base.setup.read(db)
        state.update(selected_list_ids=['list'], selection_saved=True)
        base.setup.save(db, state)
    base.apply('activate')
    service = OccurrenceDelegation(tmp_path, admission, **kwargs) if recurring else base
    row = service.apply('ready', expected=copy.deepcopy(source.rows[0]))['tasks'][0]
    service.apply('tick')
    runs = [dict(id=1, ended_at=123, outcome='interrupted')]
    observe = worker.observe
    worker.observe = lambda task: dict(
        observe(task), runs=copy.deepcopy(runs) if task == row['task_id'] else [],
                                      summary='Some work', comments=['Retained comment'])
    if case in {'paused', 'paused_result'} and recurring:
        if case == 'paused_result':
            worker.tasks[row['task_id']] = 'result'
        source.rows[0]['due'] = dict(year=2027, month=1, day=1)
        service.apply('tick')
    else:
        service.stop(row['task_id'])
    api = occurrence if recurring else delegation
    path = '/occurrences/actions' if recurring else '/delegation/actions'
    app = FastAPI()
    app.include_router(api.router)
    app.dependency_overrides[api.service] = lambda: service
    client = TestClient(app)

    def apply(body):
        if http:
            response = client.post(path, json=body)
            assert response.status_code == 200
            assert response.headers['cache-control'] == 'no-store'
            return response.json()
        try:
            return service.apply(**body)
        except (ValueError, HelperError) as exc:
            return dict(status='attention', reason=str(exc))

    body = dict(action='confirm_rerun', run_id=1, **(
        dict(occurrence_id=row['key']) if recurring else dict(task_id=row['task_id'])))
    rerun = dict(action='rerun' if recurring else 'ready',
                 expected=copy.deepcopy(source.rows[0]))
    if recurring:
        rerun['occurrence_id'] = row['key']
    if case in {'paused', 'paused_result'} and recurring:
        before = service.preview()['tasks'][0]
        assert apply(rerun)['status'] == 'attention'
        assert service.preview()['tasks'][0] == before
        assert apply(body)['reason'] == 'verified_stop_required'
        service.stop(row['task_id'])
    if case == 'stale':
        body['run_id'] = 'old-run'
    elif case == 'alive':
        worker._workers_stopped = lambda _: False
    elif case == 'identity':
        source.rows[0]['externalId'] = 'replacement'
    elif case == 'copied':
        source.rows.append(dict(source.rows[0], id='copy'))
    elif case == 'nonterminal':
        runs[-1]['ended_at'] = None
    elif case == 'completion':
        with service.store.locked() as db:
            saved = service._rows(db)[0]
            saved['accept_intent'] = True
            service._save(db, saved)
    before = copy.deepcopy(source.rows)
    result = apply(body)
    if case in {'identity', 'copied'}:
        assert result['status'] == 'ok'  # Consent alone grants no source authority.
        assert apply(rerun)['status'] != 'ok'
        assert admission.starts == 1 and source.rows == before
        return
    if (case in {'stale', 'alive', 'nonterminal', 'completion'}
            or case == 'paused_result' and recurring):
        assert result['status'] != 'ok'
        if case in {'stale', 'nonterminal'}:
            assert result['task']['task_id'] == row['task_id']
            assert result['work_before_stop']['runs'] == runs
        assert admission.starts == 1
        assert source.rows == before
        return
    assert result['status'] == 'ok'
    receipt = result['receipt']
    assert receipt['cause'] == 'owner_confirmed_rerun'
    assert receipt['run_id'] == '1'
    assert admission.starts == 1
    assert apply(body)['receipt'] == receipt
    restarted = type(service)(tmp_path, admission, **kwargs)
    assert restarted.apply(**body)['receipt'] == receipt
    assert restarted.preview()['tasks'][0]['work_before_stop']['summary'] == 'Some work'
    if case == 'new_run':
        runs.append(dict(id='run-2', ended_at=456))
        assert apply(body)['reason'] == 'stale_run'
        assert apply(rerun)['status'] == 'attention'
        return
    assert apply(rerun)['status'] == 'ok'
    service.apply('tick')
    assert admission.starts == 2
    assert source.rows == before and source.writes == 0
