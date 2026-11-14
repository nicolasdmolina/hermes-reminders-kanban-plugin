import copy

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from test_occurrence import ready, setup  # noqa: F401

from reminders_kanban.api.occurrence import router, service


def ambiguous(setup):  # noqa: F811
    owner, source, worker, _ = setup
    row = ready(setup)
    worker.tasks[row['task_id']] = 'result'
    owner.apply('tick')
    source.rows[0]['due'] = source.successor_due
    row = owner.apply('tick')['tasks'][0]
    return row, dict(action='resolve_advance', occurrence_id=row['key'],
                     expected=copy.deepcopy(source.rows[0]),
                     intent_id=row['source_accept_intent'])


@pytest.mark.parametrize('answer', ['checked_off', 'date_moved'])
def test_answer_http_replay_and_stale(setup, answer):  # noqa: F811
    owner, source, worker, admission = setup
    row, body = ambiguous(setup)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[service] = lambda: owner
    client = TestClient(app)
    body['answer'] = answer
    for bad in [dict(body, expected=row['source']), dict(body, intent_id='stale')]:
        result = client.post('/occurrences/actions', json=bad).json()
        assert result['reason'] == 'stale_advance'
        assert result['current'] == source.rows[0]
    result = client.post('/occurrences/actions', json=body).json()
    assert result['status'] == 'ok', result
    assert client.post('/occurrences/actions', json=body).json() == result
    assert source.writes == 0 and admission.starts == 1
    if answer == 'checked_off':
        assert result['task']['status'] == 'done'
        assert result['task']['completion']['successor'] == source.rows[0]
        assert len(owner.apply('tick')['tasks']) == 1
        assert ready(setup)['key'] != row['key']
    else:
        stopped = owner.apply('stop', occurrence_id=row['key'])
        assert stopped['task']['status'] == 'stopped'
        worker.observe = lambda task: dict(state=worker.tasks[task],
            runs=[dict(id='run', ended_at='today')] if task == row['task_id'] else [])
        confirmed = owner.apply('confirm_rerun', occurrence_id=row['key'], run_id='run')
        assert confirmed['status'] == 'ok', confirmed
        rerun = owner.apply('rerun', occurrence_id=row['key'], expected=source.rows[0])
        assert rerun['task']['rerun_of'] == row['key']
        assert admission.starts == 2 and source.writes == 0


@pytest.mark.parametrize('answer', ['checked_off', 'date_moved'])
def test_contradictory_history_and_copies(setup, answer):  # noqa: F811
    owner, source, _, _ = setup
    row, body = ambiguous(setup)
    body['answer'] = answer
    source.rows.extend([dict(row['source'], id='history1', completed=True),
                        dict(row['source'], id='history2', completed=True)])
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[service] = lambda: owner
    result = TestClient(app).post('/occurrences/actions', json=body).json()
    assert result['reason'] == 'history_contradicts_answer'
    source.rows = source.rows[:1]
    source.rows.append(dict(source.rows[0], id='copy'))
    from reminders_kanban.reminders.helper import HelperError
    with pytest.raises(HelperError):
        owner.apply(**body)


@pytest.mark.parametrize('state,action', [('result', 'review'), ('question', 'reply')])
def test_occurrence_attention_alternative(setup, state, action):  # noqa: F811
    owner, _, worker, _ = setup
    row = ready(setup)
    worker.tasks[row['task_id']] = state
    owner.apply('tick')
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[service] = lambda: owner
    task = TestClient(app).get('/occurrences').json()['tasks'][0]
    assert task['required_action'] == action
    assert task['history']['state'] == state
    assert task['review_available'] == (state == 'result')


def test_existing_stranded_row_and_changed_snapshot(setup):  # noqa: F811
    owner, source, _, _ = setup
    row, body = ambiguous(setup)
    with owner.store.locked() as db:
        stored = owner._rows(db)[0]
        for key in ['source_accept_intent', 'owner_question', 'advance_snapshot']:
            stored.pop(key)
        owner._save(db, stored)
    owner.apply('tick')
    refreshed = owner.preview()['tasks'][0]
    assert refreshed['owner_question'] == 'checked_off_or_moved'
    body.update(intent_id=refreshed['source_accept_intent'], answer='date_moved')
    source.rows[0]['due'] = dict(source.rows[0]['due'], day=9)
    refused = owner.apply(**body)
    assert refused['reason'] == 'stale_advance'
    assert refused['task']['source_accept_intent'] != body['intent_id']
    body.update(intent_id=refused['task']['source_accept_intent'], expected=refused['current'])
    assert owner.apply(**body)['status'] == 'ok'
