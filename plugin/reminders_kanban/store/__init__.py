"""Durable occurrence state; one database per owning connection/profile."""

import fcntl
import sqlite3
from contextlib import contextmanager
from pathlib import Path


class CompletionStore:
    def __init__(self, path: str | Path):
        self.path = Path(path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS series (
                    id TEXT PRIMARY KEY, source TEXT UNIQUE NOT NULL, state TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS occurrences (
                    id TEXT PRIMARY KEY, series TEXT NOT NULL REFERENCES series(id),
                    state TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0
                );
                CREATE UNIQUE INDEX IF NOT EXISTS one_outstanding
                    ON occurrences(series) WHERE done = 0;
                CREATE TABLE IF NOT EXISTS attempts (
                    occurrence TEXT PRIMARY KEY REFERENCES occurrences(id),
                    state TEXT NOT NULL
                );
            """)

    @contextmanager
    def locked(self, *, wait=True):
        # Held across source calls; committed intent survives process death separately.
        # wait=False raises BlockingIOError at once when another holder has it, for callers
        # that already hold a lock others take after this one (they must not wait here).
        with self.path.with_suffix(self.path.suffix + ".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX if wait else fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.connection() as db:
                yield db

    @contextmanager
    def connection(self):
        """Short SQLite work without the lifecycle lock held across helper calls.

        Use locked() for workflow mutations. SQLite serializes schema and journal
        writes; display reads may observe the last committed lifecycle state.
        """
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA synchronous=FULL")
        try:
            yield db
        finally:
            db.close()
