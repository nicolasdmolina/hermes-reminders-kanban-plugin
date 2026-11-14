from unittest.mock import patch

import pytest

from reminders_kanban.reminders import edits, helper


@pytest.mark.parametrize("code", ["access_denied", "conflict", "not_found", "uncertain"])
def test_error_outcomes_keep_current(code):
    current = {"id": "same", "notes": "newer source"}
    with patch.object(helper, "run", side_effect=helper.HelperError(code, "detail", current)):
        assert edits.action("edit", id="same", patch={"notes": "draft"}) == {
            "outcome": code, "message": "detail", "current": current,
        }


def test_list_move_passes_full_expected_and_only_requested_field():
    expected = {"id": "same", "calendarId": "old", "notes": "untouched"}
    with patch.object(helper, "run", return_value={"current": expected}) as run:
        assert edits.action(
            "edit", id="same", expected=expected, patch={"calendarId": "new"}
        )["outcome"] == "ok"
        run.assert_called_once_with(
            "edit", id="same", expected=expected, patch={"calendarId": "new"}
        )


def test_uncertain_write_is_not_retried():
    with patch.object(helper, "run", side_effect=helper.HelperError("uncertain", "lost")) as run:
        assert edits.action("create", fields={"title": "draft"})["outcome"] == "uncertain"
        assert run.call_count == 1
