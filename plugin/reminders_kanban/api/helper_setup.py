"""Explicit local helper preparation; host authentication applies to these routes."""

from typing import Literal

from fastapi import APIRouter, Response
from pydantic import BaseModel, ConfigDict

from reminders_kanban.api.preview import Home
from reminders_kanban.reminders import helper_setup

router = APIRouter()


class Action(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["prepare", "install_tools"]


@router.get("/helper-setup")
def get_setup(response: Response, home: Home):
    response.headers["Cache-Control"] = "no-store"
    if home is None:
        return {"status": "setup_failed", "message": "Connect to the owning Hermes profile first."}
    return helper_setup.inspect()


@router.post("/helper-setup")
def prepare_setup(body: Action, response: Response, home: Home):
    response.headers["Cache-Control"] = "no-store"
    if home is None:
        return {"status": "setup_failed", "message": "Connect to the owning Hermes profile first."}
    return helper_setup.prepare(body.action)
