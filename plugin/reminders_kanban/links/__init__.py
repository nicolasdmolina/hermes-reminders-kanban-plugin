"""Durable destinations, created only by trusted reminder reconciliation."""

import ipaddress
import json
import sqlite3
import time
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit
from uuid import uuid4

PREFIX = "/api/plugins/reminders-kanban/task-links"
# The browser page (dashboard plugin tab) that renders a destination; it calls PREFIX.
PAGE = "/reminders"


def origin_error(origin):
    try:
        parsed = urlsplit(origin or "")
        host = parsed.hostname or ""
        _ = parsed.port
        if parsed.username is not None or parsed.password is not None:
            return "has_credentials"
        if parsed.scheme != "https" or not host:
            return "not_https"
        try:
            loopback = ipaddress.ip_address(host).is_loopback
        except ValueError:
            loopback = host.lower() == "localhost" or host.lower().endswith(".localhost")
        if loopback:
            return "loopback"
        if parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
            return "has_path"
        if any(c.isspace() or ord(c) < 32 for c in origin):
            return "not_https"
    except (ValueError, TypeError):
        return "not_https"
    return None


def link_url(origin, owner, link, profile, mac=None, taken=None, take=0, start=0):
    """The task's page. mac: this Mac's name, so another Mac can say whose task it is. start:
    when this run first claimed the reminder (claims.py), base 36. taken: the install a
    person's Take over took the reminder from; take: its place in a chain of take overs,
    written from the second on. The resolver ignores all four."""
    if origin_error(origin):
        raise ValueError("an existing reachable HTTPS owner origin without credentials is required")
    fields = {"owner": owner, "link": link, "profile": profile}
    if mac:
        fields["mac"] = mac
    if start:
        from reminders_kanban.claims import base36

        fields["t"] = base36(start)
    if taken:
        fields["from"] = taken
        if take > 1:
            fields["take"] = take
    query = urlencode(fields)
    return f"{origin.rstrip('/')}{PAGE}?{query}"


def page_url(url):
    """A task's link as its row keeps it: without what only its claim line says (start time,
    take over), so the task keeps one address from run to run."""
    if not url:
        return url
    parts = urlsplit(url)
    query = urlencode([(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True)
                       if key not in {"t", "from", "take"}])
    return parts._replace(query=query).geturl()


def delivered_result(observed):
    runs = [
        run
        for run in observed["runs"]
        if run.get("outcome") in {"review_requested", "completed"}
        and (run.get("metadata") or {}).get("approval") != "manual"
    ]
    latest = max(runs, key=lambda run: run["id"], default=None)
    return latest.get("summary") if latest else observed["task"].get("result")


class Links:
    def __init__(self, home: Path):
        self.path = home / "reminders-kanban" / "links.sqlite3"

    SCHEMA = """
        CREATE TABLE IF NOT EXISTS owner (id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS links (
            id TEXT PRIMARY KEY, reminder TEXT UNIQUE, current TEXT);
        CREATE TABLE IF NOT EXISTS occurrences (
            link TEXT, id TEXT, binding TEXT, PRIMARY KEY(link, id));
        CREATE TABLE IF NOT EXISTS install (key TEXT PRIMARY KEY, value TEXT);
    """

    def _read(self, query, *values):
        """One read that never creates the database: [] when it or the table isn't there."""
        if not self.path.exists():
            return []
        try:
            with sqlite3.connect(f"{self.path.as_uri()}?mode=ro", uri=True) as db:
                return db.execute(query, values).fetchall()
        except sqlite3.Error:
            return []

    def owner_id(self, create=True):
        """This install's id: the owner in every link and claim it writes. Minted on demand, so
        it exists before the first claim is written. create=False only reads (None if unset)."""
        row = self._read("SELECT id FROM owner")
        if row or not create:
            return row[0][0] if row else None
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.path) as db:
            db.executescript(self.SCHEMA)
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT id FROM owner").fetchone()
            if not row:
                row = (str(uuid4()),)
                db.execute("INSERT INTO owner VALUES (?)", row)
            return row[0]

    def known(self, link):
        """Whether this install still has the task a claim of its own names (a full link id,
        or the first eight characters a compact claim line carries)."""
        return str(link or "")[:8] in self.known_links()

    def known_links(self):
        """The short ids (first eight characters) of every task link this install has."""
        return {row[0][:8] for row in self._read("SELECT id FROM links")}

    def _foreign_seen_at(self):
        row = self._read("SELECT value FROM install WHERE key='seen_foreign'")
        try:
            return float(row[0][0]) if row else None
        except ValueError:
            return 0.0  # Recorded before the time was kept: counts from the next sighting.

    def seen_foreign(self, now=None):
        """Whether another install's claim was seen on an open reminder in the last 30 days
        (two Macs share its reminders): new work then waits out the settle window."""
        from reminders_kanban.claims import FOREIGN_SEEN_SECONDS

        seen = self._foreign_seen_at()
        if seen is None:
            return False
        return seen == 0.0 or (time.time() if now is None else now) - seen < FOREIGN_SEEN_SECONDS

    def mark_foreign(self, now=None):
        now = time.time() if now is None else now
        seen = self._foreign_seen_at()
        if seen and now - seen < 3600:
            return  # Fresh enough: no write on every board read.
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.path) as db:
            db.executescript(self.SCHEMA)
            db.execute("INSERT OR REPLACE INTO install VALUES ('seen_foreign', ?)", (str(now),))

    def bind(self, reminder, occurrence, board, task, profile):
        """Trusted workflow only: identity must already be reconciled, never from notes.

        One reminder/series key retains one link. New occurrences move current;
        old occurrences remain immutable. Replay cannot move current backwards.
        """
        if not all((reminder, occurrence, board, task, profile)):
            raise ValueError("complete owner binding required")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.path) as db:
            db.executescript(self.SCHEMA)
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT id FROM owner").fetchone()
            owner = row[0] if row else str(uuid4())
            if not row:
                db.execute("INSERT INTO owner VALUES (?)", (owner,))
            row = db.execute("SELECT id FROM links WHERE reminder=?", (reminder,)).fetchone()
            link = row[0] if row else str(uuid4())
            if not row:
                db.execute("INSERT INTO links VALUES (?, ?, ?)", (link, reminder, occurrence))
            binding = json.dumps(dict(board=board, task=task, profile=profile), sort_keys=True)
            old = db.execute(
                "SELECT binding FROM occurrences WHERE link=? AND id=?", (link, occurrence)
            ).fetchone()
            if old and old[0] != binding:
                raise ValueError("occurrence is already bound to another task")
            if not old:
                db.execute("INSERT INTO occurrences VALUES (?, ?, ?)", (link, occurrence, binding))
                db.execute("UPDATE links SET current=? WHERE id=?", (occurrence, link))
            return owner, link

    def resolve(self, owner, link, observe, occurrence=None):
        destination = dict(owner_id=owner, link_id=link, occurrence_id=occurrence)

        def result(status, **values):
            return dict(status=status, destination=destination, actions=[], **values)

        if not self.path.exists():
            return result("wrong_owner")
        try:
            with sqlite3.connect(f"{self.path.as_uri()}?mode=ro", uri=True) as db:
                if db.execute("SELECT id FROM owner").fetchone() != (owner,):
                    return result("wrong_owner")
                row = db.execute("SELECT current FROM links WHERE id=?", (link,)).fetchone()
                if not row:
                    return result("not_found")
                current = row[0]
                rows = db.execute(
                    "SELECT id, binding FROM occurrences WHERE link=?", (link,)
                ).fetchall()
            bindings = {key: json.loads(value) for key, value in rows}
            selected = occurrence or current
            if selected not in bindings:
                return result("not_found")
            binding = bindings[selected]
            observed = observe(**binding)
            if observed["task"]["assignee"] != binding["profile"] or any(
                run.get("profile", binding["profile"]) != binding["profile"]
                for run in observed["runs"]
            ):
                return result("wrong_owner")
            historical = selected != current
            state = observed["state"]
            actions = (
                []
                if historical
                else {
                    "question": ["comment", "resume"],
                    "result": ["accept", "request_changes"],
                    "failed": ["comment", "resume"],
                    "paused": ["comment", "resume"],
                    "active": ["pause", "stop"],
                    "ready": ["stop"],
                }.get(state, [])
            )
            return {
                "status": "resolved",
                "destination": destination,
                "binding": binding,
                "title": observed["task"].get("title"),
                "current_occurrence_id": current,
                "selected_occurrence_id": selected,
                "historical": historical,
                "occurrence_ids": list(bindings),
                "state": state,
                "actions": actions,
                "question": observed["summary"] if state == "question" else None,
                "result": delivered_result(observed) if state in {"result", "done"} else None,
                "comments": observed["comments"],
                "attempts": observed["runs"],
                "transcript_mode": "read_only",
            }
        except KeyError:
            return result("not_found")
        except (OSError, sqlite3.Error, ValueError):
            return result("unavailable_owner")
