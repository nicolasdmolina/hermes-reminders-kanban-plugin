"""Board model choice. See model-choice-contract.md."""

from fastapi import APIRouter, Response

from reminders_kanban.api.preview import Home
from reminders_kanban.model_choice import ModelChoice, ModelChoices
from reminders_kanban.runtime import board_for

router = APIRouter()


def result(home, response, choice=None):
    response.headers["Cache-Control"] = "no-store"
    if home is None:
        return {"status": "setup_required", "reason": "owner_board_unavailable"}
    settings = ModelChoices(home, board_for(home))
    current = settings.read() if choice is None else settings.save(choice)
    return {"status": "ok", "model_choice": current.model_dump()}


@router.get("/model-choice")
def read(home: Home, response: Response):
    return result(home, response)


@router.post("/model-choice")
def save(choice: ModelChoice, home: Home, response: Response):
    return result(home, response, choice)
