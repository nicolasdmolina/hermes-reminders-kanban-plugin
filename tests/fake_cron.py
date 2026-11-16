"""Stand-in for Hermes' scheduled-job tool, shaped like ``runner.Cron``.

``run`` blocks like the real tool until the job ends: a test ends it with ``finish``, or the
plugin does with ``cancel``. With ``on_run`` the job instead plays a scripted agent:
``on_run(job_id, prompt)`` runs inside the job (hand back with ``handback``) and its return
value, if any, is the job's ``last_error``.
"""

import threading


class FakeCron:
    def __init__(self, *, fail_create=False, on_run=None):
        self.fail_create, self.on_run = fail_create, on_run
        self.store = {}
        self.ended = {}
        self.runs, self.cancels, self.removed = [], [], []
        self.started = threading.Event()

    def create(self, name, text):
        from reminders_kanban.execution.runner import CronUnavailable

        if self.fail_create:
            raise CronUnavailable("scheduled jobs are off")
        job_id = f"job{len(self.store) + len(self.removed) + 1}"
        self.store[job_id] = {"job_id": job_id, "name": name, "prompt": text,
                              "last_status": None, "last_error": None}
        self.ended[job_id] = threading.Event()
        return job_id

    def run(self, job_id):
        self.runs.append(job_id)
        self.started.set()
        if self.on_run is not None:
            error = self.on_run(job_id, self.store[job_id]["prompt"])
            self.finish(job_id, "error" if error else "ok", error)
        self.ended[job_id].wait(30)
        return {"success": True}

    def finish(self, job_id, status="ok", error=None):
        if job_id in self.store:
            self.store[job_id].update(last_status=status, last_error=error)
        self.ended[job_id].set()

    def cancel(self, job_id, reason):
        self.cancels.append((job_id, reason))
        self.finish(job_id, "cancelled")

    def remove(self, job_id):
        self.removed.append(job_id)
        self.store.pop(job_id, None)

    def jobs(self):
        return {k: dict(v) for k, v in self.store.items()}

    def release_all(self):
        for event in self.ended.values():
            event.set()


def handback(home, job_id, *, summary=None, question=None):
    """What the agent's tool call does inside job ``job_id``; returns the tool's answer."""
    import json
    from types import SimpleNamespace

    from reminders_kanban.execution import tools

    name, args = ((tools.FINISH, {"summary": summary}) if question is None
                  else (tools.ASK, {"question": question}))
    return json.loads(tools.handle(name, args, execution=SimpleNamespace(job_id=job_id),
                                   home=home))
