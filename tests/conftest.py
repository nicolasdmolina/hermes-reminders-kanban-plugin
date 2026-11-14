import pytest

from reminders_kanban.reminders.test_lists import proof_lists


@pytest.fixture(scope="session", autouse=True)
def temporary_reminder_lists(request):
    live = [item for item in request.session.items if item.get_closest_marker("live")]
    # The access probe must remain read-only and work when no test lists exist.
    if any(item.path.name != "test_reminders_helper_live.py" for item in live):
        with proof_lists():
            yield
    else:
        yield
