"""Calls the native Reminders helper app (native/reminders-helper).

The helper runs one JSON request per launch through LaunchServices so macOS
applies the Reminders grant held by its bundle identifier.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

HELPER_SOURCE = Path(__file__).resolve().parents[2] / "native" / "reminders-helper"
LEGACY_DIR = Path(tempfile.gettempdir()) / "reminders-kanban-helper"
BUILD_DIR = Path.home() / "Library/Caches/reminders-kanban/helper"
APP_NAME = "RK Reminders Helper.app"
logger = logging.getLogger(__name__)


class HelperError(Exception):
    def __init__(self, code: str, message: str, current: Any = None, request: str | None = None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.current = current
        # Set when the helper was launched but never answered: the path it was launched with,
        # which still_running() uses to tell whether that helper can still save.
        self.request = request


@contextmanager
def _lock(*, shared=False):
    BUILD_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (BUILD_DIR / "cache.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_SH if shared else fcntl.LOCK_EX)
        yield


def _verify(app, identity=None):
    try:
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)],
                       check=True, capture_output=True, timeout=20)
        signed = subprocess.run(["codesign", "-dvv", str(app)], check=True,
                                capture_output=True, text=True, timeout=20)
        if "Signature=adhoc" in signed.stderr or "Authority=" not in signed.stderr:
            raise HelperError("signing_required", "Helper requires a persistent signing identity")
        if identity:
            # "-R=<text>" is a requirement; a bare "-R <text>" is read as a file path.
            subprocess.run(["codesign", "--verify", "--strict",
                            f'-R=certificate leaf = H"{identity}"', str(app)],
                           check=True, capture_output=True, timeout=20)
    except (OSError, subprocess.SubprocessError) as exc:
        raise HelperError("signing_required", "Prepare Reminders access again") from exc


# Another checkout or install of this plugin (a development worktree beside the live Hermes
# one) has its own helper build in the same cache. A build someone used this recently is
# theirs to keep: deleting it makes each side rebuild and delete the other's, over and over.
KEEP_UNUSED_FOR = 14 * 24 * 60 * 60


def _used(build_dir):
    """Marks a build as in use now, at most once an hour (its marker's time is its last use)."""
    marker = build_dir / ".rk-build"
    try:
        if time.time() - marker.stat().st_mtime > 3600:
            os.utime(marker)
    except OSError:
        pass


def _cleanup(current):
    for old in BUILD_DIR.iterdir():
        marker = old / ".rk-build"
        if (old != current and not old.is_symlink() and old.is_dir()
                and re.fullmatch(r"[a-f0-9]{64}", old.name)
                and marker.is_file()
                and time.time() - marker.stat().st_mtime > KEEP_UNUSED_FOR):
            shutil.rmtree(old)
    marker = BUILD_DIR / ".legacy-cleaned"
    if not marker.exists():
        if LEGACY_DIR.is_dir() and not LEGACY_DIR.is_symlink():
            for old in LEGACY_DIR.iterdir():
                if (not old.is_symlink() and old.is_dir()
                        and re.fullmatch(r"(?:tmp|[a-f0-9]{12}-)[A-Za-z0-9_-]+", old.name)
                        and (old / APP_NAME / "Contents/Info.plist").is_file()):
                    shutil.rmtree(old)
        marker.touch()


def helper_app() -> Path:
    with _lock():
        return _helper_app()


def _build_dir(identity=None) -> Path:
    if identity is None:
        identity = _identity()
    digest = hashlib.sha256()
    for source in sorted(HELPER_SOURCE.iterdir()):
        if source.is_file():
            digest.update(source.name.encode())
            digest.update(source.read_bytes())
    digest.update(identity.encode())
    # A helper built for an overridden macOS target must have its own cache entry.
    if os.environ.get("RK_MACOS_TARGET"):
        digest.update(os.environ["RK_MACOS_TARGET"].encode())
    return BUILD_DIR / digest.hexdigest()


def _identity():
    from reminders_kanban.reminders.helper_setup import signing_identity

    try:
        identity = signing_identity()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        raise HelperError("signing_required", "Helper signing identity is unavailable") from exc
    if not identity:
        raise HelperError("signing_required", "Prepare Reminders access on this Mac")
    return identity


def _helper_app() -> Path:
    identity = _identity()
    build_dir = _build_dir(identity)
    app = build_dir / APP_NAME
    if app.exists():
        try:
            _verify(app, identity)
        except HelperError:
            if not (build_dir / ".rk-build").is_file() or build_dir.is_symlink():
                raise
            build_dir.rename(BUILD_DIR / f"invalid-{build_dir.name}-{time.time_ns()}")
        else:
            _used(build_dir)
            _cleanup(build_dir)
            return app
    with tempfile.TemporaryDirectory(prefix="building-", dir=BUILD_DIR) as tmp:
        try:
            prepared = HELPER_SOURCE.parent / "prepared-helper" / build_dir.name / APP_NAME
            if prepared.is_dir():
                _verify(prepared, identity)
                shutil.copytree(prepared, Path(tmp) / APP_NAME)
            else:
                subprocess.run(
                    [str(HELPER_SOURCE / "build.sh"), tmp], check=True,
                    capture_output=True, text=True,
                    env=dict(os.environ, RK_COMPILE_ONLY="0", RK_SIGNING_IDENTITY=identity),
                    timeout=180,
                )
        except subprocess.CalledProcessError as exc:
            logger.error("Reminders helper build failed (exit %s): %s",
                         exc.returncode, (exc.stderr or "").strip())
            code = {78: "signing_required", 79: "toolchain_required"}.get(
                exc.returncode, "helper_build_failed")
            raise HelperError(
                code, "The Reminders helper could not be rebuilt. "
                "Check the gateway log for the build error.",
            ) from exc
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise HelperError(
                "setup_failed", "Reminders helper preparation did not finish",
            ) from exc
        _verify(Path(tmp) / APP_NAME, identity)
        (Path(tmp) / ".rk-build").touch()
        Path(tmp).rename(build_dir)
    _cleanup(build_dir)
    return app


@contextmanager
def _running_app():
    # Concurrent requests share the signed build; only a rebuild/cleanup excludes them.
    while True:
        with _lock(shared=True):
            identity = _identity()
            app = _build_dir(identity) / APP_NAME
            if app.exists():
                _verify(app, identity)
                _used(app.parent)
                yield app
                return
        helper_app()


def still_running(request: str | None = None) -> bool:
    """True while a helper that never answered could still save.

    `request` is HelperError.request, the path that helper was launched with. Without one (the
    backend died mid-write), any running helper counts. Unknown counts as running.
    """
    try:
        found = subprocess.run(
            ["pgrep", "-f", re.escape(request or APP_NAME)], capture_output=True, timeout=10
        )
    except (OSError, subprocess.TimeoutExpired):
        return True
    return found.returncode != 1


def run(op: str, timeout: float = 60, **fields: Any) -> Any:
    """Runs one helper op. Returns its result or raises HelperError.

    A timeout raises HelperError("uncertain", ...): the helper may have saved.
    Callers that write must reconcile against a fresh read before retrying.
    """
    from reminders_kanban.reminders.helper_setup import MESSAGES, prerequisite

    if status := prerequisite():
        raise HelperError(status, MESSAGES[status])
    with _running_app() as app, tempfile.TemporaryDirectory() as tmp:
        request = Path(tmp) / "request.json"
        response = Path(tmp) / "response.json"
        request.write_text(json.dumps({"op": op, **fields}))
        # The helper writes its response atomically, so its existence means the op finished.
        # open -W is not used: it races with the helper's fast exit and reports failure.
        try:
            subprocess.run(
                ["open", "-n", str(app), "--args", str(request), str(response)],
                capture_output=True,
                timeout=timeout,
                check=True,
            )
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError) as exc:
            raise HelperError(
                "uncertain", f"helper launch interrupted for {op}", request=str(request)
            ) from exc
        deadline = time.monotonic() + timeout
        while not response.exists():
            if time.monotonic() > deadline:
                raise HelperError(
                    "uncertain", f"helper did not finish {op} in {timeout}s", request=str(request)
                )
            time.sleep(0.05)
        body = json.loads(response.read_text())
    if body.get("ok"):
        return body.get("result")
    error = body.get("error", {})
    raise HelperError(error.get("code", "failed"), error.get("message", ""), error.get("current"))
