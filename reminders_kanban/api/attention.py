"""Backend contract for ticket 15; mounted in the authenticated host API."""

from typing import Literal

from fastapi import APIRouter, Query, Response
from pydantic import BaseModel, ConfigDict, Field

from reminders_kanban.api.delegation import Service
from reminders_kanban.execution import UnsupportedControl
from reminders_kanban.model_choice import ModelChoice
from reminders_kanban.reminders import helper
from reminders_kanban.workflow.attention import Attention

router = APIRouter()


class Submission(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(min_length=1, max_length=200)
    task_id: str = Field(min_length=1)
    token: str = Field(min_length=1)
    action: Literal["reply", "request_changes"]
    text: str = Field(min_length=1, max_length=100000)
    model_choice: ModelChoice | None = None


def run(owner, **arguments):
    if owner is None:
        return dict(status="setup_required", reason="owner_board_unavailable")
    try:
        service = Attention(owner)
        return service.submit(**arguments) if "action" in arguments else service.feed(**arguments)
    except helper.HelperError as exc:
        return dict(status=exc.code, current=exc.current)
    except (ValueError, KeyError, UnsupportedControl) as exc:
        return dict(status="attention", reason=str(exc))


@router.get("/attention")
def feed(response: Response, owner: Service, after: int = Query(default=0, ge=0)):
    response.headers["Cache-Control"] = "no-store"
    return run(owner, after=after)


@router.post("/attention/submissions")
def submit(body: Submission, response: Response, owner: Service):
    response.headers["Cache-Control"] = "no-store"
    return run(owner, **body.model_dump())
