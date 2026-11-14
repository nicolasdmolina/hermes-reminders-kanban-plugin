from copy import deepcopy

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from test_plugin_api import load_like_hermes

from reminders_kanban.api import preview
from reminders_kanban.reminders import helper

PREFIX = "/api/plugins/reminders-kanban"


def client(home):
    app = FastAPI()
    app.include_router(load_like_hermes().router, prefix=PREFIX)
    app.dependency_overrides[preview.profile_home] = lambda: home
    return TestClient(app)


def snapshot(id="r1", title="Plain", completed=False, rules=None):
    return {
        "id": id,
        "title": title,
        "completed": completed,
        "rules": rules or [],
        "calendarId": "a",
        "notes": "Original notes",
        "due": None,
    }


@pytest.fixture
def source(monkeypatch):
    state = {
        "lists": [{"id": "a", "title": "Test", "writable": True}],
        "rows": [snapshot()],
        "error": None,
        "calls": [],
    }

    def run(op, **fields):
        assert op in {"lists", "read_many"}, "preview must never write"
        state["calls"].append(op)
        if state["error"]:
            raise helper.HelperError(state["error"], "unavailable")
        return deepcopy(state["lists"] if op == "lists" else state["rows"])

    monkeypatch.setattr(helper, "run", run)
    return state


def test_preview_reopen_identity_and_isolation(tmp_path, source):
    c = client(tmp_path / "one")
    assert c.get(PREFIX + "/setup").json()["status"] == "loading"
    first = c.put(PREFIX + "/setup", json={"selected_list_ids": ["a"]}).json()
    assert first["status"] == "ready"
    assert first["cards"][0]["owner"] == "human"
    assert first["pickup_enabled"] is False
    reopened = client(tmp_path / "one").get(PREFIX + "/setup").json()
    assert reopened["cards"] == first["cards"]
    assert reopened["status"] == "stale"
    again = c.get(PREFIX + "/preview").json()
    assert again["cards"] == first["cards"]
    other = client(tmp_path / "two")
    assert other.get(PREFIX + "/setup").json()["cards"] == []
    second = other.put(PREFIX + "/setup", json={"selected_list_ids": ["a"]}).json()
    assert second["cards"][0]["id"] != first["cards"][0]["id"]
    source["rows"] = []
    assert c.get(PREFIX + "/preview").json()["cards"] == []


def test_classification_preserves_detail(tmp_path, source):
    source["rows"] = [
        snapshot("1"),
        snapshot("2", "[Agent] Work"),
        snapshot("3", "[Agent · Ready] Repeat", rules=[{"interval": 1}]),
        snapshot("4", "Done", completed=True),
    ]
    body = client(tmp_path).put(PREFIX + "/setup", json={"selected_list_ids": ["a"]}).json()
    assert body["columns"] == preview.COLUMNS
    assert [c["column"] for c in body["cards"]] == ["To do", "To do", "Ready for Agent", "Done"]
    assert body["ready_count"] == 1
    for row, card in zip(source["rows"], body["cards"], strict=True):
        assert card["source"] == row
        assert not card["every_occurrence_authorized"] and not card["eligible"]
    assert body["cards"][2]["recurring"]


@pytest.mark.parametrize(
    "error,status",
    [("access_denied", "access_denied"), ("failed", "read_failure"), ("uncertain", "read_failure")],
)
def test_failure_and_recovery(tmp_path, source, error, status):
    c = client(tmp_path)
    source["error"] = error
    assert c.get(PREFIX + "/preview").json()["status"] == status
    source["error"] = None
    saved = c.put(PREFIX + "/setup", json={"selected_list_ids": ["a"]}).json()
    source["error"] = error
    failed = c.get(PREFIX + "/preview").json()
    assert failed["status"] == ("access_denied" if error == "access_denied" else "stale")
    assert failed["cards"] == saved["cards"]
    assert failed["setup"] == saved["setup"]
    source["error"] = None
    assert c.get(PREFIX + "/preview").json()["status"] == "ready"


def test_empty_missing_list_and_invalid_input(tmp_path, source):
    c = client(tmp_path)
    source["rows"] = []
    assert (
        c.put(PREFIX + "/setup", json={"selected_list_ids": ["a"]}).json()["status"] == "empty_list"
    )
    source["lists"] = []
    failed = c.get(PREFIX + "/preview").json()
    assert failed["error"]["code"] == "list_unavailable"
    assert failed["setup"]["selected_list_ids"] == ["a"]
    # The picker gets the lists as they are now, so the one that's gone can be unticked.
    assert failed["lists"] == []
    assert (
        c.put(PREFIX + "/setup", json={"selected_list_ids": [], "pickup_enabled": True}).status_code
        == 422
    )
    assert client(None).get(PREFIX + "/preview").json()["status"] == "unavailable_host"
    assert c.post(PREFIX + "/activate").status_code == 404


def test_selection_survives_read_failure(tmp_path, monkeypatch):
    def run(op, **fields):
        if op == "lists":
            return [{"id": "a", "title": "Test", "writable": True}]
        raise helper.HelperError("failed", "read failed")

    monkeypatch.setattr(helper, "run", run)
    c = client(tmp_path)
    body = c.put(PREFIX + "/setup", json={"selected_list_ids": ["a"]}).json()
    assert body["status"] == "read_failure"
    reopened = client(tmp_path).get(PREFIX + "/setup").json()
    assert reopened["setup"] == {"selected_list_ids": ["a"], "stage": "lists_selected"}
    assert reopened["cards"] == []


def test_storage_failure_is_explicit(tmp_path, source):
    (tmp_path / "reminders-kanban").write_text("unavailable directory")
    assert client(tmp_path).get(PREFIX + "/setup").json()["status"] == "persistence_failed"


def test_refresh_reads_with_the_lock_free_and_never_saves_over_a_write(tmp_path, source):
    from reminders_kanban.store.preview import PreviewStore

    home = tmp_path / "one"
    c = client(home)
    c.put(PREFIX + "/setup", json={"selected_list_ids": ["a"]})
    store = PreviewStore(home / "reminders-kanban" / "state.sqlite3")
    real, seen = helper.run, []

    def run(op, **fields):
        # What a card action does while the board reads Reminders: take the store's lock.
        if op == "read_many" and not seen:
            import fcntl

            with store.path.with_suffix(store.path.suffix + ".lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)  # Raises if the read holds it.
                seen.append("free")
        return real(op, **fields)

    helper.run = run
    try:
        source["calls"].clear()
        assert c.get(PREFIX + "/preview").json()["status"] == "ready"
        assert seen == ["free"] and source["calls"] == ["lists", "read_many"]

        # Something is written to the store during the read (an action, a new list choice):
        # that read is dropped and Reminders is read again under the lock.
        def writes(op, **fields):
            if op == "read_many" and len(seen) == 1:
                seen.append("wrote")
                source["rows"] = [snapshot(title="After the write")]
                with store.locked() as db:
                    db.execute("CREATE TABLE IF NOT EXISTS other (x)")
                    db.execute("INSERT INTO other VALUES (1)")
                    db.commit()
                return [snapshot(title="Before the write")]
            return real(op, **fields)

        helper.run = writes
        source["calls"].clear()
        after = c.get(PREFIX + "/preview").json()
        assert after["cards"][0]["source"]["title"] == "After the write"
        assert source["calls"] == ["lists", "lists", "read_many"]
    finally:
        helper.run = real
