import copy

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from test_delegation import setup as one_off_setup  # noqa: F401
from test_occurrence import setup as recurring_setup  # noqa: F401

from reminders_kanban.api.model_choice import router
from reminders_kanban.api.preview import profile_home
from reminders_kanban.model_choice import ModelChoice, ModelChoices

CHOICE = ModelChoice(model="[RK-MC]-model", provider="custom:rk-mc", effort="none")


@pytest.mark.parametrize("bad", [
    {"provider": "openai"}, {"model": "model"}, {"model": "", "provider": "x"},
    {"effort": "auto"}, {"effort": ""}, {"effort": 1}, {"profile": "other"},
])
def test_rejects_invalid_shape(bad):
    with pytest.raises(ValidationError):
        ModelChoice.model_validate(bad)


def test_api_persistence_and_owner_isolation(tmp_path):
    app = FastAPI()
    app.include_router(router)
    home = tmp_path / "owner"
    app.dependency_overrides[profile_home] = lambda: home
    client = TestClient(app)
    assert client.get("/model-choice").json()["model_choice"] == ModelChoice().model_dump()
    response = client.post("/model-choice", json=CHOICE.model_dump())
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["model_choice"] == CHOICE.model_dump()
    assert client.get("/model-choice").json() == response.json()
    assert client.post("/model-choice", json={"provider": "x"}).status_code == 422
    assert ModelChoices(home, "other-board").read() == ModelChoice()
    home = tmp_path / "profiles" / "other"
    assert client.get("/model-choice").json()["model_choice"] == ModelChoice().model_dump()
    assert client.post("/model-choice", json={"effort": "none"}).json()["model_choice"] == {
        "model": None, "provider": None, "effort": "none"}
    assert client.post("/model-choice", json={}).json()["model_choice"]["effort"] is None


@pytest.mark.parametrize("fixture", ["one_off_setup", "recurring_setup"])
@pytest.mark.parametrize("choice", [ModelChoice(), CHOICE])
def test_snapshot_survives_crash_and_default_change(request, fixture, choice):
    service, source, owner, _ = request.getfixturevalue(fixture)
    if fixture == "one_off_setup":
        service.apply("activate")
    service.model_choices.save(choice)
    create = owner.create
    calls = []

    def lost_response(*args, **kwargs):
        calls.append(kwargs)
        create(*args, **kwargs)
        raise RuntimeError("[RK-MC] lost create response")

    owner.create = lost_response
    expected = copy.deepcopy(source.rows[0])
    with pytest.raises(RuntimeError):
        service.apply("ready", expected=expected)
    with service.store.connection() as db:
        assert service._rows(db)[0]["model_choice"] == choice.model_dump()
    service.model_choices.save(ModelChoice(model="new", provider="other", effort="high"))

    def replay(*args, **kwargs):
        calls.append(kwargs)
        return create(*args, **kwargs)

    owner.create = replay
    service.apply("ready", expected=expected)
    assert calls[0] == calls[1] == dict(assignee=service.profile, **choice.task_fields())
    assert len(owner.tasks) == 1
    assert service.model_choices.read().model == "new"
    if fixture == "one_off_setup":
        assert service.preview()["model_choice"]["model"] == "new"


def test_new_recurring_occurrence_uses_new_default(request):
    service, source, owner, _ = request.getfixturevalue("recurring_setup")
    service.model_choices.save(CHOICE)
    first = service.apply("ready", expected=copy.deepcopy(source.rows[0]))["tasks"][-1]
    owner.tasks[first["task_id"]] = "result"
    service.apply("tick")
    service.apply("accept", occurrence_id=first["key"])
    service.model_choices.save(ModelChoice(effort="high"))
    second = service.apply("ready", expected=copy.deepcopy(source.rows[0]))["tasks"][-1]
    assert first["model_choice"] == CHOICE.model_dump()
    assert second["model_choice"] == ModelChoice(effort="high").model_dump()


@pytest.mark.parametrize("fixture", ["one_off_setup", "recurring_setup"])
def test_legacy_preparation_inherits_after_default_change(request, fixture):
    service, source, owner, _ = request.getfixturevalue(fixture)
    if fixture == "one_off_setup":
        service.apply("activate")
    create = owner.create

    def fail(*args, **kwargs):
        raise RuntimeError("[RK-MC] before create")

    owner.create = fail
    expected = copy.deepcopy(source.rows[0])
    with pytest.raises(RuntimeError):
        service.apply("ready", expected=expected)
    with service.store.locked() as db:
        row = service._rows(db)[0]
        row.pop("model_choice")
        service._save(db, row)
    service.model_choices.save(CHOICE)
    calls = []

    def capture(*args, **kwargs):
        calls.append(kwargs)
        return create(*args, **kwargs)

    owner.create = capture
    service.apply("ready", expected=expected)
    assert calls == [dict(assignee=service.profile, **ModelChoice().task_fields())]


@pytest.mark.parametrize("path", ["automatic", "reauthorize"])
def test_recurring_preparation_paths_snapshot_before_create(request, path):
    from test_recurring import enable, held

    setup = request.getfixturevalue("recurring_setup")
    service, source, owner, _ = setup
    if path == "automatic":
        first = enable(setup)
        owner.tasks[first["task_id"]] = "result"
        service.apply("accept", occurrence_id=first["key"])
    else:
        first = held(setup)
    service.model_choices.save(CHOICE)
    if path == "reauthorize":
        service.apply("resolve_series", occurrence_id=first["key"], hold_id=first["hold_id"],
                      decision="reauthorize", confirmed_cause=first["held_reason"],
                      expected=copy.deepcopy(source.rows[0]))
    create = owner.create
    calls = []

    def crash(*args, **kwargs):
        calls.append(kwargs)
        raise RuntimeError("[RK-MC] before create")

    owner.create = crash
    with pytest.raises(RuntimeError):
        service.apply("tick")
    with service.store.connection() as db:
        assert service._rows(db)[-1]["model_choice"] == CHOICE.model_dump()
    service.model_choices.save(ModelChoice(effort="high"))

    def recover(*args, **kwargs):
        calls.append(kwargs)
        return create(*args, **kwargs)

    owner.create = recover
    service.apply("tick")
    assert calls == [dict(assignee=service.profile, **CHOICE.task_fields())] * 2
