"""Current occurrence actions; see occurrence-contract.md."""

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr

from reminders_kanban.api.delegation import run
from reminders_kanban.api.delegation import service as delegation_service
from reminders_kanban.api.preview import Home

router = APIRouter()


class Action(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["resolve_advance", "ready", "confirm_rerun", "tick", "accept", "stop", "rerun"]
    intent_id: str | None = None
    answer: Literal["checked_off", "date_moved"] | None = None
    run_id: StrictStr | StrictInt | None = None
    expected: dict[str, Any] | None = None
    occurrence_id: str | None = None
    resources: list[str] = Field(default_factory=list)
    # Take over here: replace another Mac's claim on the reminder (delegation-contract.md).
    take_over: bool = False


def service(home: Home):
    from reminders_kanban.reminders import helper
    from reminders_kanban.workflow.occurrence import OccurrenceDelegation

    def write_link(expected, notes):
        return helper.run(
            "occurrence-link",
            id=expected["id"],
            expected=expected,
            notes=notes,
        )

    owner = delegation_service(home)
    if owner is None:
        return None
    return OccurrenceDelegation(
        home,
        owner.admission,
        profile=owner.profile,
        origin=owner.origin,
        write_link=write_link,
        write_other=owner.write_link,
        link_setup=owner.link_setup,
    )


Service = Annotated[Any, Depends(service)]


@router.get("/occurrences")
def preview(response: Response, owner: Service):
    response.headers["Cache-Control"] = "no-store"
    return run(owner)


@router.post("/occurrences/actions")
def apply(action: Action, response: Response, owner: Service):
    response.headers["Cache-Control"] = "no-store"
    return run(owner, action)
