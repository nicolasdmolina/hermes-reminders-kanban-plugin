"""Owner-scoped one-off actions. See delegation-contract.md."""

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr

from reminders_kanban.api.preview import Home
from reminders_kanban.execution import UnsupportedControl
from reminders_kanban.execution.admission import Admission
from reminders_kanban.reminders import helper

router = APIRouter()


class Action(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal[
        "activate", "deactivate", "ready", "take_over", "confirm_rerun", "tick", "accept",
        "resume", "maximum",
    ]
    run_id: StrictStr | StrictInt | None = None
    task_id: str | None = None
    expected: dict[str, Any] | None = None
    resources: list[str] = Field(default_factory=list)
    maximum: int | None = Field(default=None, ge=1, strict=True)
    instruction_version: int | None = Field(default=None, ge=1)


def service(home: Home):
    from reminders_kanban.workflow.delegation import Delegation

    if home is None:
        return None
    # Installation owns verified link-writing configuration.
    # A client cannot name another board/profile or supply a preservation-proof token.
    try:
        from reminders_kanban.links import origin_error
        from reminders_kanban.links.setup import Setup, read_state

        setup = Setup(home)
        origin, _, _ = setup.configuration()
        if origin_error(origin) or read_state(home).get("mode") == "local":
            origin = None
        profile = home.name if home.parent.name == "profiles" else "default"

        def write_link(expected, notes):
            # The helper saves these notes only if nothing but claim lines differs.
            return helper.run(
                "delegation-link", id=expected["id"], expected=expected, notes=notes
            )

        return Delegation(
            home,
            Admission(home),
            profile=profile,
            origin=origin,
            write_link=write_link,
            # A one-off given a repeat since it was delegated: its claim line is written by
            # the op that takes repeating reminders.
            write_other=lambda expected, notes: helper.run(
                "occurrence-link", id=expected["id"], expected=expected, notes=notes),
            link_setup=setup,
        )
    except (ImportError, ValueError):
        return None


Service = Annotated[Any, Depends(service)]


def run(service, action=None):
    if service is None:
        return {"status": "setup_required", "reason": "owner_board_unavailable"}
    try:
        return service.preview() if action is None else service.apply(**action.model_dump())
    except helper.HelperError as exc:
        return {"status": exc.code, "current": exc.current}
    except (ValueError, KeyError, TypeError, UnsupportedControl) as exc:
        return {"status": "attention", "reason": str(exc)}


@router.get("/delegation")
def preview(response: Response, owner: Service):
    response.headers["Cache-Control"] = "no-store"
    return run(owner)


@router.post("/delegation/actions")
def apply(action: Action, response: Response, owner: Service):
    response.headers["Cache-Control"] = "no-store"
    return run(owner, action)


@router.post("/delegation/{task_id}/stop")
def stop(task_id: str, response: Response, owner: Service):
    response.headers["Cache-Control"] = "no-store"
    if owner is None:
        return run(owner)
    try:
        return owner.stop(task_id)
    except helper.HelperError as exc:
        return {"status": exc.code, "current": exc.current}
    except (ValueError, KeyError, TypeError, UnsupportedControl) as exc:
        return {"status": "attention", "reason": str(exc)}
