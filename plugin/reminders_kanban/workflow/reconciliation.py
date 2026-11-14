"""Fresh identity checks and recovery views for the owning profile."""

from contextlib import contextmanager
from contextvars import ContextVar

from reminders_kanban.claims import claims, short
from reminders_kanban.reminders import helper

_check_rows = ContextVar("identity_check_rows", default=None)
_related_source = ContextVar("identity_check_source", default=None)


@contextmanager
def source_check():
    token = _check_rows.set(_check_rows.get() if _check_rows.get() is not None else {})
    try:
        yield
    finally:
        _check_rows.reset(token)


@contextmanager
def fresh_source():
    parent = _check_rows.get()
    related_token = _related_source.set(None)
    token = _check_rows.set({})
    try:
        yield
    finally:
        _check_rows.reset(token)
        _related_source.reset(related_token)
        if parent is not None:
            parent.clear()


def invalidate_source():
    cache = _check_rows.get()
    if cache is not None:
        cache.clear()


def limit_source(expected):
    # Only related identities, copied links and matching history are needed for an action.
    _related_source.set(expected)
    invalidate_source()


def read_source(owner, identity):
    if _check_rows.get() is not None:
        rows = selected_sources(owner)
        exact = next((row for row in rows if row["id"] == identity), None)
        if exact is not None:
            return exact
    # Missing IDs need an exact lookup to distinguish deletion from a list move.
    return owner.call("read", id=identity)


IDENTITY_ERRORS = {
    "missing_identity", "identity_replaced", "multiple_candidates", "conflicting_links",
}


def links(source, me=None):
    """The claims that tie a reminder to this install's task: its own (`me`, its owner id), and
    any that can't be read. Another install's claim is not an identity question: the claim rules
    settle it (Delegation._settle_claims). me=None counts every claim."""
    return {
        (claim["owner"], claim["link"]) if claim["owner"] else claim["url"]
        for claim in claims(source.get("notes"))
        if me is None or claim["owner"] in (None, short(me))
    }


def check_identity(expected, rows, me=None):
    """Never infer authority from a replacement ID or a copied task link."""
    if not all(expected.get(k) for k in ("id", "externalId", "calendarId")):
        return "missing_identity"
    exact = [r for r in rows if r.get("id") == expected["id"]]
    candidates = [
        r for r in rows if not r.get("completed") and (
            r.get("externalId") == expected["externalId"] or links(r, me) & links(expected, me)
        )
    ]
    if len(exact) > 1 or len(candidates) > 1:
        return "multiple_candidates"
    if not exact:
        return "identity_replaced" if candidates else "deleted"
    fresh = exact[0]
    if not all(fresh.get(k) for k in ("id", "externalId", "calendarId")):
        return "missing_identity"
    if fresh["externalId"] != expected["externalId"]:
        return "identity_replaced"
    # A link line deleted from the notes is not a copy: no other reminder carries it (a copy
    # would be a second candidate above), so the reminder is still this one.
    if (links(fresh, me) and links(fresh, me) != links(expected, me)) or len(links(fresh, me)) > 1:
        return "conflicting_links"
    if any(r["id"] != expected["id"] for r in candidates):
        return "conflicting_links"
    return None


def terminal(row):
    if row["status"] == "done":
        return True
    receipt = row.get("stop_receipt") if row.get("stop_intent") else row.get("guard")
    return (row["status"] in {"stopped", "deleted"}
            and bool((receipt or {}).get("worker_stop_verified")))


def selected_sources(owner):
    selected = owner._selected()
    if not selected:
        raise helper.HelperError("source_ineligible", "no selected lists")
    cache = _check_rows.get()
    related = _related_source.get()
    fields = dict(calendarIds=selected)
    if related is not None:
        fields["relatedTo"] = related
    key = (id(owner), tuple(selected))
    if cache is None:
        return owner.call("read_many", **fields)
    if key not in cache:
        try:
            cache[key] = owner.call("read_many", **fields)
        except helper.HelperError as exc:
            cache[key] = exc
    if isinstance(cache[key], helper.HelperError):
        raise cache[key]
    return cache[key]


def completion_sources(owner, calendar):
    # Both native operations return the same full snapshot, including history.
    if _check_rows.get() is not None and calendar in owner._selected():
        return [row for row in selected_sources(owner) if row["calendarId"] == calendar]
    return owner.call("completion-read", calendarId=calendar)


def read_identity(owner, expected):
    if not owner._selected():
        raise helper.HelperError("source_ineligible", "no selected lists")
    try:
        rows = selected_sources(owner)
    except helper.HelperError as exc:
        raise helper.HelperError("source_unavailable", str(exc)) from exc
    reason = check_identity(expected, rows, getattr(owner, "install", None))
    if reason and reason != "deleted":
        raise helper.HelperError(reason, reason)
    return read_source(owner, expected["id"])


def snapshot(owner, *, refresh=False):
    """No admission. Existing completion intents follow their original reconciliation rules."""
    with source_check(), (owner.store.locked() if refresh else owner.store.connection()) as db:
        owner._active(db)  # enforce the installed board context
        rows = owner._rows(db)
        if refresh:
            for row in rows:
                if terminal(row):
                    continue
                with owner.admission.serialized() as conn:
                    owner._observe(db, row, conn)
            rows = owner._rows(db)
        cases = []
        for row in rows:
            if row.get("released"):
                continue  # Another Mac has it: finished here, nothing to check.
            guard = row.get("guard", {})
            reason = guard.get("reason") or row.get("reason")
            if not reason and row.get("source_wait"):
                reason = "source_unavailable"
            if row.get("completion", {}).get("status") == "needs_reconciliation":
                reason = row["completion"].get("reason")
            if row.get("series_state") in {"needs_reconciliation", "waiting_source"}:
                reason = row.get("held_reason") or "series_needs_reconciliation"
            if reason or row["status"] in {"needs_reconciliation", "preparation_attention"}:
                cases.append(dict(
                    key=row["key"], task_id=row["task_id"], reason=reason or row["status"],
                    action="recheck", automatic_rebind=False,
                ))
        unavailable = (any(c["reason"] == "source_unavailable" for c in cases)
                       or any(r.get("series_state") == "waiting_source" or r.get("source_wait")
                              or r.get("guard", {}).get("source_wait") for r in rows))
        held_series = any(r.get("series_state") == "needs_reconciliation" for r in rows)
        return dict(status="attention" if cases else "ok", tasks=rows, cases=cases,
                    freshness=("unavailable" if unavailable
                               else "checked" if refresh and not held_series else "unverified"),
                    dispatch_requires_fresh_read=True)
