"""One durable setup and last successful observation per owning profile."""

import json

from reminders_kanban.store import CompletionStore


class PreviewStore(CompletionStore):
    def __init__(self, path):
        super().__init__(path)
        with self.connection() as db:
            db.execute("CREATE TABLE IF NOT EXISTS preview (id INTEGER PRIMARY KEY, state TEXT)")
            db.commit()

    @staticmethod
    def read(db):
        row = db.execute("SELECT state FROM preview WHERE id = 1").fetchone()
        return (
            json.loads(row[0])
            if row
            else {
                "selected_list_ids": [],
                "selection_saved": False,
                "lists": [],
                "cards": [],
                "observed_at": None,
            }
        )

    @staticmethod
    def save(db, state):
        db.execute("INSERT OR REPLACE INTO preview VALUES (1, ?)", (json.dumps(state),))
        db.commit()
