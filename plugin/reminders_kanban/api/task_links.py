"""Authenticated, read-only task resolution. See task-links-contract.md."""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from reminders_kanban.api.preview import profile_home
from reminders_kanban.links import Links

router = APIRouter()


def observe(*, board, task, profile, home=None):
    # Resolution reads the requesting profile's own store and never creates it.
    import sqlite3

    from reminders_kanban.execution import TaskControl
    from reminders_kanban.execution import board as store
    from reminders_kanban.execution.runner import Backend
    from reminders_kanban.runtime import board_for

    home = home or profile_home()
    path = store.path_for(home)
    if board != board_for(home) or not path.exists():
        raise KeyError(task)
    with sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("BEGIN")
        return TaskControl(connection, Backend(None)).observe(task)


@router.get("/task-links/{owner_id}/{link_id}")
def resolve(owner_id: str, link_id: str, occurrence: str | None = None):
    # Hermes' dashboard auth answers 401 before any plugin route runs without a session.
    destination = dict(owner_id=owner_id, link_id=link_id, occurrence_id=occurrence)
    home = profile_home()
    result = (
        Links(home).resolve(owner_id, link_id, observe, occurrence)
        if home
        else dict(status="unavailable_owner", destination=destination, actions=[])
    )
    return JSONResponse(result, headers={"Cache-Control": "no-store"})
