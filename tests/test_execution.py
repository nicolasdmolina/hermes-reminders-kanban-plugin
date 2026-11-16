"""Task controls, runs, handbacks and recovery over the plugin's own store."""

import json
import threading
import time
from types import SimpleNamespace

import pytest
from fake_cron import FakeCron

from reminders_kanban.execution import (
    OperationConflict,
    TaskControl,
    UnsupportedControl,
    board,
    tools,
)
from reminders_kanban.execution import runner as runner_module
from reminders_kanban.execution.runner import Backend, Runner


def wait_for(predicate, seconds=5):
    deadline = time.monotonic() + seconds
    while not predicate():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.01)


@pytest.fixture
def world(tmp_path):
    home = tmp_path / "home"
    path = board.path_for(home)
    cron = FakeCron()
    runner = Runner(path, cron)
    conn = board.connect(path)
    runner_module._SWEPT.discard(str(path))
    yield SimpleNamespace(home=home, path=path, cron=cron, runner=runner, conn=conn,
                          control=TaskControl(conn, Backend(runner)))
    cron.release_all()
    conn.close()


def hand(world, name, job_id, text):
    answer = tools.handle(name, {"summary" if name == tools.FINISH else "question": text},
                          execution=SimpleNamespace(job_id=job_id), home=world.home)
    return json.loads(answer)


def start(world, task_id):
    run_id = world.runner.start(world.conn, task_id, "default")
    run = board.get_run(world.conn, run_id)
    return run_id, run.job_id


def settle(world, job_id, status="ok", error=None):
    world.cron.finish(job_id, status, error)
    run = board.run_for_job(world.conn, job_id)
    wait_for(lambda: not board.run_in_flight(world.conn, run.id))


def test_create_recovers_lost_result_even_after_archive(world):
    control = world.control
    task = control.create("op", " title ", "body", assignee="default")
    board.archive_task(world.conn, task)
    assert control.create("op", "title", "body", assignee="default") == task
    assert len(board.list_tasks(world.conn, include_archived=True)) == 1
    with pytest.raises(OperationConflict):
        control.create("op", "different", "body", assignee="default")


def test_reply_recovers_lost_result_without_duplicate(world):
    control = world.control
    task = control.create("op", "title", "body", assignee="default")
    board.schedule_task(world.conn, task)
    assert control.comment(task, "reply ", " blue ") == control.comment(task, "reply", "blue")
    with pytest.raises(OperationConflict):
        control.comment(task, "reply", "red")
    assert len(board.list_comments(world.conn, task)) == 1


def test_input_refuses_active_run_and_unknown_task(world):
    task = world.control.create("op", "title", "body", assignee="default")
    start(world, task)
    for target in (task, "missing"):
        with pytest.raises(UnsupportedControl):
            world.control.comment(target, "reply", "blue")
    assert board.list_comments(world.conn, task) == []


def test_result_is_handed_back_reviewed_and_accepted(world):
    task = world.control.create("op", "[RK] Paint", "Pick a color", assignee="default")
    run_id, job_id = start(world, task)
    assert world.cron.started.wait(5)
    job = world.cron.store[job_id]
    assert job["name"] == "Reminders: [RK] Paint"
    assert "Pick a color" in job["prompt"] and tools.FINISH in job["prompt"]
    assert world.control.observe(task)["state"] == "active"
    assert not world.control._workers_stopped(task)

    assert hand(world, tools.FINISH, job_id, " Painted it blue ")["ok"]
    seen = world.control.observe(task)
    assert (seen["state"], seen["summary"]) == ("result", "Painted it blue")
    assert seen["runs"][-1]["outcome"] == "review_requested"
    # A second handback from the same run changes nothing.
    assert not hand(world, tools.FINISH, job_id, "again")["ok"]
    with pytest.raises(UnsupportedControl):
        world.control.accept(task)  # the job is still winding down
    settle(world, job_id)
    assert world.control.accept(task)
    assert world.control.observe(task)["state"] == "done"
    assert board.list_runs(world.conn, task)[-1].metadata == {"approval": "manual"}


def test_question_is_answered_and_the_next_run_sees_the_answer(world):
    task = world.control.create("op", "title", "body", assignee="default")
    _, job_id = start(world, task)
    assert hand(world, tools.ASK, job_id, "Which blue?")["ok"]
    seen = world.control.observe(task)
    assert (seen["state"], seen["summary"]) == ("question", "Which blue?")
    world.control.comment(task, "answer", "Navy")
    with pytest.raises(UnsupportedControl, match="previous worker"):
        world.control.resume(task)
    settle(world, job_id)
    assert world.control.resume(task)
    _, second = start(world, task)
    assert "- Navy" in world.cron.store[second]["prompt"]


def test_changes_requested_restart_with_the_last_result(world):
    task = world.control.create("op", "title", "body", assignee="default")
    _, job_id = start(world, task)
    hand(world, tools.FINISH, job_id, "Blue")
    settle(world, job_id)
    assert world.control.request_changes(task, "changes", "Use red")
    assert world.control.observe(task)["state"] == "ready"
    _, second = start(world, task)
    prompt = world.cron.store[second]["prompt"]
    assert "Your last result was:\nBlue" in prompt and "- Use red" in prompt


def test_pause_and_stop_cancel_the_running_job(world):
    task = world.control.create("op", "title", "body", assignee="default")
    _, job_id = start(world, task)
    paused = world.control.pause(task)
    assert paused["state"] == "paused" and paused["worker_stop_verified"]
    assert world.cron.cancels == [(job_id, "Paused from Reminders")]
    # A late handback from the paused run is refused.
    assert not hand(world, tools.FINISH, job_id, "late")["ok"]
    assert world.control.observe(task)["state"] == "paused"
    assert world.control.pause(task)["worker_stop_verified"]  # replay is harmless

    assert world.control.resume(task)
    _, second = start(world, task)
    stopped = world.control.stop(task)
    assert stopped["state"] == "stopped" and stopped["worker_stop_verified"]
    assert world.cron.cancels[-1] == (second, "Stopped from Reminders")
    assert not hand(world, tools.ASK, second, "late?")["ok"]
    assert board.list_runs(world.conn, task)[-1].outcome == "reclaimed"


def test_pausing_a_result_parks_it_without_a_job(world):
    task = world.control.create("op", "title", "body", assignee="default")
    _, job_id = start(world, task)
    hand(world, tools.FINISH, job_id, "Blue")
    settle(world, job_id)
    assert world.control.pause(task)["state"] == "paused"
    assert world.cron.cancels == []
    assert world.control.resume(task)
    assert world.control.observe(task)["state"] == "ready"


def test_tools_refuse_outside_their_own_run(world):
    task = world.control.create("op", "title", "body", assignee="default")
    _, job_id = start(world, task)
    outside = json.loads(tools.handle(tools.FINISH, {"summary": "x"}, execution=None,
                                      home=world.home))
    assert not outside["ok"]
    assert not hand(world, tools.FINISH, "someone-elses-job", "x")["ok"]
    assert not hand(world, tools.FINISH, job_id, "   ")["ok"]
    assert not json.loads(tools.handle(tools.FINISH, {"summary": "x"},
                                       execution=SimpleNamespace(job_id=job_id),
                                       home=world.home / "other"))["ok"]
    assert world.control.observe(task)["state"] == "active"


def test_unavailable_scheduled_jobs_fail_the_attempt_visibly(world):
    world.runner.cron = FakeCron(fail_create=True)
    task = world.control.create("op", "title", "body", assignee="default")
    world.runner.start(world.conn, task, "default")
    seen = world.control.observe(task)
    assert seen["state"] == "failed"
    assert "scheduled jobs are off" in seen["runs"][-1]["error"]
    assert world.control._workers_stopped(task)


def test_reconcile_fails_a_run_that_ended_without_a_handback(world):
    task = world.control.create("op", "title", "body", assignee="default")
    _, job_id = start(world, task)
    settle(world, job_id, "error", "Model refused")
    world.runner.reconcile(world.conn)
    seen = world.control.observe(task)
    assert seen["state"] == "failed" and seen["runs"][-1]["error"] == "Model refused"
    assert job_id in world.cron.removed
    world.runner.reconcile(world.conn)  # settled runs are left alone
    assert world.cron.removed.count(job_id) == 1


def test_reconcile_keeps_waiting_on_a_live_run_and_removes_finished_jobs(world):
    task = world.control.create("op", "title", "body", assignee="default")
    _, job_id = start(world, task)
    world.runner.reconcile(world.conn)
    assert world.control.observe(task)["state"] == "active"
    hand(world, tools.FINISH, job_id, "Blue")
    world.runner.reconcile(world.conn)
    assert job_id in world.cron.store  # still winding down
    settle(world, job_id)
    world.runner.reconcile(world.conn)
    assert job_id not in world.cron.store
    assert world.control.observe(task)["state"] == "result"


def test_a_run_nobody_waits_on_is_failed_only_after_the_orphan_limit(world, monkeypatch):
    task = world.control.create("op", "title", "body", assignee="default")
    run_id = board.start_run(world.conn, task, "default")
    job_id = world.cron.create("Reminders: title", "prompt")
    board.bind_job(world.conn, run_id, job_id)  # as if Hermes restarted mid-run
    world.runner.reconcile(world.conn)
    assert world.control.observe(task)["state"] == "active" and not world.cron.cancels
    later = board.now() + runner_module.ORPHAN_LIMIT + 1
    monkeypatch.setattr(board, "now", lambda: later)
    world.runner.reconcile(world.conn)
    seen = world.control.observe(task)
    assert seen["state"] == "failed"
    assert seen["runs"][-1]["error"] == "Hermes stopped answering during this run."
    assert world.cron.cancels == [(job_id, "No answer from Hermes")]
    assert world.cron.runs == []  # never started again


def test_a_removed_job_fails_its_run_and_leftover_jobs_are_swept(world):
    task = world.control.create("op", "title", "body", assignee="default")
    run_id = board.start_run(world.conn, task, "default")
    board.bind_job(world.conn, run_id, "gone")
    leftover = world.cron.create("Reminders: crashed before binding", "x")
    unrelated = world.cron.create("Morning brief", "x")
    world.runner.reconcile(world.conn)
    assert world.control.observe(task)["runs"][-1]["error"] == (
        "The Hermes job for this run was removed.")
    assert leftover in world.cron.removed and unrelated in world.cron.store


def test_a_held_run_lock_is_seen_from_another_connection(world):
    task = world.control.create("op", "title", "body", assignee="default")
    run_id = board.start_run(world.conn, task, "default")
    held, release = threading.Event(), threading.Event()

    def hold():
        with board.connect_closing(world.path) as conn, board.hold_run(conn, run_id):
            held.set()
            release.wait(5)

    thread = threading.Thread(target=hold)
    thread.start()
    assert held.wait(5)
    with board.connect_closing(world.path) as other:
        assert board.run_in_flight(other, run_id)
    release.set()
    thread.join(5)
    assert not board.run_in_flight(world.conn, run_id)


def test_prompt_never_lets_the_agent_complete_the_reminder():
    task = SimpleNamespace(title="T", body="Notes here", result=None)
    text = runner_module.prompt(task, [SimpleNamespace(author="someone", body="ignored")])
    assert "Never mark the reminder complete" in text
    assert "ignored" not in text and "Notes here" in text
