"""Owner-scoped recovery observation; no identity reassignment endpoint."""

from typing import Literal

from fastapi import APIRouter, Response
from pydantic import BaseModel, ConfigDict

from reminders_kanban.api.delegation import Service, run
from reminders_kanban.api.occurrence import Service as OccurrenceService
from reminders_kanban.execution import UnsupportedControl
from reminders_kanban.reminders import helper
from reminders_kanban.workflow.reconciliation import snapshot

router = APIRouter()


class Action(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["recheck"]
    workflow: Literal["one_off", "recurring"]


def result(owner, refresh=False):
    if owner is None:
        return run(owner)
    try:
        return snapshot(owner, refresh=refresh)
    except helper.HelperError as exc:
        return dict(snapshot(owner), status="unavailable", reason=exc.code)
    except (ValueError, KeyError, UnsupportedControl) as exc:
        return dict(status="attention", reason=str(exc))


@router.get("/reconciliation")
def preview(response: Response, owner: Service, recurring: OccurrenceService):
    response.headers["Cache-Control"] = "no-store"
    return dict(one_off=result(owner), recurring=result(recurring))


@router.post("/reconciliation/actions")
def apply(action: Action, response: Response, owner: Service, recurring: OccurrenceService):
    response.headers["Cache-Control"] = "no-store"
    return result(owner if action.workflow == "one_off" else recurring, refresh=True)
