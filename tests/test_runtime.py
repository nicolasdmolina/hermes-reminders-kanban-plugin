import contextvars
import json
import threading
import time

from reminders_kanban.runtime import Ticker, permitted

ENABLED = {
    "plugins": {
        "enabled": ["reminders-kanban"],
        "entries": {"reminders-kanban": {"settings": {"unattended": True}}},
    }
}


def wait_for(predicate):
    deadline = time.monotonic() + 3
    while not predicate():
        assert time.monotonic() < deadline
        time.sleep(0.01)


def test_enabled_plugin_defaults_to_ticks_with_explicit_off_override():
    assert permitted(ENABLED)
    assert not permitted({})
    assert permitted({"plugins": {"enabled": ["reminders-kanban"]}})
    assert not permitted({"plugins": {"enabled": ["reminders-kanban"],
        "entries": {"reminders-kanban": {"settings": {"unattended": False}}}}})
    assert not permitted({"plugins": {**ENABLED["plugins"], "disabled": ["reminders-kanban"]}})


def test_context_and_unload_wait_for_inflight_pass(tmp_path):
    home = contextvars.ContextVar("owner", default="wrong")
    home.set("first")
    entered, release = threading.Event(), threading.Event()
    seen = []

    def tick(path):
        seen.append((home.get(), path))
        entered.set()
        release.wait(3)
        return {"status": "ok"}

    ticker = Ticker(tmp_path, lambda: ENABLED, tick, interval=0.01)
    ticker.start()
    home.set("second")
    assert entered.wait(3)
    stopped = threading.Thread(target=ticker.stop)
    stopped.start()
    assert stopped.is_alive()
    release.set()
    stopped.join(3)
    assert not stopped.is_alive()
    assert seen == [("first", tmp_path)]


def test_elected_owner_recovers_error_and_disabled_owner_releases_lock(tmp_path):
    calls = []
    config = dict(ENABLED)

    def tick(path):
        calls.append(path)
        if len(calls) == 1:
            raise ValueError("recoverable")
        return {"status": "ok"}

    first = Ticker(tmp_path, lambda: config, tick, interval=0.02)
    second_calls = []
    second = Ticker(
        tmp_path, lambda: ENABLED, lambda path: second_calls.append(path) or {}, interval=0.02
    )
    first.start()
    wait_for(lambda: len(calls) >= 2)
    second.start()
    try:
        time.sleep(0.08)
        assert not second_calls
        receipt = json.loads((tmp_path / "reminders-kanban/runtime.json").read_text())
        assert receipt["ticks"] >= 2
        config.clear()
        first.thread.join(3)
        assert not first.thread.is_alive()
        wait_for(lambda: bool(second_calls))
    finally:
        first.stop()
        second.stop()


def test_named_profiles_cannot_share_the_default_owner_board(tmp_path):
    from reminders_kanban.runtime import board_for

    default = tmp_path / ".hermes"
    first, second = default / "profiles/first", default / "profiles/second"
    assert board_for(default) == "reminders-kanban"
    assert len({board_for(default), board_for(first), board_for(second)}) == 3
    assert board_for(first) == board_for(first / ".")
