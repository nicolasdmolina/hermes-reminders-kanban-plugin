import subprocess
import sys

import pytest
from live_process import run_proof


def test_timeout_allows_child_finalizer(tmp_path):
    retired = tmp_path / "retired"
    script = (
        "import time; from pathlib import Path\n"
        "try:\n    time.sleep(30)\n"
        f"finally:\n    Path({str(retired)!r}).write_text('retired')\n"
    )
    with pytest.raises(subprocess.TimeoutExpired):
        run_proof([sys.executable, "-c", script], timeout=1, cleanup_timeout=5)
    assert retired.read_text() == "retired"


def test_timeout_escalates_unresponsive_child():
    script = "import signal,time; signal.signal(signal.SIGINT, signal.SIG_IGN); time.sleep(30)"
    with pytest.raises(subprocess.TimeoutExpired):
        run_proof([sys.executable, "-c", script], timeout=1, cleanup_timeout=0.1)


def test_preserves_exit_status():
    assert run_proof([sys.executable, "-c", "raise SystemExit(3)"], timeout=5) == 3


def test_group_interrupt_reaches_child_once(tmp_path):
    import os
    import signal
    import time
    from pathlib import Path

    ready, retired = tmp_path / "ready", tmp_path / "retired"
    child = (
        "import time; from pathlib import Path\n"
        f"try:\n    Path({str(ready)!r}).touch()\n    time.sleep(30)\n"
        f"finally:\n    time.sleep(0.3)\n    Path({str(retired)!r}).touch()\n"
    )
    runner = (
        f"import sys; sys.path.insert(0, {str(Path(__file__).parent)!r}); "
        "from live_process import run_proof; "
        f"run_proof([sys.executable, '-c', {child!r}], timeout=10, cleanup_timeout=5)"
    )
    process = subprocess.Popen([sys.executable, "-c", runner], start_new_session=True)
    try:
        deadline = time.monotonic() + 5
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert ready.exists()
        os.killpg(process.pid, signal.SIGINT)
        assert process.wait(timeout=6) != 0
        assert retired.exists()
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
