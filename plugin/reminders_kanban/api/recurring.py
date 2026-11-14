"""Every occurrence actions; see recurring-contract.md."""

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, ConfigDict, Field

from reminders_kanban.api.delegation import run
from reminders_kanban.api.occurrence import service

router = APIRouter()


class Action(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["every", "tick", "accept", "retry", "resolve_series"]
    hold_id: str | None = None
    decision: Literal["end", "reauthorize"] | None = None
    confirmed_cause: str | None = None
    expected: dict[str, Any] | None = None
    occurrence_id: str | None = None
    run_id: int | None = None
    resources: list[str] = Field(default_factory=list)
    take_over: bool = False


Service = Annotated[Any, Depends(service)]


@router.get("/recurring")
def preview(response: Response, owner: Service):
    response.headers["Cache-Control"] = "no-store"
    return run(owner)


@router.post("/recurring/actions")
def apply(action: Action, response: Response, owner: Service):
    response.headers["Cache-Control"] = "no-store"
    return run(owner, action)
