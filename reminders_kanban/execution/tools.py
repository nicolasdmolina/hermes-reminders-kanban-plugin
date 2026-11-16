"""The two tools a delegated run hands its outcome back with.

A call counts only inside the Hermes scheduled job this plugin started for that run: the job
id comes from Hermes' own record of the current scheduled run, never from the arguments.
Anywhere else (an ordinary chat, another job, a run already stopped) the tools refuse.
"""

import json

from reminders_kanban.execution import board
from reminders_kanban.execution.runner import ASK, FINISH

TOOLSET = "reminders_kanban"

SCHEMAS = {
    FINISH: {
        "name": FINISH,
        "description": ("Hand back the result of a task started from Apple Reminders. Only "
                        "works inside that task's run. Call once, when the work is done."),
        "parameters": {"type": "object", "properties": {"summary": {
            "type": "string", "description": "What you did and the result, in plain words."}},
            "required": ["summary"]},
    },
    ASK: {
        "name": ASK,
        "description": ("Ask the person one question you need answered to finish a task "
                        "started from Apple Reminders, then stop. Only works inside that "
                        "task's run."),
        "parameters": {"type": "object", "properties": {"question": {
            "type": "string", "description": "One clear question."}},
            "required": ["question"]},
    },
}


def _answer(ok, message):
    return json.dumps({"ok": ok, "message": message})


def handle(name, args, *, execution, home):
    text = str((args or {}).get("summary" if name == FINISH else "question") or "").strip()
    if execution is None:
        return _answer(False, "This tool only works inside a task started from Reminders.")
    if not text:
        return _answer(False, "Say what you did." if name == FINISH else "Ask one question.")
    path = board.path_for(home)
    if not path.exists():
        return _answer(False, "This tool only works inside a task started from Reminders.")
    with board.connect_closing(path) as conn:
        run = board.run_for_job(conn, execution.job_id)
        if run is None:
            return _answer(False, "This tool only works inside a task started from Reminders.")
        if name == FINISH:
            done = board.request_review(conn, run.id, text[:20000])
        else:
            done = board.block_task(conn, run.id, kind="needs_input", reason=text[:4000])
    if not done:
        return _answer(False, "This task was stopped or already handed back. Stop now.")
    if name == FINISH:
        return _answer(True, "Handed back. The person will review it. Stop now.")
    return _answer(True, "Question sent. Stop now; the task resumes after the answer.")


def register(ctx):
    from hermes_constants import get_hermes_home

    for name, schema in SCHEMAS.items():
        def handler(args, _name=name, **_):
            # Read at call time: the scheduled run's own profile home.
            return handle(_name, args, execution=ctx.current_cron_execution(),
                          home=get_hermes_home().resolve())

        ctx.register_tool(name=name, toolset=TOOLSET, schema=schema, handler=handler,
                          description=schema["description"])
