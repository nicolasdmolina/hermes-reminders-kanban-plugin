"""Authenticated recovery actions. Trusted reconciliation is intentionally not HTTP."""

from typing import Literal

from fastapi import APIRouter, Response
from pydantic import BaseModel, ConfigDict, Field

from reminders_kanban.api.delegation import Service, run
from reminders_kanban.execution import UnsupportedControl
from reminders_kanban.execution.recovery import Recovery
from reminders_kanban.reminders import helper

router = APIRouter()


class Action(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["tick", "retry"]
    source_id: str | None = None
    run_id: int | None = Field(default=None, ge=1, strict=True)


def retry(owner, source_id, run_id):
    if source_id is None or run_id is None:
        raise ValueError("source_id and run_id required")
    with owner.store.locked() as db:
        owner._active(db)  # Validate the board binding; existing tasks can retry while off.
        # Run again keeps the stopped run's row beside the new one: retry the current run.
        rows = [r for r in owner._rows(db) if r["expected"]["id"] == source_id]
        row = next((r for r in rows if not r.get("storage_key")), rows[-1] if rows else None)
        if row is None:
            raise ValueError("not delegated")
        with owner.admission.serialized() as conn:
            row = owner._observe(db, row, conn)
            recovery = Recovery(owner.control_factory(conn, owner.admission.kb))
            if (
                row.get("guard", {}).get("status") != "active"
                or row.get("recovery", {}).get("cause") != "ordinary"
                or not recovery.permit(row, deliberate=True, run_id=run_id)
            ):
                return dict(status="attention", task=row)
            owner._save(db, row)
            recovery.control.resume(row["task_id"])
        owner.admission.ready(row["task_id"], resources=row["resources"])
        return owner._tick(db)


@router.get("/recovery")
def preview(response: Response, owner: Service):
    response.headers["Cache-Control"] = "no-store"
    return run(owner)


@router.post("/recovery/actions")
def apply(action: Action, response: Response, owner: Service):
    response.headers["Cache-Control"] = "no-store"
    if owner is None:
        return run(owner)
    try:
        if action.action == "tick":
            return owner.apply("tick")
        return retry(owner, action.source_id, action.run_id)
    except helper.HelperError as exc:
        return dict(status=exc.code, current=exc.current)
    except (ValueError, KeyError, TypeError, UnsupportedControl) as exc:
        return dict(status="attention", reason=str(exc))
