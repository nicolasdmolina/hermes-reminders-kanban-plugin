"""Plugin-owned board defaults; null fields retain dynamic profile inheritance."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, StrictStr, field_validator, model_validator

from reminders_kanban.store import CompletionStore


class ModelChoice(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    model: StrictStr | None = None
    provider: StrictStr | None = None
    effort: Literal[
        "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"
    ] | None = None

    @field_validator("model", "provider")
    @classmethod
    def nonblank(cls, value):
        if value is not None and (not value.strip() or value != value.strip()):
            raise ValueError("model and provider must be nonblank, unpadded identifiers")
        return value

    @model_validator(mode="after")
    def paired(self):
        if (self.model is None) != (self.provider is None):
            raise ValueError("model and provider must be selected together")
        return self

    def task_fields(self):
        return dict(model_override=self.model, provider_override=self.provider,
                    reasoning_effort=self.effort)


class ModelChoices:
    def __init__(self, home, board):
        self.board = board
        self.store = CompletionStore(home / "reminders-kanban/model-choice.sqlite3")
        with self.store.connection() as db:
            db.execute("CREATE TABLE IF NOT EXISTS model_choices "
                       "(board TEXT PRIMARY KEY, choice TEXT NOT NULL)")

    def read(self):
        with self.store.connection() as db:
            row = db.execute("SELECT choice FROM model_choices WHERE board=?",
                             (self.board,)).fetchone()
        return ModelChoice.model_validate_json(row[0]) if row else ModelChoice()

    def save(self, choice: ModelChoice):
        with self.store.locked() as db:
            db.execute("INSERT INTO model_choices VALUES (?, ?) ON CONFLICT(board) "
                       "DO UPDATE SET choice=excluded.choice",
                       (self.board, choice.model_dump_json()))
            db.commit()
        return choice
