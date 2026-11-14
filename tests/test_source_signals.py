import copy

import pytest

from reminders_kanban.reminders.helper import HelperError
from reminders_kanban.workflow.source import SourceGuard


class Owner:
    def __init__(self):
        self.state = "active"
        self.calls = []
        self.verified = True

    def observe(self, task):
        return {"state": self.state}

    def pause(self, task):
        self.calls.append("pause")
        self.state = "paused"
        return {"worker_stop_verified": self.verified}

    def stop(self, task):
        self.calls.append("stop")
        self.state = "stopped"
        return {"worker_stop_verified": self.verified}

    def comment(self, *args):
        self.calls.append("comment")

    def resume(self, task):
        self.calls.append("resume")
        self.state = "ready"
        return True


@pytest.fixture
def setup(tmp_path):
    source = dict(id="source", externalId="external", title="Task", notes="old", completed=False)
    owner = Owner()

    def read(identity):
        if source.get("error"):
            raise HelperError(source["error"], "proof")
        return copy.deepcopy(source)

    guard = SourceGuard(tmp_path / "state.db", owner, read)
    guard.bind("task", source)
    return guard, source, owner


def test_change_requires_reconciliation_explicit_resume_and_fresh_read(setup):
    guard, source, owner = setup
    source["notes"] = "new"
    state = guard.observe("task")
    assert state["status"] == "paused" and state["instruction_version"] == 2
    assert guard.observe("task") == state
    assert owner.calls == ["pause"]
    assert guard.resume("task", instruction_version=2)["status"] == "paused"
    guard.reconcile("task", instruction_version=2, evidence="History inspected; no writes issued")
    source["notes"] = "newer"
    assert guard.resume("task", instruction_version=2)["instruction_version"] == 3
    guard.reconcile("task", instruction_version=3, evidence="History inspected; no writes issued")
    assert guard.resume("task", instruction_version=3)["status"] == "active"
    guard.resume("task", instruction_version=3)
    assert owner.calls.count("resume") == 1
    assert owner.calls.count("comment") == 1


@pytest.mark.parametrize("signal,status", [("completed", "stopped"), ("not_found", "deleted")])
def test_terminal_signals_win_across_restart(setup, signal, status):
    guard, source, owner = setup
    if signal == "completed":
        source["completed"] = True
    else:
        source["error"] = signal
    state = guard.observe("task")
    assert state["status"] == status
    assert state["hidden"] == (status == "deleted")
    guard = SourceGuard(guard.store.path, owner, guard.read)
    guard.observe("task")
    guard.resume("task", instruction_version=1)
    assert owner.calls == ["stop"]
    source.pop("error", None)
    source["completed"] = False
    assert guard.observe("task")["status"] == status


def test_failed_read_preserves_worker_and_waits_without_reconciliation(setup):
    guard, source, owner = setup
    source["error"] = "access_denied"
    owner.verified = False
    state = guard.observe("task")
    assert state["status"] == "waiting_source" and not state["hidden"]
    with pytest.raises(ValueError):
        guard.reconcile("task", instruction_version=1, evidence="checked")
    owner.verified = True
    assert guard.observe("task")["reconciliation"] == "not_required"
    assert owner.calls == []
    source.pop("error")
    assert guard.observe("task")["status"] == "active"


def test_crash_after_unblock_does_not_unblock_again(setup):
    guard, source, owner = setup
    source["notes"] = "new"
    guard.observe("task")
    guard.reconcile("task", instruction_version=2, evidence="No external actions in history")
    resume = owner.resume

    def lost(task):
        resume(task)
        raise RuntimeError("lost response")

    owner.resume = lost
    with pytest.raises(RuntimeError):
        guard.resume("task", instruction_version=2)
    guard = SourceGuard(guard.store.path, owner, guard.read)
    assert guard.resume("task", instruction_version=2)["status"] == "active"
    assert owner.calls.count("resume") == 1


def test_occurrence_change_cannot_be_overridden_by_instruction_edit(setup):
    guard, source, owner = setup
    source["due"] = {"day": 2}
    assert guard.observe("task")["reason"] == "occurrence_changed"
    source["notes"] = "changed too"
    guard.observe("task")
    guard.reconcile("task", instruction_version=2, evidence="checked")
    assert guard.resume("task", instruction_version=2)["status"] == "paused"


def test_crash_before_unblock_remains_parked(setup):
    guard, source, owner = setup
    source["notes"] = "new"
    guard.observe("task")
    guard.reconcile("task", instruction_version=2, evidence="No external actions")

    def lost(task):
        raise RuntimeError("crash before unblock")

    owner.resume = lost
    with pytest.raises(RuntimeError):
        guard.resume("task", instruction_version=2)
    state = guard.observe("task")
    assert state["status"] == "paused"
    assert state["reason"] == "resume_uncertain"
    assert state["reconciliation"] == "required"


def test_source_completion_before_resume_wins(setup):
    guard, source, owner = setup
    source["notes"] = "new"
    guard.observe("task")
    guard.reconcile("task", instruction_version=2, evidence="No external actions")
    source["completed"] = True
    assert guard.resume("task", instruction_version=2)["status"] == "stopped"
    assert "resume" not in owner.calls


def test_completion_wins_after_occurrence_conflict(setup):
    guard, source, owner = setup
    source["due"] = {"day": 2}
    guard.observe("task")
    source["completed"] = True
    assert guard.observe("task")["status"] == "stopped"


def test_owner_race_keeps_durable_veto_and_exposes_unverified_stop(setup):
    from reminders_kanban.execution import UnsupportedControl

    guard, source, owner = setup
    source["notes"] = "new"
    pause = owner.pause

    def racing(task):
        raise UnsupportedControl("owner changed")

    owner.pause = racing
    state = guard.observe("task")
    assert state["status"] == "paused"
    assert not state["worker_stop_verified"]
    assert state["reconciliation"] == "required"
    owner.pause = pause
    assert guard.observe("task")["worker_stop_verified"]


def test_completion_then_deletion_hides_card(setup):
    guard, source, owner = setup
    source["completed"] = True
    guard.observe("task")
    source["error"] = "not_found"
    state = guard.observe("task")
    assert state["status"] == "deleted" and state["hidden"]


def test_reconciled_pre_unblock_crash_can_resume_same_comment(setup):
    guard, source, owner = setup
    source["notes"] = "new"
    guard.observe("task")
    guard.reconcile("task", instruction_version=2, evidence="No writes")
    original_resume = owner.resume
    comments = []
    owner.comment = lambda *args: comments.append(args)

    def crash(task):
        raise RuntimeError("before unblock")

    owner.resume = crash
    with pytest.raises(RuntimeError):
        guard.resume("task", instruction_version=2)
    guard.observe("task")
    guard.reconcile("task", instruction_version=2, evidence="Rechecked; no writes")
    owner.resume = original_resume
    assert guard.resume("task", instruction_version=2)["status"] == "active"
    assert len(comments) == 2 and comments[0] == comments[1]


def test_outage_does_not_cancel_a_known_instruction_veto(setup):
    guard, source, owner = setup
    source['notes'] = 'changed'
    owner.verified = False
    guard.observe('task')
    source['error'] = 'access_denied'
    state = guard.observe('task')
    assert state['reason'] == 'instructions_changed'
    assert state['status'] == 'paused'
    assert state['source_wait']
    assert owner.calls == ['pause', 'pause']
