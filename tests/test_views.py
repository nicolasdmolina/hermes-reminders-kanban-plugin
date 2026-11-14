import copy
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from test_plugin_api import load_like_hermes

from reminders_kanban.api.preview import COLUMNS as PREVIEW_COLUMNS
from reminders_kanban.workflow.views import COLUMNS, query_board

PREFIX = "/api/plugins/reminders-kanban"
OWNERS = ["all", "human", "agent"]
REPEATS = ["all", "recurring", "one_off"]
LIST_FILTERS = [None, [], ["a"], ["b"], ["a", "b"]]


def card(
    id,
    *,
    owner="human",
    column="To do",
    recurring=False,
    list_id="a",
    title=None,
    due=None,
    priority=None,
    created=None,
    **extra,
):
    source = dict(extra.pop("source", {}))
    if list_id is not None:
        source.setdefault("calendarId", list_id)
    source.setdefault("title", id if title is None else title)
    if due is not None:
        source["due"] = due
    if priority is not None:
        source["priority"] = priority
    if created is not None:
        source["created"] = created
    body = {
        "id": id,
        "owner": owner,
        "column": column,
        "recurring": recurring,
        "source": source,
    }
    body.update(extra)
    return body


def matrix():
    return [
        card("h-one-a", owner="human", recurring=False, list_id="a", column="To do"),
        card("h-rec-a", owner="human", recurring=True, list_id="a", column="To do"),
        card(
            "a-one-b",
            owner="agent",
            recurring=False,
            list_id="b",
            column="Ready for Agent",
            ready_at="2026-11-01T00:00:00+00:00",
        ),
        card(
            "a-rec-b",
            owner="agent",
            recurring=True,
            list_id="b",
            column="Needs you",
            action="review",
            requested_at="2026-11-02T00:00:00+00:00",
        ),
        card(
            "h-one-b",
            owner="human",
            recurring=False,
            list_id="b",
            column="Needs you",
            action="question",
            requested_at="2026-11-01T00:00:00+00:00",
        ),
        card("a-one-a", owner="agent", recurring=False, list_id="a", column="Done"),
        card(
            "h-rec-a2",
            owner="human",
            recurring=True,
            list_id="a",
            column="In progress",
            waiting=True,
            started_at="2026-11-01T00:00:00+00:00",
        ),
        card(
            "a-rec-a",
            owner="agent",
            recurring=True,
            list_id="a",
            column="In progress",
            waiting=False,
            started_at="2026-11-03T00:00:00+00:00",
        ),
    ]


FULL_DEFAULT = [
    "h-one-a",
    "h-rec-a",
    "a-one-b",
    "a-rec-a",
    "h-rec-a2",
    "h-one-b",
    "a-rec-b",
    "a-one-a",
]


def spec_visible(cards, owner, repeats, list_ids):
    """Acceptance predicate for stories 22 and 24, written beside the implementation."""
    allowed = None if list_ids is None else set(list_ids)
    chosen = []
    for item in cards:
        if owner != "all" and item["owner"] != owner:
            continue
        if repeats == "recurring" and item["recurring"] is not True:
            continue
        if repeats == "one_off" and item["recurring"] is True:
            continue
        if allowed is not None and item["source"].get("calendarId") not in allowed:
            continue
        chosen.append(item["id"])
    return chosen


def test_columns_match_the_preview_board():
    assert list(COLUMNS) == PREVIEW_COLUMNS


def test_default_view_keeps_every_integrated_card_in_column_order():
    cards = matrix()
    result = query_board(cards)
    assert result["order"] == FULL_DEFAULT
    assert result["matched_count"] == 8
    assert result["unplaced"] == []
    assert result["attention"]["needs_you_count"] == 2
    assert result["attention"]["hidden"] == []
    assert result["attention"]["reveal"] is None
    assert result["queue"] is None
    assert [card["id"] for card in result["columns"]["In progress"]] == ["a-rec-a", "h-rec-a2"]
    assert [card["id"] for card in result["columns"]["Needs you"]] == ["h-one-b", "a-rec-b"]


@pytest.mark.parametrize("owner", OWNERS)
@pytest.mark.parametrize("repeats", REPEATS)
@pytest.mark.parametrize("list_ids", LIST_FILTERS)
def test_every_filter_combination_preserves_queue_events_and_input(owner, repeats, list_ids):
    cards = matrix()
    snapshot = copy.deepcopy(cards)
    queue = ["a-rec-b", "h-one-a", "not-on-board"]
    events = [{"id": "evt", "card_id": "a-rec-b", "kind": "review", "payload": {"text": "look"}}]
    signals = [{"id": "stop", "card_id": "h-rec-a2", "kind": "completion"}]
    result = query_board(
        cards,
        owner=owner,
        repeats=repeats,
        list_ids=list_ids,
        queue=queue,
        attention_events=events,
        stop_signals=signals,
    )
    expected = set(spec_visible(cards, owner, repeats, list_ids))
    assert result["order"] == [item for item in FULL_DEFAULT if item in expected]
    assert result["matched_count"] == len(result["order"])
    assert result["attention"]["needs_you_count"] == 2
    assert {item["id"] for item in result["attention"]["hidden"]} == {
        item
        for item in ("h-one-b", "a-rec-b")
        if item not in expected
    }
    assert result["queue"] == queue
    assert result["queue"] is not queue
    assert result["attention_events"] == events
    assert result["stop_signals"] == signals
    assert cards == snapshot
    assert queue == ["a-rec-b", "h-one-a", "not-on-board"]
    result["attention_events"][0]["payload"]["text"] = "changed"
    result["stop_signals"][0]["kind"] = "changed"
    assert events[0]["payload"]["text"] == "look"
    assert signals[0]["kind"] == "completion"


@pytest.mark.parametrize(
    ("owner", "repeats", "list_ids", "expected"),
    [
        ("agent", "one_off", ["b"], ["a-one-b"]),
        ("human", "recurring", None, ["h-rec-a", "h-rec-a2"]),
        ("all", "all", [], []),
        ("human", "all", ["b"], ["h-one-b"]),
        ("agent", "recurring", ["a"], ["a-rec-a"]),
        ("all", "one_off", None, ["h-one-a", "a-one-b", "h-one-b", "a-one-a"]),
        ("agent", "all", ["a", "b"], ["a-one-b", "a-rec-a", "a-rec-b", "a-one-a"]),
    ],
)
def test_named_filter_combinations(owner, repeats, list_ids, expected):
    view = query_board(matrix(), owner=owner, repeats=repeats, list_ids=list_ids)
    assert view["order"] == expected


def test_list_filter_does_not_change_integration_membership():
    cards = matrix()
    assert set(query_board(cards, list_ids=["b", "a"])["order"]) == set(FULL_DEFAULT)
    only_a = query_board(cards, list_ids=["a"])["order"]
    assert query_board(cards, list_ids=["a", "c"])["order"] == only_a
    assert "h-one-a" in only_a
    assert "a-one-b" not in only_a
    hidden = query_board(cards, list_ids=[])
    assert hidden["order"] == []
    assert hidden["attention"]["needs_you_count"] == 2
    assert [item["id"] for item in hidden["attention"]["hidden"]] == ["h-one-b", "a-rec-b"]
    assert hidden["attention"]["reveal"]["list_ids"] == ["b"]


def test_recurring_flag_is_not_inferred_from_source_rules():
    cards = [
        card("rules-only", recurring=False, source={"rules": [{"interval": 1}]}),
        card("marked", recurring=True, source={"rules": []}),
    ]
    assert query_board(cards, repeats="recurring")["order"] == ["marked"]
    assert query_board(cards, repeats="one_off")["order"] == ["rules-only"]


def test_reveal_query_shows_hidden_attention_and_leaves_the_queue():
    cards = matrix()
    snapshot = copy.deepcopy(cards)
    queue = ["a-rec-b", "h-one-a"]
    view = query_board(
        cards,
        owner="human",
        list_ids=["b"],
        queue=queue,
        attention_events=[{"id": "evt", "card_id": "a-rec-b", "kind": "review"}],
        stop_signals=[{"id": "stop", "card_id": "a-one-b", "kind": "completion"}],
    )
    assert view["order"] == ["h-one-b"]
    assert view["attention"]["needs_you_count"] == 2
    hidden = view["attention"]["hidden"]
    assert hidden == [
        {
            "id": "a-rec-b",
            "owner": "agent",
            "recurring": True,
            "list_id": "b",
            "action": "review",
            "requested_at": "2026-11-02T00:00:00+00:00",
            "hidden_by": ["owner"],
        }
    ]
    reveal = view["attention"]["reveal"]
    assert reveal == {"owner": "all", "repeats": "all", "list_ids": ["b"], "sort": "default"}
    shown = query_board(cards, **reveal)
    assert shown["order"] == ["a-one-b", "h-one-b", "a-rec-b"]
    assert view["queue"] == queue
    assert cards == snapshot


def test_reveal_widens_every_dimension_that_hides_attention():
    cards = [
        card(
            "h",
            owner="human",
            column="Needs you",
            recurring=False,
            requested_at="2026-11-02T00:00:00+00:00",
        ),
        card(
            "a",
            owner="agent",
            column="Needs you",
            recurring=True,
            requested_at="2026-11-01T00:00:00+00:00",
        ),
    ]
    view = query_board(cards, owner="human", repeats="one_off")
    assert view["order"] == ["h"]
    assert view["attention"]["hidden"][0]["hidden_by"] == ["owner", "repeats"]
    assert view["attention"]["reveal"]["owner"] == "all"
    assert view["attention"]["reveal"]["repeats"] == "all"
    assert "a" in query_board(cards, **view["attention"]["reveal"])["order"]


def test_reveal_uses_all_lists_when_a_hidden_card_has_no_list():
    cards = [card("ghost", column="Needs you", list_id=None, action="repair")]
    view = query_board(cards, list_ids=["a"])
    assert view["order"] == []
    assert view["attention"]["reveal"]["list_ids"] is None
    assert query_board(cards, **view["attention"]["reveal"])["order"] == ["ghost"]


def test_to_do_default_is_earliest_due_then_priority_then_id():
    cards = [
        card("low", due={"year": 2026, "month": 11, "day": 5}, priority=9),
        card("high-b", due={"year": 2026, "month": 11, "day": 5}, priority=1),
        card("high-a", due={"year": 2026, "month": 11, "day": 5}, priority=1),
        card("undated-high", priority=1),
        card("sooner", due={"year": 2026, "month": 11, "day": 4}, priority=9),
    ]
    assert query_board(cards)["order"] == ["sooner", "high-a", "high-b", "low", "undated-high"]
    assert query_board(list(reversed(cards)))["order"] == query_board(cards)["order"]


def test_due_components_order_all_day_before_timed_and_undated_last():
    day = {"year": 2026, "month": 11, "day": 5}
    cards = [
        card("afternoon", due={**day, "hour": 15, "minute": 0, "timeZone": "America/New_York"}),
        card("all-day-m", due=day),
        card("morning", due={**day, "hour": 9, "minute": 0}),
        card("all-day-a", due=day),
        card("undated"),
        card("next-day", due={"year": 2026, "month": 11, "day": 6}),
        card("same-clock", due={**day, "hour": 9, "minute": 0, "second": 0}),
    ]
    assert query_board(cards)["order"] == [
        "all-day-a",
        "all-day-m",
        "morning",
        "same-clock",
        "afternoon",
        "next-day",
        "undated",
    ]


def test_same_wall_clock_in_two_zones_ties_by_zone_name_then_id():
    due = {"year": 2026, "month": 11, "day": 5, "hour": 9, "minute": 30, "second": 0}
    cards = [
        card("east", due={**due, "timeZone": "America/New_York"}),
        card("west", due={**due, "timeZone": "America/Los_Angeles"}),
    ]
    assert query_board(cards, sort="due")["order"] == ["west", "east"]
    assert query_board(list(reversed(cards)), sort="due")["order"] == ["west", "east"]


def test_bad_due_sorts_as_undated_without_raising():
    cards = [
        card("dated", due={"year": 2026, "month": 11, "day": 5}),
        card("broken", due={"year": "soon", "month": 11, "day": 5}),
        card("bool-hour", due={"year": 2026, "month": 11, "day": 5, "hour": True}),
    ]
    assert query_board(cards, sort="due")["order"] == ["dated", "bool-hour", "broken"]


def test_ready_in_progress_needs_you_and_done_defaults():
    ready = [
        card("late", column="Ready for Agent", ready_at="2026-11-02T00:00:00+00:00"),
        card("early", column="Ready for Agent", ready_at="2026-11-01T00:00:00+00:00"),
        card("unknown", column="Ready for Agent"),
    ]
    running = [
        card(
            "waiting-early",
            column="In progress",
            waiting=True,
            started_at="2026-11-01T00:00:00+00:00",
        ),
        card(
            "active-late",
            column="In progress",
            waiting=False,
            started_at="2026-11-03T00:00:00+00:00",
        ),
        card("active-early", column="In progress", started_at="2026-11-02T00:00:00+00:00"),
        card("not-a-bool", column="In progress", waiting="yes", started_at="2026-11-01T12:00:00Z"),
    ]
    needs = [
        card("newer", column="Needs you", requested_at="2026-11-04T00:00:00+00:00"),
        card("older", column="Needs you", requested_at="2026-11-03T00:00:00+00:00"),
        card("missing", column="Needs you", requested_at="not-a-time"),
    ]
    done = [
        card("older-done", column="Done", source={"completedAt": "2026-11-01T00:00:00+00:00"}),
        card("newer-done", column="Done", completed_at="2026-11-08T00:00:00+00:00",
             source={"completedAt": "2026-11-01T00:00:00+00:00"}),
        card("middle", column="Done", source={"completedAt": "2026-11-06T00:00:00+00:00"}),
    ]
    assert query_board(ready)["order"] == ["early", "late", "unknown"]
    assert query_board(list(reversed(ready)))["order"] == ["early", "late", "unknown"]
    assert query_board(running)["order"] == [
        "not-a-bool",
        "active-early",
        "active-late",
        "waiting-early",
    ]
    assert query_board(needs)["order"] == ["older", "newer", "missing"]
    # Pin the clock so the 7-day window still contains every completion in this sort proof.
    assert query_board(done, now=datetime(2026, 11, 8, tzinfo=UTC))["order"] == [
        "newer-done",
        "middle",
        "older-done",
    ]


def test_sort_overrides_replace_the_column_default_and_keep_id_ties():
    cards = [
        card(
            "p0",
            column="In progress",
            waiting=True,
            priority=0,
            due={"year": 2026, "month": 1, "day": 2},
        ),
        card(
            "p1",
            column="In progress",
            waiting=False,
            priority=1,
            due={"year": 2026, "month": 1, "day": 3},
        ),
        card("p5", column="In progress", priority=5, due={"year": 2026, "month": 1, "day": 1}),
        card("p9", column="In progress", priority=9),
        card("p4", column="In progress", priority=4),
        card("ptrue", column="In progress", priority=True),
    ]
    due_order = ["p5", "p0", "p1", "p4", "p9", "ptrue"]
    assert query_board(cards, sort="due")["order"] == due_order
    assert query_board(list(reversed(cards)), sort="due")["order"] == due_order
    # 4 reads as High on the card (another app wrote it), so it sorts with the highs.
    assert query_board(cards, sort="priority")["order"] == ["p1", "p4", "p5", "p9", "p0", "ptrue"]
    # Default still puts active work before the waiting card, so the override is what changed.
    assert query_board(cards)["order"][0] != "p0"


def test_created_and_title_sorts_are_deterministic():
    created = [
        card("new", created="2026-11-05T00:00:00+00:00", due={"year": 2026, "month": 1, "day": 1}),
        card("old", created="2026-11-01T00:00:00Z", due={"year": 2026, "month": 12, "day": 1}),
        card("naive", created="2026-11-01T00:00:00"),
        card("missing"),
    ]
    titled = [
        card("b-lower", title="b"),
        card("a-upper", title="A"),
        card("a-lower", title="a"),
        card("b-upper", title="B"),
    ]
    created_order = ["naive", "old", "new", "missing"]
    assert query_board(created, sort="created")["order"] == created_order
    assert query_board(list(reversed(created)), sort="created")["order"] == created_order
    title_order = ["a-upper", "a-lower", "b-upper", "b-lower"]
    assert query_board(titled, sort="title")["order"] == title_order
    assert query_board(list(reversed(titled)), sort="title")["order"] == [
        "a-upper",
        "a-lower",
        "b-upper",
        "b-lower",
    ]


def test_duplicate_ids_keep_input_order():
    first = card("same", title="first")
    second = card("same", title="second")
    forward = query_board([first, second])
    backward = query_board([second, first])
    assert [item["source"]["title"] for item in forward["columns"]["To do"]] == ["first", "second"]
    assert [item["source"]["title"] for item in backward["columns"]["To do"]] == ["second", "first"]


def test_sorting_does_not_move_cards_between_columns_or_rewrite_the_queue():
    cards = [
        card("later", column="To do", due={"year": 2026, "month": 11, "day": 6}, title="B"),
        card("sooner", column="Done", due={"year": 2026, "month": 11, "day": 1}, title="A"),
        card("ready", column="Ready for Agent", ready_at="2026-11-02T00:00:00+00:00", title="C"),
    ]
    queue = ["ready", "later", "sooner"]
    view = query_board(cards, sort="title", queue=queue)
    assert [item["id"] for item in view["columns"]["To do"]] == ["later"]
    assert [item["id"] for item in view["columns"]["Done"]] == ["sooner"]
    assert view["order"] == ["later", "ready", "sooner"]
    assert view["queue"] == ["ready", "later", "sooner"]
    default = query_board(cards)
    assert [item["id"] for item in default["columns"]["Ready for Agent"]] == ["ready"]
    assert default["columns"]["To do"][0]["id"] == "later"


def test_returned_cards_are_copies():
    cards = matrix()
    snapshot = copy.deepcopy(cards)
    view = query_board(cards, sort="title")
    view["columns"]["To do"][0]["source"]["title"] = "changed"
    view["columns"]["To do"][0]["owner"] = "agent"
    assert cards == snapshot


def test_unknown_column_stays_visible_and_out_of_the_five():
    cards = [card("odd", column="Later"), card("todo")]
    view = query_board(cards)
    assert view["order"] == ["todo", "odd"]
    assert [item["id"] for item in view["unplaced"]] == ["odd"]
    assert all(item["id"] != "odd" for column in view["columns"].values() for item in column)


def test_direct_validation_errors():
    with pytest.raises(ValueError, match="id"):
        query_board([{"owner": "human"}])
    with pytest.raises(ValueError, match="owner"):
        query_board([], owner="both")
    with pytest.raises(ValueError, match="list_ids"):
        query_board([], list_ids="a")
    with pytest.raises(ValueError, match="queue"):
        query_board([], queue=["ok", ""])
    with pytest.raises(ValueError, match="done"):
        query_board([], done="show-all")


def test_documented_example():
    """The example in reminders_kanban/workflow/views.md."""
    cards = [
        card(
            "essay",
            owner="human",
            column="To do",
            recurring=False,
            list_id="school",
            title="Essay",
            due={"year": 2026, "month": 11, "day": 6},
            priority=0,
            created="2026-11-01T00:00:00+00:00",
        ),
        card(
            "lab",
            owner="agent",
            column="To do",
            recurring=True,
            list_id="school",
            title="Lab",
            due={
                "year": 2026,
                "month": 11,
                "day": 5,
                "hour": 9,
                "minute": 0,
                "timeZone": "America/New_York",
            },
            priority=1,
            created="2026-11-02T00:00:00+00:00",
        ),
        card(
            "call",
            owner="human",
            column="Needs you",
            recurring=False,
            list_id="personal",
            title="Call",
            action="question",
            requested_at="2026-11-03T12:00:00+00:00",
        ),
        card(
            "draft",
            owner="agent",
            column="Needs you",
            recurring=False,
            list_id="school",
            title="Draft",
            action="review",
            requested_at="2026-11-03T11:00:00+00:00",
        ),
    ]
    queue = ["draft", "lab"]
    events = [{"id": "evt-1", "card_id": "draft", "kind": "review"}]
    signals = [{"id": "stop-1", "card_id": "lab", "kind": "completion"}]
    default = query_board(cards, queue=queue, attention_events=events, stop_signals=signals)
    assert default["order"] == ["lab", "essay", "draft", "call"]
    assert default["done"]["total"] == 0
    assert default["done"]["hidden"] == 0
    assert default["done"]["window"]["mode"] == "recent"
    assert default["done"]["window"]["days"] == 7
    narrowed = query_board(
        cards,
        owner="human",
        queue=queue,
        attention_events=events,
        stop_signals=signals,
    )
    assert narrowed["order"] == ["essay", "call"]
    assert narrowed["attention"]["needs_you_count"] == 2
    assert [item["id"] for item in narrowed["attention"]["hidden"]] == ["draft"]
    assert narrowed["queue"] == ["draft", "lab"]
    assert narrowed["attention_events"] == events
    assert narrowed["stop_signals"] == signals
    assert query_board(cards, sort="title")["order"] == ["essay", "lab", "call", "draft"]


DONE_NOW = datetime(2026, 11, 8, 15, 0, tzinfo=UTC)
DONE_SINCE = DONE_NOW - timedelta(days=7)
DONE_OUTSIDE = DONE_SINCE - timedelta(microseconds=1)


def test_done_window_keeps_the_inclusive_boundary_and_hides_the_instant_before():
    cards = [
        card("outside", column="Done", completed_at=DONE_OUTSIDE.isoformat()),
        card("inside", column="Done", completed_at=DONE_SINCE.isoformat()),
        card("fresh", column="Done", source={"completedAt": "2026-11-08T15:00:00Z"}),
        card("todo", column="To do"),
    ]
    view = query_board(cards, now=DONE_NOW)
    assert [item["id"] for item in view["columns"]["Done"]] == ["fresh", "inside"]
    assert view["order"] == ["todo", "fresh", "inside"]
    assert query_board(list(reversed(cards)), now=DONE_NOW)["order"] == view["order"]
    assert view["done"] == {
        "total": 3,
        "hidden": 1,
        "window": {"mode": "recent", "days": 7, "since": DONE_SINCE.isoformat()},
    }
    assert view["matched_count"] == 3
    titled = [
        card("inside", column="Done", title="B", completed_at=DONE_SINCE.isoformat()),
        card("fresh", column="Done", title="A", completed_at=DONE_NOW.isoformat()),
        card("old", column="Done", title="C", completed_at=DONE_OUTSIDE.isoformat()),
    ]
    titled_view = query_board(titled, sort="title", now=DONE_NOW)
    assert [item["id"] for item in titled_view["columns"]["Done"]] == ["fresh", "inside"]


def test_done_window_uses_completed_at_before_source_completed_at():
    cards = [
        card(
            "card-time",
            column="Done",
            completed_at=DONE_SINCE.isoformat(),
            source={"completedAt": DONE_OUTSIDE.isoformat()},
        ),
        card(
            "source-time",
            column="Done",
            completed_at=DONE_OUTSIDE.isoformat(),
            source={"completedAt": DONE_NOW.isoformat()},
        ),
    ]
    view = query_board(cards, now=DONE_NOW)
    assert view["order"] == ["card-time"]
    assert view["done"]["total"] == 2
    assert view["done"]["hidden"] == 1


def test_show_all_done_returns_every_completion_newest_first():
    cards = [
        card("outside", column="Done", completed_at=DONE_OUTSIDE.isoformat()),
        card("inside", column="Done", completed_at=DONE_SINCE.isoformat()),
        card("fresh", column="Done", completed_at=DONE_NOW.isoformat()),
        card("untimed", column="Done"),
    ]
    view = query_board(cards, done="all", now=DONE_NOW)
    assert view["order"] == ["fresh", "inside", "outside", "untimed"]
    assert view["matched_count"] == 4
    assert view["done"]["total"] == 4
    assert view["done"]["hidden"] == 0
    assert view["done"]["window"] == {"mode": "all", "days": None, "since": None}


def test_missing_completion_time_stays_visible_and_sorts_last():
    cards = [
        card("blank", column="Done", completed_at=""),
        card("garbage", column="Done", completed_at="not-a-time"),
        card("absent", column="Done"),
        card("old", column="Done", completed_at="2020-01-01T00:00:00+00:00"),
        card("fresh", column="Done", completed_at=DONE_NOW.isoformat()),
    ]
    view = query_board(cards, now=DONE_NOW)
    assert view["order"] == ["fresh", "absent", "blank", "garbage"]
    assert view["done"]["total"] == 5
    assert view["done"]["hidden"] == 1
    assert "old" not in view["order"]


def test_done_counts_cover_the_filtered_column_and_not_other_owners():
    cards = [
        card("human-old", owner="human", column="Done", completed_at="2020-01-01T00:00:00+00:00"),
        card("human-new", owner="human", column="Done", completed_at=DONE_NOW.isoformat()),
        card("agent-old", owner="agent", column="Done", completed_at="2020-01-01T00:00:00+00:00"),
        card("human-todo", owner="human", column="To do"),
    ]
    view = query_board(cards, owner="human", now=DONE_NOW)
    assert view["order"] == ["human-todo", "human-new"]
    assert view["done"]["total"] == 2
    assert view["done"]["hidden"] == 1
    assert view["matched_count"] == 2


def test_done_window_does_not_mutate_cards_or_queue_order():
    cards = [
        card("old", column="Done", completed_at="2020-01-01T00:00:00+00:00", title="Old"),
        card("new", column="Done", completed_at=DONE_NOW.isoformat(), title="New"),
        card("todo", column="To do"),
    ]
    snapshot = copy.deepcopy(cards)
    queue = ["old", "todo", "new"]
    events = [{"id": "evt", "card_id": "old", "kind": "completion", "payload": {"text": "keep"}}]
    signals = [{"id": "stop", "card_id": "old", "kind": "completion"}]
    view = query_board(
        cards,
        queue=queue,
        attention_events=events,
        stop_signals=signals,
        now=DONE_NOW,
    )
    assert view["order"] == ["todo", "new"]
    assert view["queue"] == ["old", "todo", "new"]
    assert view["queue"] is not queue
    assert view["attention_events"] == events
    assert view["stop_signals"] == signals
    assert cards == snapshot
    assert queue == ["old", "todo", "new"]
    view["columns"]["Done"][0]["source"]["title"] = "changed"
    view["queue"].append("extra")
    view["attention_events"][0]["payload"]["text"] = "changed"
    assert cards == snapshot
    assert queue == ["old", "todo", "new"]
    assert events[0]["payload"]["text"] == "keep"
    shown = query_board(cards, done="all", queue=queue, now=DONE_NOW)
    assert shown["order"] == ["todo", "new", "old"]
    assert shown["queue"] == ["old", "todo", "new"]
    assert cards == snapshot


def test_documented_done_window():
    """The Done window example in reminders_kanban/workflow/views.md."""
    now = datetime(2026, 11, 8, 15, 0, tzinfo=UTC)
    cards = [
        card("fresh", column="Done", completed_at="2026-11-08T15:00:00+00:00", title="Fresh"),
        card("edge", column="Done", completed_at="2026-11-01T15:00:00+00:00", title="Edge"),
        card("old", column="Done", completed_at="2026-11-01T14:59:59.999999+00:00", title="Old"),
        card("untimed", column="Done", title="Untimed"),
    ]
    view = query_board(cards, now=now)
    assert view["order"] == ["fresh", "edge", "untimed"]
    assert view["done"]["total"] == 4
    assert view["done"]["hidden"] == 1
    assert view["done"]["window"] == {
        "mode": "recent",
        "days": 7,
        "since": "2026-11-01T15:00:00+00:00",
    }
    shown = query_board(cards, done="all", now=now)
    assert shown["order"] == ["fresh", "edge", "old", "untimed"]
    assert shown["done"]["hidden"] == 0
    assert shown["done"]["window"] == {"mode": "all", "days": None, "since": None}


def _client():
    app = FastAPI()
    app.include_router(load_like_hermes().router, prefix=PREFIX)
    return TestClient(app)


def test_route_matches_the_function_and_does_not_touch_reminders(monkeypatch):
    def fail(*_args, **_kwargs):
        raise AssertionError("view query must not touch Reminders")

    monkeypatch.setattr("reminders_kanban.reminders.helper.run", fail)
    payload = {
        "cards": [card("essay", title="Essay"), card("lab", owner="agent", title="Lab")],
        "owner": "human",
        "sort": "title",
        "queue": ["lab", "essay"],
    }
    response = _client().post(PREFIX + "/view", json=payload)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["order"] == ["essay"]
    assert response.json()["queue"] == ["lab", "essay"]
    direct = query_board(
        payload["cards"],
        owner="human",
        sort="title",
        queue=["lab", "essay"],
    )
    assert response.json()["order"] == direct["order"]
    assert response.json()["attention"] == direct["attention"]


def test_route_rejects_execution_controls_and_bad_cards():
    client = _client()
    extra = client.post(PREFIX + "/view", json={"cards": [], "pickup_enabled": True})
    assert extra.status_code == 422
    bad_sort = client.post(PREFIX + "/view", json={"cards": [], "sort": "queue"})
    assert bad_sort.status_code == 422
    missing = client.post(PREFIX + "/view", json={"cards": [{"title": "No id"}]})
    assert missing.status_code == 422
    bad_done = client.post(PREFIX + "/view", json={"cards": [], "done": "show-all"})
    assert bad_done.status_code == 422
    clock = client.post(PREFIX + "/view", json={"cards": [], "now": "2026-11-08T15:00:00+00:00"})
    assert clock.status_code == 422
    empty = client.post(PREFIX + "/view", json={"cards": []})
    assert empty.status_code == 200
    assert empty.json()["matched_count"] == 0
    assert empty.json()["attention"]["needs_you_count"] == 0
    assert empty.json()["done"]["total"] == 0
    assert empty.json()["done"]["hidden"] == 0
    assert empty.json()["done"]["window"]["mode"] == "recent"


def test_route_applies_the_done_window_and_show_all():
    payload = {
        "cards": [
            card("ancient", column="Done", completed_at="2000-01-01T00:00:00+00:00"),
            card("untimed", column="Done"),
            card("open", column="To do"),
        ]
    }
    client = _client()
    recent = client.post(PREFIX + "/view", json=payload)
    assert recent.status_code == 200
    body = recent.json()
    assert body["order"] == ["open", "untimed"]
    assert body["done"]["total"] == 2
    assert body["done"]["hidden"] == 1
    assert body["done"]["window"]["mode"] == "recent"
    assert body["done"]["window"]["days"] == 7
    assert isinstance(body["done"]["window"]["since"], str)
    shown = client.post(PREFIX + "/view", json={**payload, "done": "all"})
    assert shown.status_code == 200
    assert shown.json()["order"] == ["open", "ancient", "untimed"]
    assert shown.json()["done"]["hidden"] == 0
    assert shown.json()["done"]["window"] == {"mode": "all", "days": None, "since": None}


def test_stopped_work_is_human_todo_outside_done_window():
    from reminders_kanban.workflow.views import query_board
    card = dict(id="stopped", state="stopped", column="Done", owner="agent",
                stopped_at="2020-01-01T00:00:00Z", completed_at="2020-01-01T00:00:00Z")
    result = query_board([card], owner="human")
    assert result["columns"]["To do"][0]["label"] == "Stopped"
    assert result["done"]["total"] == 0
    assert card["column"] == "Done"
