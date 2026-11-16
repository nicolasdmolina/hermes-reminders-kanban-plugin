import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from reminders_kanban.api import task_links
from reminders_kanban.links import Links, link_url


def observation(**binding):
    return dict(
        task={"assignee": binding["profile"], "block_reason": "Color?"},
        state="question",
        summary="Color?",
        comments=[],
        runs=[{"session_id": "one"}],
    )


def test_identity_history_and_replay(tmp_path):
    store = Links(tmp_path)
    owner, link = store.bind("reminder", "first", "board", "task-1", "default")
    assert store.bind("reminder", "first", "board", "task-1", "default") == (owner, link)
    assert store.bind("reminder", "second", "board", "task-2", "default") == (owner, link)
    store.bind("reminder", "first", "board", "task-1", "default")
    current = store.resolve(owner, link, observation)
    assert current["current_occurrence_id"] == "second"
    assert current["question"] == "Color?" and current["result"] is None
    assert current["actions"] == ["comment", "resume"]
    history = store.resolve(owner, link, observation, "first")
    assert history["historical"] and history["actions"] == []
    assert history["binding"]["task"] == "task-1"
    with pytest.raises(ValueError):
        store.bind("reminder", "first", "board", "different", "default")
    assert store.bind("copied-reminder", "first", "board", "task-3", "default")[1] != link


def test_owner_and_reconnect(tmp_path):
    store = Links(tmp_path)
    owner, link = store.bind("r", "o", "b", "t", "default")

    def forbidden(**kwargs):
        pytest.fail("wrong owner must not read a task")

    assert store.resolve("other", link, forbidden)["status"] == "wrong_owner"
    assert (
        Links(tmp_path / "another-profile").resolve(owner, link, forbidden)["status"]
        == "wrong_owner"
    )

    def offline(**kwargs):
        raise OSError("offline")

    failed = store.resolve(owner, link, offline)
    restored = Links(tmp_path).resolve(owner, link, observation)
    assert failed["status"] == "unavailable_owner"
    assert failed["destination"] == restored["destination"]

    def reassigned(**kwargs):
        return {**observation(**kwargs), "task": {"assignee": "another"}}

    assert store.resolve(owner, link, reassigned)["status"] == "wrong_owner"


@pytest.mark.parametrize(
    "origin",
    [
        "http://mac",
        "https://localhost",
        "https://127.0.0.1",
        "https://[::1]",
        "https://user:pass@mac",
        "https://mac?token=x",
        "https://mac/#token",
    ],
)
def test_links_reject_credentials_and_localhost(origin):
    with pytest.raises(ValueError):
        link_url(origin, "owner", "link", "default")


def test_route_boundary(tmp_path, monkeypatch):
    store = Links(tmp_path)
    owner, link = store.bind("r", "o", "b", "t", "default")
    app = FastAPI()
    app.include_router(task_links.router)
    client = TestClient(app)
    url = f"/task-links/{owner}/{link}"

    # Sign-in is Hermes' own: its dashboard answers 401 before any plugin route runs.
    monkeypatch.setattr(task_links, "profile_home", lambda: tmp_path)
    monkeypatch.setattr(task_links, "observe", observation)
    response = client.get(url)
    assert response.json()["status"] == "resolved"
    assert "title" in response.json()
    assert response.headers["cache-control"] == "no-store"
    assert client.post(url).status_code == 405
    assert link_url("https://owner.example", owner, link, "default") == (
        f"https://owner.example/reminders?owner={owner}&link={link}&profile=default"
    )


def test_accepted_and_historical_results_keep_delivery(tmp_path):
    links = Links(tmp_path)
    owner, link = links.bind("r", "first", "b", "t", "default")
    work = observation(profile="default")
    work.update(
        state="result",
        summary="Actual delivered blue result",
        runs=[
            dict(
                id=1,
                profile="default",
                outcome="review_requested",
                summary="Actual delivered blue result",
                metadata=None,
            ),
        ],
    )

    def read(**kwargs):
        return work

    assert links.resolve(owner, link, read)["result"] == "Actual delivered blue result"
    work.update(state="done", summary="Review approved without additional evidence.")
    work["runs"].append(
        dict(
            id=2,
            profile="default",
            outcome="completed",
            summary=work["summary"],
            metadata={"source_status": "review", "approval": "manual"},
        )
    )
    assert links.resolve(owner, link, read)["result"] == "Actual delivered blue result"
    links.bind("r", "second", "b", "t2", "default")
    history = links.resolve(owner, link, read, "first")
    assert history["historical"] and history["result"] == "Actual delivered blue result"
