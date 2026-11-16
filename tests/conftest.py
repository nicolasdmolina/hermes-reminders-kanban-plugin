import pytest

from reminders_kanban.reminders.test_lists import proof_lists


@pytest.fixture(scope="session", autouse=True)
def temporary_reminder_lists(request):
    live = [item for item in request.session.items if item.get_closest_marker("live")]
    # The access probe must remain read-only and work when no test lists exist; the
    # scheduled-run and task-link proofs never read Reminders.
    no_lists = {"test_reminders_helper_live.py", "test_scheduled_run_live.py",
                "test_task_links_live.py"}
    if any(item.path.name not in no_lists for item in live):
        with proof_lists():
            yield
    else:
        yield
