"""Attempt-scoped recovery. Evidence enters only through the trusted owner API."""

from datetime import UTC, datetime, timedelta


def failure(observation):
    runs = observation.get("runs", [])
    if not runs or observation["state"] in {"active", "result", "done", "stopped", "question"}:
        return None
    # Scheduling can append a synthetic record without starting another worker.
    # It must not erase a prior interrupted attempt's unresolved effects.
    run = next((r for r in reversed(runs) if r.get("outcome") != "scheduled"), None)
    if run is None or not run.get("ended_at"):
        return None
    metadata = run.get("metadata") or {}
    code = metadata.get("exit_code")
    if code == 78:
        cause = "access"
    elif run.get("outcome") == "rate_limited":
        cause = "capacity"
    elif (run.get("outcome") == "blocked"
          and observation.get("task", {}).get("block_kind") == "needs_input"):
        # Explicitly answered questions continue from the same retained blocked run.
        return None
    elif run.get("outcome") in {"completed", "review_requested"}:
        return None
    else:
        # Reclaimed, timed-out and unknown terminal outcomes are interruptions,
        # never evidence that repeating external actions is safe.
        cause = "ordinary"
    return run, cause


class Recovery:
    def __init__(self, control):
        self.control = control

    def observe(self, row):
        observed = self.control.observe(row["task_id"])
        found = failure(observed)
        if found is None:
            row.pop("recovery", None)
            return row
        run, cause = found
        state = row.get("recovery")
        if not state or state["run_id"] != run["id"]:
            state = dict(
                run_id=run["id"],
                cause=cause,
                reconciliation="required",
                evidence=None,
                access_repaired=False,
                authorized=False,
                next_check_at=None,
            )
        # Only native cooldown is known. It is not a provider reset or funding promise.
        if cause == "capacity":
            ended = datetime.fromtimestamp(run["ended_at"], UTC)
            seconds = self.control.backend._resolve_rate_limit_cooldown_seconds()
            state["next_check_at"] = (ended + timedelta(seconds=seconds)).isoformat()
        state["occupied"] = observed.get(
            "host_status"
        ) == "running" or not self.control._workers_stopped(row["task_id"])
        state["column"] = "In progress" if state["cause"] == "capacity" else "Needs you"
        state["action"] = {
            "capacity": "wait",
            "balance": "fund_account",
            "access": "repair_access",
            "ordinary": "retry",
        }[state["cause"]]
        if state["reconciliation"] != "resolved":
            state.update(column="Needs you", action="reconcile")
        row["recovery"] = state
        return row

    def reconcile(self, row, *, run_id, evidence, cause=None, access_repaired=False):
        """Owner-only receipt after inspecting actual external outcomes, never HTTP input.

        Evidence must describe completed effects and safe remaining work; it is passed
        to the next supervised worker. The adapter cannot infer arbitrary tool effects.
        """
        self.observe(row)
        state = row.get("recovery")
        if not state or state["run_id"] != run_id or state["occupied"]:
            raise ValueError("stale attempt or worker still alive")
        if not isinstance(evidence, str) or not evidence.strip():
            raise ValueError("inspected external outcomes required")
        if cause is not None:
            if state["cause"] not in {"capacity", "balance"} or cause not in {
                "capacity",
                "balance",
            }:
                raise ValueError("only quota cause refinement is supported")
            state["cause"] = cause
        state.update(reconciliation="resolved", evidence=evidence, access_repaired=access_repaired)
        return self.observe(row)

    def permit(self, row, *, deliberate=False, run_id=None):
        self.observe(row)
        state = row.get("recovery")
        if state is None:
            return not deliberate
        if run_id is not None and run_id != state["run_id"]:
            return False
        if state["occupied"] or state["reconciliation"] != "resolved":
            return False
        if state["cause"] == "ordinary" and not (deliberate or state["authorized"]):
            return False
        if state["cause"] == "access" and not state["access_repaired"]:
            return False
        # Native admission checks cooldown again before spawning.
        if state["next_check_at"] and datetime.now(UTC) < datetime.fromisoformat(
            state["next_check_at"]
        ):
            return False
        self.control.comment(
            row["task_id"],
            f"recovery-{state['run_id']}",
            "Verified previous attempt effects; do not repeat completed writes:\n"
            + state["evidence"],
        )
        state["authorized"] = True
        return True


def reconcile(owner, source_id, **receipt):
    """Persist a trusted adapter receipt under the same locks as owner ticks."""
    with owner.store.locked() as db:
        # Run again keeps the stopped run's row beside the new one: act on the current run.
        rows = [r for r in owner._rows(db) if r["expected"]["id"] == source_id]
        row = next((r for r in rows if not r.get("storage_key")), rows[-1] if rows else None)
        if row is None:
            raise ValueError("not delegated")
        with owner.admission.serialized() as conn:
            row = owner._observe(db, row, conn)
            if row.get("guard", {}).get("status") != "active":
                raise ValueError("source does not authorize recovery")
            Recovery(owner.control_factory(conn, owner.admission.kb)).reconcile(row, **receipt)
            return owner._save(db, row)
