import copy

import pytest

from reminders_kanban.reminders.completion import Completion


class Source:
    def __init__(self):
        self.rows = [
            {
                "id": "a",
                "externalId": "ext",
                "calendarId": "list",
                "due": {"day": 1},
                "completed": False,
                "title": "task",
                "notes": "work",
                "url": "link",
            }
        ]
        self.writes = 0

    def __call__(self, op, **fields):
        if op == "completion-read":
            return copy.deepcopy(self.rows)
        assert fields["expected"] == self.rows[0]
        self.writes += 1
        history = copy.deepcopy(self.rows[0])
        history.update(id="history", completed=True)
        self.rows.append(history)
        self.rows[0]["due"] = {"day": 2}


def setup(tmp_path, every=True):
    source = Source()
    service = Completion(tmp_path / "state.db", source)
    occurrence = service.authorize(source.rows[0], explicit=True, every_occurrence=every)
    return source, service, occurrence


@pytest.mark.parametrize("interruption", [None, "before_save", "after_save"])
def test_replay_after_restart(tmp_path, interruption):
    source, service, occurrence = setup(tmp_path)
    if interruption:
        with pytest.raises(InterruptedError):
            service.accept(occurrence, "result", interrupt=interruption)
    else:
        assert service.accept(occurrence, "result")["status"] == "completed"
    restarted = Completion(tmp_path / "state.db", source)
    outcome = restarted.accept(occurrence, "different-result")
    assert source.writes == (0 if interruption == "before_save" else 1)
    assert outcome["status"] == (
        "needs_reconciliation" if interruption == "before_save" else "completed"
    )
    if interruption != "before_save":
        assert outcome["history_id"] == "history"
        assert outcome["result_id"] == "result"
        next_id = restarted.carry_forward(occurrence)
        assert next_id != occurrence
        assert restarted.carry_forward(occurrence) == next_id


@pytest.mark.parametrize("change", ["copy", "instructions", "missing", "conflict"])
def test_ambiguous_source_blocks_carry_forward(tmp_path, change):
    source, service, occurrence = setup(tmp_path)
    service.accept(occurrence, "result")
    if change == "copy":
        source.rows.append(dict(source.rows[0], id="copy"))
    elif change == "instructions":
        source.rows[0]["notes"] = "new instructions"
    elif change == "missing":
        source.rows.pop(0)
    else:
        source.rows.append(dict(source.rows[1], id="duplicate-history"))
    assert service.accept(occurrence, "result")["status"] == "needs_reconciliation"
    with pytest.raises(ValueError):
        service.carry_forward(occurrence)
    assert source.writes == 1


def test_import_never_authorizes(tmp_path):
    source, service, occurrence = setup(tmp_path, every=False)
    with pytest.raises(ValueError, match="Explicit"):
        service.authorize(source.rows[0])
    service.accept(occurrence, "result")
    with pytest.raises(ValueError):
        service.carry_forward(occurrence)


def test_stale_acceptance_does_not_write(tmp_path):
    source, service, occurrence = setup(tmp_path)
    source.rows[0]["notes"] = "changed"
    assert service.accept(occurrence, "result")["status"] == "needs_reconciliation"
    assert source.writes == 0


def test_confirmed_successor_survives_temporary_ambiguity(tmp_path):
    source, service, occurrence = setup(tmp_path)
    confirmed = service.accept(occurrence, "result")
    source.rows.append(dict(source.rows[0], id="copy"))
    assert service.accept(occurrence, "result")["status"] == "needs_reconciliation"
    source.rows[0]["due"] = {"day": 3}
    source.rows.pop()
    restarted = Completion(tmp_path / "state.db", source)
    assert restarted.accept(occurrence, "result") == confirmed
    with pytest.raises(ValueError, match="Successor needs reconciliation"):
        restarted.carry_forward(occurrence)
    assert source.writes == 1


def test_carry_forward_replay_after_successor_completed(tmp_path):
    source, service, occurrence = setup(tmp_path)
    service.accept(occurrence, "result")
    next_id = service.carry_forward(occurrence)
    source.rows[0]["completed"] = True
    assert service.carry_forward(occurrence) == next_id
    assert source.writes == 1


def test_successful_accept_survives_one_post_write_read_failure(tmp_path):
    source = Source()
    failed = False

    def call(op, **fields):
        nonlocal failed
        if op == "completion-read" and source.writes and not failed:
            failed = True
            raise TimeoutError("simulated post-write read hiccup")
        return source(op, **fields)

    service = Completion(tmp_path / "state.db", call)
    occurrence = service.authorize(copy.deepcopy(source.rows[0]), explicit=True)
    assert service.accept(occurrence, "result")["status"] == "completed"
    assert source.writes == 1 and failed
    assert service.accept(occurrence, "result")["status"] == "completed"
    assert source.writes == 1


def test_native_receipt_is_authoritative_when_later_reads_fail(tmp_path):
    source = Source()

    def call(op, **fields):
        if op == "completion-read" and source.writes:
            raise TimeoutError("simulated unavailable verification read")
        result = source(op, **fields)
        if op == "complete-occurrence":
            return dict(saved=True, rows=copy.deepcopy(source.rows))
        return result

    service = Completion(tmp_path / "state.db", call)
    occurrence = service.authorize(copy.deepcopy(source.rows[0]), explicit=True,
                                   every_occurrence=True)
    accepted = service.accept(occurrence, "result")
    assert accepted["status"] == "completed" and accepted["history_id"] == "history"
    assert service.accept(occurrence, "result") == accepted
    with pytest.raises(TimeoutError):
        service.carry_forward(occurrence)
    assert source.writes == 1


def test_read_failure_does_not_erase_an_observed_conflict(tmp_path):
    source, service, occurrence = setup(tmp_path)
    assert service.accept(occurrence, "result")["status"] == "completed"
    source.rows[0]["notes"] = "Changed instructions"
    conflict = service.accept(occurrence, "result")
    assert conflict["status"] == "needs_reconciliation"

    def unavailable(*args, **kwargs):
        raise TimeoutError("simulated source unavailable after a known conflict")

    service.call = unavailable
    assert service.accept(occurrence, "result") == conflict
    assert source.writes == 1
