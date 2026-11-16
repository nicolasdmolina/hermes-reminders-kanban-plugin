"""Ordered, bounded starts over the plugin's own store with a stand-in scheduled-job tool."""

import time

import pytest
from fake_cron import FakeCron

from reminders_kanban.execution import TaskControl, UnsupportedControl, board, runner
from reminders_kanban.execution.admission import DEFAULT_MAXIMUM, Admission, profile_for


@pytest.fixture
def admission(tmp_path):
    cron = FakeCron()
    a = Admission(tmp_path / "home", cron=cron)
    runner._SWEPT.discard(str(a.path))
    yield a
    cron.release_all()


def new_task(a, key, resources=()):
    with a.serialized() as conn:
        task = TaskControl(conn, a.kb).create(key, f"[RK] {key}", "Synthetic",
                                              assignee="default")
    a.ready(task, resources=resources)
    return task


def settle(a, task):
    with a.serialized() as conn:
        for run in board.list_runs(conn, task):
            if run.job_id:
                a.runner.cron.finish(run.job_id)
                deadline = time.monotonic() + 5
                while board.run_in_flight(conn, run.id):
                    assert time.monotonic() < deadline
                    time.sleep(0.01)


def test_profiles_get_their_own_store(tmp_path):
    assert profile_for(tmp_path / ".hermes") == "default"
    assert profile_for(tmp_path / ".hermes/profiles/work") == "work"
    assert (Admission(tmp_path / ".hermes").path
            != Admission(tmp_path / ".hermes/profiles/work").path)


def test_fifo_resources_and_maximum(admission):
    a = admission
    ids = [new_task(a, str(i), ["shared"] if i < 2 else []) for i in range(4)]
    assert a.observe()["board_maximum"] == DEFAULT_MAXIMUM
    a.set_maximum(2)
    result = a.admit()
    assert [s["task_id"] for s in result["started"]] == [ids[0], ids[2]]
    assert result["running"] == 2
    assert result["queue"] == [{"task_id": ids[1], "reason": "resource_busy"},
                               {"task_id": ids[3], "reason": "board_capacity"}]
    assert not a.admit()["started"]
    a.set_maximum(1)
    assert a.admit()["running"] == 2  # lowering never stops running work
    a.set_maximum(3)
    assert [s["task_id"] for s in a.admit()["started"]] == [ids[3]]
    with pytest.raises(ValueError):
        a.set_maximum(0)


def test_a_result_frees_its_resource_once_the_job_ends(admission):
    a = admission
    first, second = new_task(a, "a", ["shared"]), new_task(a, "b", ["shared"])
    a.admit()
    with a.serialized() as conn:
        job = board.list_runs(conn, first)[-1].job_id
    from reminders_kanban.execution import tools

    tools.handle(tools.FINISH, {"summary": "Done"},
                 execution=type("E", (), {"job_id": job})(), home=a.home)
    assert a.observe()["queue"] == [{"task_id": second, "reason": "resource_busy"}]
    settle(a, first)
    assert [s["task_id"] for s in a.admit()["started"]] == [second]


def test_ready_keeps_its_place_and_refuses_ineligible_tasks(admission):
    a = admission
    first, second = new_task(a, "a"), new_task(a, "b")
    a.ready(first)
    assert [q["task_id"] for q in a.observe()["queue"]] == [first, second]
    a.set_maximum(1)
    a.admit()
    with pytest.raises(UnsupportedControl):
        a.ready(first)  # running
    with pytest.raises(KeyError):
        a.ready("missing")
    with pytest.raises(ValueError):
        a.ready(second, resources=[" "])


def test_pause_revokes_a_queued_start(admission):
    a = admission
    a.set_maximum(1)
    first, second = new_task(a, "a"), new_task(a, "b")
    a.admit()
    assert a.pause(second)["state"] == "paused"
    a.pause(first)
    assert not a.admit()["started"]
    assert a.runner.cron.cancels[0][1] == "Paused from Reminders"


def test_unregistered_tasks_refuse_admission(admission):
    with admission.serialized() as conn:
        board.create_task(conn, title="stray", body="x", assignee="default",
                          idempotency_key="stray")
    with pytest.raises(UnsupportedControl, match="unregistered"):
        admission.admit()


def test_hold_parks_without_granting_a_start(admission):
    a = admission
    with a.serialized() as conn:
        task = TaskControl(conn, a.kb).create("h", "[RK] h", "Synthetic", assignee="default")
        a.hold(conn, task)
    assert a.observe()["queue"] == []
    assert not a.admit()["started"]


def test_a_failed_start_is_reported_and_does_not_block_the_queue(tmp_path):
    a = Admission(tmp_path / "home", cron=FakeCron(fail_create=True))
    task = new_task(a, "a")
    result = a.admit()
    assert result["started"] == [{"task_id": task, "run_id": 1}]
    with a.reading() as conn:
        assert TaskControl(conn, a.kb).observe(task)["state"] == "failed"
    assert result["running"] == 0
