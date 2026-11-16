import fcntl
import json
import os
import plistlib
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from reminders_kanban.api import helper_setup as api
from reminders_kanban.api.preview import profile_home
from reminders_kanban.reminders import helper
from reminders_kanban.reminders import helper_setup as setup

FINGERPRINT = "A" * 40


@pytest.fixture
def local(monkeypatch, tmp_path):
    monkeypatch.setattr(setup, "SETUP_DIR", tmp_path / "setup")
    monkeypatch.setattr(helper, "BUILD_DIR", tmp_path / "cache")
    monkeypatch.setattr(setup.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(setup.platform, "mac_ver", lambda: ("14.0", (), ""))
    monkeypatch.setattr(setup, "session_available", lambda: True)
    monkeypatch.setattr(setup, "toolchain_available", lambda: True)
    monkeypatch.delenv("RK_SIGNING_IDENTITY", raising=False)
    def forbidden(*args, **kwargs):
        pytest.fail("Unmocked native setup command")
    monkeypatch.setattr(setup, "_run", forbidden)
    monkeypatch.setattr(helper, "helper_app", forbidden)
    return tmp_path


def identities(monkeypatch, output):
    monkeypatch.setattr(setup, "_run", lambda *a, **k: subprocess.CompletedProcess(a, 0, output))


def test_get_is_read_only_and_never_prompts(local, monkeypatch):
    identities(monkeypatch, "0 valid identities found")
    assert setup.inspect()["status"] == "signing_required"
    assert list(local.iterdir()) == []
    identities(monkeypatch, f' 1) {FINGERPRINT} "{setup.IDENTITY_NAME}"\n')
    assert setup.inspect()["status"] == "signing_required"
    assert list(local.iterdir()) == []


def test_get_verifies_existing_fingerprint_without_building(local, monkeypatch):
    identities(monkeypatch, f' 1) {FINGERPRINT} "{setup.IDENTITY_NAME}"\n')
    app = helper._build_dir(FINGERPRINT) / helper.APP_NAME
    app.mkdir(parents=True)
    calls = []
    monkeypatch.setattr(helper, "_verify", lambda *args: calls.append(args))
    before = sorted(local.rglob("*"))
    assert setup.inspect() == {"status": "ready"}
    assert calls == [(app, FINGERPRINT)]
    assert sorted(local.rglob("*")) == before


@pytest.mark.parametrize("status", ["unsupported_platform", "session_locked", "toolchain_required"])
def test_prerequisites_stop_inspection_and_preparation(local, monkeypatch, status):
    if status == "unsupported_platform":
        monkeypatch.setattr(setup.platform, "system", lambda: "Linux")
    elif status == "session_locked":
        monkeypatch.setattr(setup, "session_available", lambda: False)
    else:
        monkeypatch.setattr(setup, "toolchain_available", lambda: False)
    assert setup.inspect()["status"] == status
    assert setup.prepare("prepare")["status"] == status
    assert not (local / "cache").exists()


def test_only_explicit_install_requests_apple_tools(local, monkeypatch):
    monkeypatch.setattr(setup, "toolchain_available", lambda: False)
    calls = []
    monkeypatch.setattr(setup, "_run", lambda args, **kw: calls.append(args))
    assert setup.inspect()["status"] == "toolchain_required"
    assert setup.prepare("prepare")["status"] == "toolchain_required"
    assert calls == []
    assert setup.prepare("install_tools")["status"] == "toolchain_required"
    assert calls == [["/usr/bin/xcode-select", "--install"]]


def test_reuses_existing_identity_and_never_changes_its_trust(local, monkeypatch):
    identities(monkeypatch, f' 1) {FINGERPRINT} "{setup.IDENTITY_NAME}"\n')
    builds = []
    monkeypatch.setattr(helper, "helper_app", lambda: builds.append(1))
    assert setup.prepare("prepare") == {"status": "ready"}
    assert setup.prepare("prepare") == {"status": "ready"}
    assert setup._pin() == {"fingerprint": FINGERPRINT, "generated": False}
    assert builds == [1, 1]


def test_ambiguous_name_and_missing_pinned_identity_never_choose_replacement(local, monkeypatch):
    identities(monkeypatch, f'1) {FINGERPRINT} "{setup.IDENTITY_NAME}"\n'
               f'2) {"B" * 40} "{setup.IDENTITY_NAME}"\n')
    assert setup.prepare("prepare")["status"] == "setup_failed"
    setup._save_pin(FINGERPRINT, generated=False)
    identities(monkeypatch, f'1) {"B" * 40} "{setup.IDENTITY_NAME}"\n')
    assert setup.signing_identity() is None
    assert setup.prepare("prepare")["status"] == "signing_required"


@pytest.mark.parametrize("fail_import", [False, True])
def test_new_certificate_private_material_is_confined_and_removed(local, monkeypatch, fail_import):
    setup.SETUP_DIR.mkdir(mode=0o700)
    keychain = local / "login.keychain-db"
    keychain.touch()
    monkeypatch.setattr(setup, "_login_keychain", lambda: keychain)
    calls, passphrases = [], []

    def command(args, **kw):
        calls.append(args)
        if args[0] == "/usr/bin/openssl":
            if "pkcs12" in args:
                passphrases.append(kw["env"]["RK_ARCHIVE_PASSPHRASE"])
            return subprocess.run(args, capture_output=True, text=True, check=True, timeout=60,
                                  env=kw.get("env"))
        assert args[0] == "/usr/bin/security"
        if args[1] == "find-certificate":
            return subprocess.CompletedProcess(args, 44, "")
        assert args[1] == "import"
        archive = Path(args[2])
        assert archive.exists()
        assert archive.stat().st_mode & 0o777 == 0o600
        assert archive.parent.stat().st_mode & 0o777 == 0o700
        assert args[args.index("-T") + 1] == "/usr/bin/codesign"
        assert "-A" not in args and "-x" in args
        # macOS 26 refuses an empty archive password. The one-time one reaches openssl
        # through its environment and only the import that reads the archive back.
        assert len(passphrases[0]) >= 24
        assert args[args.index("-P") + 1] == passphrases[0]
        assert passphrases[0] not in json.dumps(calls[:-1])
        if fail_import:
            raise subprocess.TimeoutExpired(args, 60)
        return subprocess.CompletedProcess(args, 0, "")

    monkeypatch.setattr(setup, "_run", command)
    if fail_import:
        with pytest.raises(subprocess.TimeoutExpired):
            setup._create_identity()
    else:
        fingerprint = setup._create_identity()
        assert fingerprint == setup._pin()["fingerprint"]
    assert {p.name for p in setup.SETUP_DIR.iterdir()} == {"identity.json", "certificate.pem"}
    assert b"PRIVATE KEY" not in (setup.SETUP_DIR / "certificate.pem").read_bytes()
    assert setup._pin()["generated"] is True
    assert "-P" not in json.dumps(calls[0])


def test_trust_is_only_generated_certificate_user_domain_codesign(local, monkeypatch):
    setup.SETUP_DIR.mkdir()
    setup._save_pin(FINGERPRINT, generated=True)
    certificate = setup.SETUP_DIR / "certificate.pem"
    certificate.write_text("public certificate")
    keychain = local / "login.keychain-db"
    monkeypatch.setattr(setup, "_login_keychain", lambda: keychain)
    calls = []

    def command(args, **kw):
        calls.append(args)
        return subprocess.CompletedProcess(args, 0, f"sha1 Fingerprint={FINGERPRINT}\n")

    monkeypatch.setattr(setup, "_run", command)
    setup._trust_generated(FINGERPRINT)
    assert calls[-1] == [
        "/usr/bin/security", "add-trusted-cert", "-r", "trustRoot", "-p", "codeSign",
        "-k", str(keychain), str(certificate),
    ]
    assert "-d" not in calls[-1]
    setup._save_pin(FINGERPRINT, generated=False)
    calls.clear()
    with pytest.raises(helper.HelperError, match="signing_required"):
        setup._trust_generated(FINGERPRINT)
    assert calls == []


def test_failed_import_is_reconciled_without_new_identity(local, monkeypatch):
    setup.SETUP_DIR.mkdir()
    setup._save_pin(FINGERPRINT, generated=True)
    values = iter([None, FINGERPRINT, FINGERPRINT])
    monkeypatch.setattr(setup, "signing_identity", lambda **kw: next(values))
    trusted = []
    monkeypatch.setattr(setup, "_trust_generated", trusted.append)
    monkeypatch.setattr(helper, "helper_app", lambda: None)
    assert setup.prepare("prepare") == {"status": "ready"}
    assert trusted == [FINGERPRINT]


def test_preparations_are_serialized(local, monkeypatch):
    identities(monkeypatch, f'1) {FINGERPRINT} "{setup.IDENTITY_NAME}"\n')
    entered, release = Event(), Event()

    def build():
        entered.set()
        assert release.wait(5)

    monkeypatch.setattr(helper, "helper_app", build)
    with ThreadPoolExecutor() as pool:
        first = pool.submit(setup.prepare, "prepare")
        assert entered.wait(2)
        try:
            assert setup.prepare("prepare")["status"] == "setup_failed"
        finally:
            release.set()
        assert first.result(2) == {"status": "ready"}
    with (setup.SETUP_DIR / "setup.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)


def test_setup_errors_are_sanitized(local, monkeypatch):
    def failed(*a, **kw):
        raise subprocess.CalledProcessError(1, ["secret"], stderr="secret")
    monkeypatch.setattr(setup, "signing_identity", failed)
    assert setup.inspect()["status"] == "setup_failed"
    assert "secret" not in str(setup.prepare("prepare"))


def test_api_validates_action_and_marks_responses_uncacheable(local, monkeypatch):
    app = FastAPI()
    app.include_router(api.router)
    app.dependency_overrides[profile_home] = lambda: local
    client = TestClient(app)
    monkeypatch.setattr(setup, "inspect", lambda: {"status": "signing_required"})
    calls = []
    monkeypatch.setattr(
        setup, "prepare", lambda action: calls.append(action) or {"status": "ready"},
    )
    response = client.get("/helper-setup")
    assert response.json() == {"status": "signing_required"}
    assert response.headers["Cache-Control"] == "no-store"
    assert calls == []
    assert client.post("/helper-setup", json={"action": "prepare"}).json() == {"status": "ready"}
    for body in ({"action": "shell"}, {"action": "prepare", "identity": "other"}):
        assert client.post("/helper-setup", json=body).status_code == 422
    assert calls == ["prepare"]


@pytest.mark.parametrize("locked,on_console,uid", [
    (False, True, os.getuid()), (True, True, os.getuid()),
    (False, False, os.getuid()), (False, True, -1),
])
def test_session_observation_fails_closed(monkeypatch, locked, on_console, uid):
    body = plistlib.dumps({"IOConsoleLocked": locked, "IOConsoleUsers": [{
        "kCGSSessionOnConsoleKey": on_console, "kCGSSessionUserIDKey": uid,
    }]}).decode()
    monkeypatch.setattr(setup, "_run", lambda *a, **kw: subprocess.CompletedProcess(a, 0, body))
    assert setup.session_available() is (not locked and on_console and uid == os.getuid())


def test_api_refuses_setup_without_owning_profile(local):
    app = FastAPI()
    app.include_router(api.router)
    app.dependency_overrides[profile_home] = lambda: None
    client = TestClient(app)
    for response in (client.get("/helper-setup"),
                     client.post("/helper-setup", json={"action": "prepare"})):
        assert response.json()["status"] == "setup_failed"
    assert list(local.iterdir()) == []


@pytest.mark.parametrize("status", ["session_locked", "toolchain_required"])
def test_helper_request_refuses_launch_before_prerequisites(local, monkeypatch, status):
    monkeypatch.setattr(setup, "prerequisite", lambda: status)
    with pytest.raises(helper.HelperError) as error:
        helper.run("lists")
    assert error.value.code == status
    assert list(local.iterdir()) == []


@pytest.mark.parametrize("status", ["session_locked", "toolchain_required"])
def test_preview_keeps_exact_setup_error(local, monkeypatch, status):
    from reminders_kanban.api.preview import operate

    monkeypatch.setattr(setup, "prerequisite", lambda: status)
    result = operate(local / "profile", refresh=True)
    assert result["status"] == "read_failure"
    assert result["error"] == {"code": status}
    assert result["pickup_enabled"] is False


@pytest.mark.parametrize("code,status", [(78, "signing_required"),
                                         (79, "toolchain_required"), (1, "helper_build_failed")])
def test_build_failures_keep_recoverable_codes(local, monkeypatch, code, status):
    monkeypatch.setattr(helper, "_identity", lambda: FINGERPRINT)

    def failed(args, **kw):
        assert kw["timeout"] == 180
        assert kw["env"]["RK_SIGNING_IDENTITY"] == FINGERPRINT
        raise subprocess.CalledProcessError(code, args, stderr="private output")

    monkeypatch.setattr(helper.subprocess, "run", failed)
    with pytest.raises(helper.HelperError) as error, helper._lock():
        helper._helper_app()
    assert error.value.code == status
    assert "private output" not in str(error.value)


def test_native_build_refuses_missing_tools_before_creating_bundle(tmp_path):
    import os

    scripts = {
        "security": f'#!/bin/sh\necho \'1) {FINGERPRINT} "{setup.IDENTITY_NAME}"\'\n',
        "xcode-select": "#!/bin/sh\nexit 1\n",
    }
    for name, body in scripts.items():
        path = tmp_path / name
        path.write_text(body)
        path.chmod(0o755)
    destination = tmp_path / "build"
    result = subprocess.run(
        [str(helper.HELPER_SOURCE / "build.sh"), str(destination)],
        env={**os.environ, "PATH": f"{tmp_path}:/usr/bin:/bin", "RK_COMPILE_ONLY": "0"},
        capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 79
    assert "toolchain_required" in result.stderr
    assert not destination.exists()


@pytest.mark.parametrize("version", ["13.6", "12.0", "", "unknown"])
def test_old_or_unknown_macos_is_unsupported_before_any_command(local, monkeypatch, version):
    monkeypatch.setattr(setup.platform, "mac_ver", lambda: (version, (), ""))
    assert setup.inspect()["status"] == "unsupported_platform"
    assert setup.prepare("prepare")["status"] == "unsupported_platform"
    assert list(local.iterdir()) == []
