"""Authenticated, read-only task resolution. See task-links-contract.md."""

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from reminders_kanban.api.preview import profile_home
from reminders_kanban.links import Links

router = APIRouter()


def authenticate(request):
    # Reuse the installed host guard, including native and hosted-plugin IPC auth.
    # Neither URL parameters nor caller-supplied headers assert ownership here.
    from hermes_cli.web_server import _require_token

    _require_token(request)


def observe(*, board, task, profile):
    # Resolution must not create missing boards or migrate/repair shared databases.
    import sqlite3

    from hermes_cli import kanban_db as kb

    from reminders_kanban.execution import TaskControl

    path = kb.kanban_db_path(board=board).resolve()
    with sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("BEGIN")
        observation = TaskControl(connection, kb).observe(task)
        sessions = {
            event.run_id: event.payload.get("session_id")
            for event in kb.list_events(connection, task)
            if event.kind == "owner_admitted" and isinstance(event.payload, dict)
        }
        for run in observation["runs"]:
            run["session_id"] = sessions.get(run["id"])
        return observation


@router.get("/task-links/{owner_id}/{link_id}")
def resolve(request: Request, owner_id: str, link_id: str, occurrence: str | None = None):
    destination = dict(owner_id=owner_id, link_id=link_id, occurrence_id=occurrence)
    try:
        authenticate(request)
    except (ImportError, HTTPException):
        return JSONResponse(
            dict(status="sign_in_required", destination=destination, actions=[]),
            status_code=401,
            headers={"Cache-Control": "no-store"},
        )
    home = profile_home()
    result = (
        Links(home).resolve(owner_id, link_id, observe, occurrence)
        if home
        else dict(status="unavailable_owner", destination=destination, actions=[])
    )
    return JSONResponse(result, headers={"Cache-Control": "no-store"})
