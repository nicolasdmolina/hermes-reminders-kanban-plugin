"""Display-only board view. Contract: reminders_kanban/workflow/views.md."""

from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field

from reminders_kanban.workflow.views import query_board

router = APIRouter()


class ViewQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    cards: list[dict[str, Any]]
    queue: list[Annotated[str, Field(min_length=1)]] | None = None
    attention_events: list[dict[str, Any]] = Field(default_factory=list)
    stop_signals: list[dict[str, Any]] = Field(default_factory=list)
    owner: Literal["all", "human", "agent"] = "all"
    repeats: Literal["all", "recurring", "one_off"] = "all"
    list_ids: list[Annotated[str, Field(min_length=1)]] | None = None
    sort: Literal["default", "due", "priority", "created", "title"] = "default"
    done: Literal["recent", "all"] = "recent"


@router.post("/view")
def view(body: ViewQuery, response: Response):
    response.headers["Cache-Control"] = "no-store"
    try:
        return query_board(
            body.cards,
            owner=body.owner,
            repeats=body.repeats,
            list_ids=body.list_ids,
            sort=body.sort,
            done=body.done,
            queue=body.queue,
            attention_events=body.attention_events,
            stop_signals=body.stop_signals,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
