"""Display queries over board cards. See views.md for the contract.

This module does not read or write Apple Reminders, and it does not reorder
the execution queue it is given.
"""

import copy
from datetime import UTC, datetime, timedelta

COLUMNS = ("To do", "Ready for Agent", "In progress", "Needs you", "Done")
OWNERS = frozenset({"all", "human", "agent"})
REPEATS = frozenset({"all", "recurring", "one_off"})
SORTS = frozenset({"default", "due", "priority", "created", "title"})
DONE_WINDOWS = frozenset({"recent", "all"})
DONE_WINDOW_DAYS = 7

# Apple EventKit priorities: 1 high, 5 medium, 9 low, 0 none. Lower rank sorts first.
_PRIORITY_RANK = {1: 0, 5: 1, 9: 2, 0: 3}


def query_board(
    cards,
    *,
    owner="all",
    repeats="all",
    list_ids=None,
    sort="default",
    queue=None,
    attention_events=None,
    stop_signals=None,
    done="recent",
    now=None,
):
    """Return a display view of cards. Queue, attention events, and stop signals pass through."""
    if owner not in OWNERS:
        raise ValueError("owner must be all, human, or agent")
    if repeats not in REPEATS:
        raise ValueError("repeats must be all, recurring, or one_off")
    if sort not in SORTS:
        raise ValueError("sort must be default, due, priority, created, or title")
    if done not in DONE_WINDOWS:
        raise ValueError("done must be recent or all")
    _require_cards(cards)
    selected = _require_list_ids(list_ids)
    returned_queue = _copy_queue(queue)
    events = _copy_records(attention_events, "attention_events")
    signals = _copy_records(stop_signals, "stop_signals")

    matched = []
    hidden = []
    for card in cards:
        if card.get("state", card.get("status")) == "stopped":
            card = dict(card, column="To do", owner="human", label="Stopped", accepted=False)
        reasons = _hidden_by(card, owner, repeats, selected)
        if reasons:
            if card.get("column") == "Needs you":
                hidden.append(_hidden_attention(card, reasons))
        else:
            matched.append(copy.deepcopy(card))

    key = _sort_key(sort)
    columns = {name: [] for name in COLUMNS}
    unplaced = []
    for card in matched:
        bucket = columns.get(card.get("column"))
        if bucket is None:
            unplaced.append(card)
        else:
            bucket.append(card)
    for bucket in (*columns.values(), unplaced):
        bucket.sort(key=key)
    hidden.sort(key=lambda item: _needs_you_key(item["_card"]))
    for item in hidden:
        del item["_card"]

    limited = _limit_done(columns["Done"], done, _as_utc(now))
    columns["Done"] = limited["visible"]

    order = [card["id"] for name in COLUMNS for card in columns[name]]
    order.extend(card["id"] for card in unplaced)
    return {
        "columns": columns,
        "unplaced": unplaced,
        "order": order,
        "matched_count": len(matched) - limited["hidden"],
        "done": {
            "total": limited["total"],
            "hidden": limited["hidden"],
            "window": limited["window"],
        },
        "attention": {
            "needs_you_count": sum(card.get("column") == "Needs you" for card in cards),
            "hidden": hidden,
            "reveal": _reveal(hidden, owner, repeats, list_ids, sort),
        },
        "attention_events": events,
        "stop_signals": signals,
        "queue": returned_queue,
    }


def _require_cards(cards):
    if not isinstance(cards, list):
        raise ValueError("cards must be a list")
    for card in cards:
        if not isinstance(card, dict) or not isinstance(card.get("id"), str) or not card["id"]:
            raise ValueError("each card needs a non-empty string id")


def _require_list_ids(list_ids):
    if list_ids is None:
        return None
    if not isinstance(list_ids, list) or not all(_nonempty_str(item) for item in list_ids):
        raise ValueError("list_ids must be a list of non-empty strings or null")
    return set(list_ids)


def _copy_queue(queue):
    if queue is None:
        return None
    if not isinstance(queue, list) or not all(isinstance(item, str) and item for item in queue):
        raise ValueError("queue must be a list of non-empty strings")
    return list(queue)


def _copy_records(records, label):
    if records is None:
        return []
    if not isinstance(records, list) or not all(isinstance(item, dict) for item in records):
        raise ValueError(f"{label} must be a list of objects")
    return copy.deepcopy(records)


def _source(card):
    source = card.get("source")
    return source if isinstance(source, dict) else {}


def _list_id(card):
    own = card.get("list_id")
    if isinstance(own, str) and own:
        return own
    calendar = _source(card).get("calendarId")
    return calendar if isinstance(calendar, str) and calendar else None


def _hidden_by(card, owner, repeats, selected):
    reasons = []
    if owner != "all" and card.get("owner") != owner:
        reasons.append("owner")
    recurring = card.get("recurring") is True
    if repeats == "recurring" and not recurring:
        reasons.append("repeats")
    elif repeats == "one_off" and recurring:
        reasons.append("repeats")
    if selected is not None and _list_id(card) not in selected:
        reasons.append("list")
    return reasons


def _hidden_attention(card, reasons):
    owner = card.get("owner")
    action = card.get("action")
    requested = card.get("requested_at")
    return {
        "id": card["id"],
        "owner": owner if owner in {"human", "agent"} else None,
        "recurring": card.get("recurring") is True,
        "list_id": _list_id(card),
        "action": action if isinstance(action, str) else None,
        "requested_at": requested if isinstance(requested, str) else None,
        "hidden_by": reasons,
        "_card": card,
    }


def _reveal(hidden, owner, repeats, list_ids, sort):
    if not hidden:
        return None
    next_owner = "all" if any("owner" in item["hidden_by"] for item in hidden) else owner
    next_repeats = "all" if any("repeats" in item["hidden_by"] for item in hidden) else repeats
    if any("list" in item["hidden_by"] for item in hidden):
        if any(item["list_id"] is None and "list" in item["hidden_by"] for item in hidden):
            next_lists = None
        else:
            selected = set(list_ids or [])
            extra = {item["list_id"] for item in hidden if "list" in item["hidden_by"]}
            next_lists = sorted(selected | extra)
    else:
        next_lists = None if list_ids is None else list(list_ids)
    return {
        "owner": next_owner,
        "repeats": next_repeats,
        "list_ids": next_lists,
        "sort": sort,
    }


def _sort_key(sort):
    if sort == "default":
        return _default_key
    return lambda card: _override_key(card, sort)


def _default_key(card):
    column = card.get("column")
    ident = card["id"]
    if column == "To do":
        return (_due_key(_due(card)), _priority_rank(card), ident)
    if column == "Ready for Agent":
        return (_time_key(card.get("ready_at")), ident)
    if column == "In progress":
        # Active work sorts before an automatic capacity wait.
        waiting = 1 if card.get("waiting") is True else 0
        return (waiting, _time_key(card.get("started_at")), ident)
    if column == "Needs you":
        return _needs_you_key(card)
    if column == "Done":
        return (_time_key(_completed(card), newest_first=True), ident)
    return (ident,)


def _needs_you_key(card):
    return (_time_key(card.get("requested_at")), card["id"])


def _override_key(card, sort):
    ident = card["id"]
    if sort == "due":
        return (_due_key(_due(card)), ident)
    if sort == "priority":
        return (_priority_rank(card), ident)
    if sort == "created":
        return (_time_key(_created(card)), ident)
    return (_title(card).casefold(), _title(card), ident)


def _due(card):
    due = _source(card).get("due")
    return due if isinstance(due, dict) else None


def _nonempty_str(value):
    return isinstance(value, str) and bool(value)


def _whole(value):
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _due_key(due):
    """Local calendar order. Undated last. All-day before a timed reminder on the same date.

    Timed reminders compare wall-clock components, then the time zone name.
    This does not convert zones to an instant and does not invent a midnight.
    """
    if not isinstance(due, dict):
        return (1,)
    year, month, day = _whole(due.get("year")), _whole(due.get("month")), _whole(due.get("day"))
    if year is None or month is None or day is None:
        return (1,)
    hour = due.get("hour")
    if hour is None:
        return (0, year, month, day, 0, 0, 0, 0, "")
    hour_n = _whole(hour)
    if hour_n is None:
        return (1,)
    minute = _whole(due.get("minute"))
    second = _whole(due.get("second"))
    zone = due.get("timeZone")
    return (
        0,
        year,
        month,
        day,
        1,
        hour_n,
        0 if minute is None else minute,
        0 if second is None else second,
        zone if isinstance(zone, str) else "",
    )


def _priority_rank(card):
    source = _source(card)
    value = source["priority"] if "priority" in source else card.get("priority")
    if isinstance(value, bool) or not isinstance(value, int):
        return 4
    # Other apps write the values in between: 2-4 read as high and 6-8 as low, as on the card.
    if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 9:
        value = 1 if value <= 4 else 5 if value == 5 else 9
    return _PRIORITY_RANK.get(value, 4)


def _title(card):
    source = _source(card)
    value = source["title"] if "title" in source else card.get("title", "")
    return value if isinstance(value, str) else ""


def _created(card):
    own = card.get("created_at")
    if isinstance(own, str):
        return own
    value = _source(card).get("created")
    return value if isinstance(value, str) else None


def _completed(card):
    own = card.get("completed_at")
    if isinstance(own, str):
        return own
    value = _source(card).get("completedAt")
    return value if isinstance(value, str) else None


def _time_key(value, *, newest_first=False):
    """Missing and unparseable times sort last. A value with no offset is treated as UTC."""
    stamp = _timestamp(value)
    if stamp is None:
        return (1, 0.0)
    return (0, -stamp if newest_first else stamp)


def _as_utc(now):
    moment = datetime.now(UTC) if now is None else now
    if moment.tzinfo is None:
        return moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC)


def _limit_done(cards, done, moment):
    """Drop Done cards completed before the window. A missing time stays in place."""
    total = len(cards)
    if done == "all":
        return {
            "visible": cards,
            "total": total,
            "hidden": 0,
            "window": {"mode": "all", "days": None, "since": None},
        }
    since = moment - timedelta(days=DONE_WINDOW_DAYS)
    visible = []
    hidden = 0
    for card in cards:
        completed = _parsed_time(_completed(card))
        if completed is None or completed >= since:
            visible.append(card)
        else:
            hidden += 1
    return {
        "visible": visible,
        "total": total,
        "hidden": hidden,
        "window": {"mode": "recent", "days": DONE_WINDOW_DAYS, "since": since.isoformat()},
    }


def _parsed_time(value):
    """UTC instant. A value with no offset is UTC. Missing and unparseable values are None."""
    if not isinstance(value, str) or not value:
        return None
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _timestamp(value):
    parsed = _parsed_time(value)
    if parsed is None:
        return None
    return parsed.timestamp()
