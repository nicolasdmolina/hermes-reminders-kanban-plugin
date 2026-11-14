"""Read-only source preview. Public behavior and recovery: preview-contract.md."""

import hashlib
import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, ConfigDict, Field

from reminders_kanban.reminders import helper
from reminders_kanban.store.preview import PreviewStore

router = APIRouter()
COLUMNS = ["To do", "Ready for Agent", "In progress", "Needs you", "Done"]


def profile_home() -> Path | None:
    # Resolve on every request: Hermes binds the authenticated connection/profile context.
    try:
        from hermes_constants import get_hermes_home
    except ImportError:
        return None
    return Path(get_hermes_home()).resolve()


class Selection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    selected_list_ids: list[Annotated[str, Field(min_length=1)]] = Field(max_length=100)


def card(snapshot, owner):
    title = snapshot["title"]
    ready = title.startswith("[Agent · Ready]")
    agent = ready or title.startswith("[Agent]")
    return {
        "id": hashlib.sha256(f"{owner}\0{snapshot['id']}".encode()).hexdigest(),
        "owner": "agent" if agent else "human",
        "column": "Done" if snapshot["completed"] else "Ready for Agent" if ready else "To do",
        "recurring": bool(snapshot["rules"]),
        "imported_ready": ready,
        "every_occurrence_authorized": False,
        "eligible": False,
        "source": snapshot,
    }


def concurrency():
    try:
        from hermes_cli.config import load_config_readonly
    except ImportError:
        return 3
    config = load_config_readonly()
    value = (config.get("kanban") or {}).get("max_in_progress")
    return value if type(value) is int and value > 0 else 3


def envelope(state, owner, status, error=None):
    return {
        "status": status,
        "error": error,
        "owner_id": owner,
        "pickup_enabled": False,
        "columns": COLUMNS,
        "effective_concurrency": concurrency(),
        "setup": {
            "selected_list_ids": state["selected_list_ids"],
            "stage": "select_lists"
            if not state["selection_saved"]
            else "preview"
            if state["observed_at"]
            else "lists_selected"
            if state["selection_saved"]
            else "select_lists",
        },
        "lists": state["lists"],
        "cards": state["cards"],
        "observed_at": state["observed_at"],
        "ready_count": sum(c["imported_ready"] and c["column"] != "Done" for c in state["cards"]),
    }


def operate(home, refresh=False, selection=None):
    empty = {
        "selected_list_ids": [],
        "selection_saved": False,
        "lists": [],
        "cards": [],
        "observed_at": None,
    }
    if home is None:
        return envelope(empty, None, "unavailable_host", {"code": "unavailable_host"})
    owner = hashlib.sha256(str(home).encode()).hexdigest()
    try:
        store = PreviewStore(home / "reminders-kanban" / "state.sqlite3")
        watch = sqlite3.connect(store.path)
        try:
            with store.locked() as db:
                state = store.read(db)
                if not refresh:
                    return envelope(state, owner, "stale" if state["observed_at"] else "loading")
                seen = watch.execute("PRAGMA data_version").fetchone()
            if selection is None:
                # A plain refresh reads Reminders with the lock free, so a card action never
                # waits for it. It is kept only if nothing was written to this store meanwhile
                # (an action, a new list choice); otherwise the read below runs, as before.
                try:
                    lists = helper.run("lists")
                    selected = state["selected_list_ids"]
                    snapshots = None
                    if set(selected) <= {item["id"] for item in lists}:
                        snapshots = (
                            helper.run("read_many", calendarIds=selected) if selected else []
                        )
                except (helper.HelperError, OSError, ValueError):
                    snapshots = None  # The read below reports it.
                if snapshots is not None:
                    with store.locked() as db:
                        if watch.execute("PRAGMA data_version").fetchone() == seen:
                            state = {
                                **state,
                                "lists": lists,
                                "cards": [card(s, owner) for s in snapshots],
                                "observed_at": datetime.now(UTC).isoformat(),
                            }
                            store.save(db, state)
                            status = (
                                "select_lists"
                                if not state["selection_saved"]
                                else ("ready" if snapshots else "empty_list")
                            )
                            return envelope(state, owner, status)
        finally:
            watch.close()
        with store.locked() as db:
            state = store.read(db)
            try:
                lists = helper.run("lists")
                ids = {item["id"] for item in lists}
                selected = state["selected_list_ids"] if selection is None else selection
                if not set(selected) <= ids:
                    # With the lists as they are now, so the picker can drop the one that's gone.
                    return envelope(
                        {**state, "lists": lists},
                        owner,
                        "stale" if state["observed_at"] else "read_failure",
                        {"code": "list_unavailable"},
                    )
                if selection is not None:
                    # Save the choice before reading: access/read failure can be resumed.
                    state = {
                        **empty,
                        "selected_list_ids": sorted(set(selected)),
                        "selection_saved": True,
                        "lists": lists,
                    }
                    store.save(db, state)
                snapshots = helper.run("read_many", calendarIds=selected) if selected else []
                state = {
                    **state,
                    "lists": lists,
                    "cards": [card(s, owner) for s in snapshots],
                    "observed_at": datetime.now(UTC).isoformat(),
                }
                store.save(db, state)
                status = (
                    "select_lists"
                    if not state["selection_saved"]
                    else ("ready" if snapshots else "empty_list")
                )
                return envelope(state, owner, status)
            except (helper.HelperError, OSError, ValueError) as exc:
                code = exc.code if isinstance(exc, helper.HelperError) else "failed"
                status = (
                    "access_denied"
                    if code == "access_denied"
                    else ("stale" if state["observed_at"] else "read_failure")
                )
                return envelope(state, owner, status, {"code": code})
    except (OSError, sqlite3.Error, json.JSONDecodeError):
        return envelope(empty, owner, "persistence_failed", {"code": "persistence_failed"})


Home = Annotated[Path | None, Depends(profile_home)]


@router.get("/setup")
def setup(response: Response, home: Home):
    response.headers["Cache-Control"] = "no-store"
    return operate(home)


@router.get("/preview")
def preview(response: Response, home: Home):
    response.headers["Cache-Control"] = "no-store"
    return operate(home, refresh=True)


@router.put("/setup")
def save_setup(selection: Selection, response: Response, home: Home):
    response.headers["Cache-Control"] = "no-store"
    return operate(home, refresh=True, selection=selection.selected_list_ids)
