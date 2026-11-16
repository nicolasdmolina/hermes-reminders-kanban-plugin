from types import SimpleNamespace

from reminders_kanban.api import delegation
from reminders_kanban.execution import UnsupportedControl


def test_task_state_conflict_is_reported_as_attention():
    def preview():
        raise UnsupportedControl("previous worker has not stopped")

    assert delegation.run(SimpleNamespace(preview=preview)) == {
        "status": "attention", "reason": "previous worker has not stopped"
    }
