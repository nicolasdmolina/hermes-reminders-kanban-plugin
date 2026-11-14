"""Give live proof finalizers a bounded chance to retire shared fixtures."""

import signal
import subprocess


def run_proof(command, *, timeout, cleanup_timeout=120):
    child = subprocess.Popen(command, start_new_session=True)
    try:
        return child.wait(timeout=timeout)
    except (subprocess.TimeoutExpired, KeyboardInterrupt):
        if child.poll() is None:
            child.send_signal(signal.SIGINT)
        try:
            child.wait(timeout=cleanup_timeout)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
        raise
