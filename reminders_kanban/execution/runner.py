"""Agent runs through Hermes' public scheduled-job tool (``cronjob_manage``).

Each attempt is one Hermes scheduled job created for it alone: a one-shot far in the future
(so the scheduler never fires it on its own), started at once with the tool's ``run`` action,
stopped with ``cancel`` and removed when the attempt is over. Hermes runs it unattended,
under its own approval rules for scheduled jobs, on the profile's main model. The agent
hands its result or question back through this plugin's tools (``tools.py``).
"""

import contextvars
import json
import threading

from reminders_kanban.execution import board

JOB_PREFIX = "Reminders: "
NEVER = "2036-01-01T00:00:00"
# How long a run nobody here waits on (Hermes restarted) may stay silent before it is failed.
ORPHAN_LIMIT = 2 * 3600
FINISH, ASK = "reminders_kanban_finish", "reminders_kanban_ask"


# Stores swept for leftover jobs since this process started; afterwards only while runs are pending.
_SWEPT = set()


class CronUnavailable(RuntimeError):
    """Hermes' scheduled-job tool refused or is missing."""


def dispatch(args):
    from tools.registry import discover_builtin_tools, registry

    if registry.get_entry("cronjob_manage") is None:
        discover_builtin_tools()
    raw = registry.dispatch("cronjob_manage", args)
    try:
        answer = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError as exc:
        raise CronUnavailable(str(raw)[:200]) from exc
    if not isinstance(answer, dict) or answer.get("error") or answer.get("success") is False:
        raise CronUnavailable(str((answer or {}).get("error") or answer)[:300])
    return answer


def prompt(task, comments):
    lines = [
        "A person handed you this task from their Apple Reminders. Do it now, on your own.",
        "",
        f"Task: {task.title}",
    ]
    if (task.body or "").strip():
        lines += ["", "Notes:", task.body.strip()]
    replies = [c for c in comments if c.author.startswith("reminders-kanban:")]
    if replies:
        lines += ["", "Earlier in this task the person wrote:"]
        lines += [f"- {c.body.strip()}" for c in replies]
    if task.result:
        lines += ["", "Your last result was:", task.result.strip()]
    lines += [
        "",
        f"When you are done, call the {FINISH} tool once with a short summary of the result. "
        f"If you cannot go on without an answer only the person can give, call the {ASK} tool "
        "with one clear question instead, and stop.",
        "These tools may not be listed directly: find them with tool_search, or call them "
        "through tool_call.",
        "Never mark the reminder complete yourself. The person accepts your result.",
    ]
    return "\n".join(lines)


class Cron:
    """Thin client for the scheduled-job tool. Tests replace it."""

    def create(self, name, text):
        answer = dispatch({"action": "create", "name": name, "prompt": text, "schedule": NEVER,
                           "deliver": "local"})
        job_id = answer.get("job_id") or (answer.get("job") or {}).get("job_id")
        if not job_id:
            raise CronUnavailable("Hermes did not return a job")
        return job_id

    def run(self, job_id):
        return dispatch({"action": "run", "job_id": job_id})

    def cancel(self, job_id, reason):
        try:
            return dispatch({"action": "cancel", "job_id": job_id, "reason": reason})
        except CronUnavailable:
            return None  # Not running: nothing to stop.

    def remove(self, job_id):
        try:
            dispatch({"action": "remove", "job_id": job_id})
        except CronUnavailable:
            pass  # Already gone.

    def jobs(self):
        return {j["job_id"]: j for j in dispatch({"action": "list"}).get("jobs", [])}


class Backend:
    """The store's operations (``board``) plus the runner that stops its jobs."""

    def __init__(self, runner):
        self.runner = runner

    def __getattr__(self, name):
        return getattr(board, name)


class Runner:
    """Starts, watches and ends attempts for one store. All calls hold the admission lock."""

    def __init__(self, path, cron=None):
        self.path, self.cron = path, cron or Cron()

    def start(self, conn, task_id, profile):
        run_id = board.start_run(conn, task_id, profile)
        if run_id is None:
            return None
        task = board.get_task(conn, task_id)
        try:
            job_id = self.cron.create(JOB_PREFIX + task.title[:80],
                                      prompt(task, board.list_comments(conn, task_id)))
        except CronUnavailable as exc:
            board.block_task(conn, run_id, kind="failed", reason="Hermes could not start the work.",
                             error=str(exc))
            return run_id
        board.bind_job(conn, run_id, job_id)
        self._launch(run_id, job_id)
        return run_id

    def _launch(self, run_id, job_id):
        held = threading.Event()
        context = contextvars.copy_context()

        def work():
            with board.connect_closing(self.path) as conn, board.hold_run(conn, run_id):
                held.set()
                try:
                    self.cron.run(job_id)
                except CronUnavailable:
                    pass  # The next pass reads the job's own status.

        thread = threading.Thread(target=lambda: context.run(work), daemon=True,
                                  name=f"reminders-kanban-run-{run_id}")
        thread.start()
        held.wait(10)

    def stop(self, conn, run, reason):
        if run.job_id:
            self.cron.cancel(run.job_id, reason)

    def reconcile(self, conn):
        """Settle attempts whose job ended without a handback, and remove finished jobs."""
        pending = conn.execute(
            "SELECT id FROM task_runs WHERE job_id IS NOT NULL AND job_removed=0").fetchall()
        if not pending and str(self.path) in _SWEPT:
            return
        _SWEPT.add(str(self.path))
        jobs = self.cron.jobs()
        self._sweep(conn, jobs)
        for (run_id,) in pending:
            run = board.get_run(conn, run_id)
            job = jobs.get(run.job_id)
            in_flight = board.run_in_flight(conn, run_id)
            if run.ended_at is None:
                if job is not None and job.get("last_status") is None:
                    # Hermes runs the job in its own worker, which outlives a gateway restart:
                    # keep waiting. Never start it again; that could repeat work with effects.
                    if in_flight or board.now() - run.started_at < ORPHAN_LIMIT:
                        continue
                    self.cron.cancel(run.job_id, "No answer from Hermes")
                    error = "Hermes stopped answering during this run."
                elif job is None:
                    error = "The Hermes job for this run was removed."
                else:
                    error = (job.get("last_error")
                             or "Hermes finished without handing back a result.")
                board.block_task(conn, run_id, kind="failed",
                                 reason="The run ended without a result.", error=error)
            elif in_flight:
                continue  # Ended here (stop, pause or handback); the job is winding down.
            if job is not None:
                self.cron.remove(run.job_id)
            with board.write_txn(conn):
                conn.execute("UPDATE task_runs SET job_removed=1 WHERE id=?", (run_id,))

    def _sweep(self, conn, jobs):
        """Remove leftover jobs this plugin made that no run owns (a crash before binding)."""
        known = {r[0] for r in conn.execute(
            "SELECT job_id FROM task_runs WHERE job_id IS NOT NULL")}
        for job_id, job in jobs.items():
            if str(job.get("name", "")).startswith(JOB_PREFIX) and job_id not in known:
                self.cron.remove(job_id)
