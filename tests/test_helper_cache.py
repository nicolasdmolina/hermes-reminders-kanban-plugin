import multiprocessing
from pathlib import Path
from unittest.mock import patch

from reminders_kanban.reminders import helper


def fake_build(args, **kwargs):
    if args[0].endswith('build.sh'):
        root = Path(args[1])
        (root / helper.APP_NAME).mkdir()
        with (root.parent / 'compiles').open('a') as log:
            log.write('compile\n')


def start():
    helper.helper_app()


def test_cache_rebuild_concurrency_cleanup(tmp_path, monkeypatch):
    monkeypatch.setattr(helper, "_identity", lambda: "A" * 40)
    source = tmp_path / 'source'
    source.mkdir()
    (source / 'build.sh').write_text('first')
    monkeypatch.setattr(helper, 'HELPER_SOURCE', source)
    monkeypatch.setattr(helper, 'BUILD_DIR', tmp_path / 'cache')
    monkeypatch.setattr(helper, 'LEGACY_DIR', tmp_path / 'legacy')
    old = helper.LEGACY_DIR / 'tmpowned' / helper.APP_NAME / 'Contents'
    old.mkdir(parents=True)
    (old / 'Info.plist').touch()
    keep = helper.LEGACY_DIR / 'keep'
    keep.mkdir()
    with patch.object(helper.subprocess, 'run', side_effect=fake_build), \
            patch.object(helper, '_verify'):
        ctx = multiprocessing.get_context('fork')
        children = [ctx.Process(target=start) for _ in range(2)]
        for child in children:
            child.start()
        for child in children:
            child.join(10)
            assert child.exitcode == 0
        first = helper.helper_app()
        assert (helper.BUILD_DIR / 'compiles').read_text().count('compile') == 1
        assert not old.exists()
        assert keep.exists()
        (source / 'build.sh').write_text('second')
        second = helper.helper_app()
        assert first != second
        # Another version's build used lately stays: a second checkout or the live install may
        # be running it, and deleting it would make the two rebuild over each other forever.
        assert first.exists()
        assert second.exists()
        assert (helper.BUILD_DIR / 'compiles').read_text().count('compile') == 2
        # Both sides keep working without another compile.
        (source / 'build.sh').write_text('first')
        assert helper.helper_app() == first
        (source / 'build.sh').write_text('second')
        assert helper.helper_app() == second
        assert (helper.BUILD_DIR / 'compiles').read_text().count('compile') == 2
        # Using a build renews its marker, so one in daily use is never the stale one.
        import os
        marker = second.parent / '.rk-build'
        hours_ago = helper.time.time() - 2 * 3600
        os.utime(marker, (hours_ago, hours_ago))
        with helper._running_app() as running:
            assert running == second
        assert helper.time.time() - marker.stat().st_mtime < 60
        # A build nobody has used for a long time is removed on the next call.
        long_ago = helper.time.time() - helper.KEEP_UNUSED_FOR - 60
        os.utime(first.parent / '.rk-build', (long_ago, long_ago))
        helper.helper_app()
        assert not first.exists()
        assert second.exists()


def test_running_requests_share_build_and_exclude_cleanup(tmp_path, monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor

    monkeypatch.setattr(helper, "_identity", lambda: "A" * 40)
    source = tmp_path / 'source'
    source.mkdir()
    (source / 'build.sh').write_text('first')
    monkeypatch.setattr(helper, 'HELPER_SOURCE', source)
    monkeypatch.setattr(helper, 'BUILD_DIR', tmp_path / 'cache')
    monkeypatch.setattr(helper, 'LEGACY_DIR', tmp_path / 'legacy')
    release = threading.Event()
    entered = [threading.Event(), threading.Event()]

    def request(index):
        with helper._running_app() as app:
            entered[index].set()
            assert release.wait(5)
            assert app.exists()

    with patch.object(helper.subprocess, 'run', side_effect=fake_build), \
            patch.object(helper, '_verify'), ThreadPoolExecutor() as pool:
        first = helper.helper_app()
        requests = [pool.submit(request, index) for index in range(2)]
        try:
            assert all(event.wait(1) for event in entered)
            (source / 'build.sh').write_text('second')
            rebuilding = pool.submit(helper.helper_app)
            assert not rebuilding.done()
            assert first.exists()
        finally:
            release.set()
        for pending in requests:
            pending.result(timeout=2)
        assert rebuilding.result(timeout=2) != first
        # The build those requests ran was used just now, so it stays beside the new one.
        assert first.exists()


def test_prepare_rebuilds_invalid_owned_cache_without_deleting_it(tmp_path, monkeypatch):
    monkeypatch.setattr(helper, "_identity", lambda: "A" * 40)
    monkeypatch.setattr(helper, "BUILD_DIR", tmp_path / "cache")
    monkeypatch.setattr(helper, "LEGACY_DIR", tmp_path / "legacy")
    with patch.object(helper.subprocess, "run", side_effect=fake_build), \
            patch.object(helper, "_verify"):
        app = helper.helper_app()
    app.joinpath("corrupt").touch()

    def verify(path, identity=None):
        if path.joinpath("corrupt").exists():
            raise helper.HelperError("signing_required", "Invalid signature")

    with patch.object(helper.subprocess, "run", side_effect=fake_build), \
            patch.object(helper, "_verify", side_effect=verify):
        assert helper.helper_app() == app
    assert not app.joinpath("corrupt").exists()
    preserved = list(helper.BUILD_DIR.glob("invalid-*"))
    assert len(preserved) == 1
    assert (preserved[0] / helper.APP_NAME / "corrupt").exists()


def test_prepared_helper_skips_build_and_rejects_stale_source(tmp_path, monkeypatch):
    monkeypatch.setattr(helper, "_identity", lambda: "A" * 40)
    source = tmp_path / 'native' / 'reminders-helper'
    source.mkdir(parents=True)
    (source / 'build.sh').write_text('first')
    monkeypatch.setattr(helper, 'HELPER_SOURCE', source)
    monkeypatch.setattr(helper, 'BUILD_DIR', tmp_path / 'cache')
    monkeypatch.setattr(helper, 'LEGACY_DIR', tmp_path / 'legacy')
    prepared = source.parent / 'prepared-helper' / helper._build_dir().name / helper.APP_NAME
    prepared.mkdir(parents=True)
    (prepared / 'payload').write_text('signed binary')
    with patch.object(helper, '_verify') as verify, \
            patch.object(helper.subprocess, 'run', side_effect=fake_build):
        app = helper.helper_app()
        assert (app / 'payload').read_text() == 'signed binary'
        assert not (helper.BUILD_DIR / 'compiles').exists()
        assert verify.call_count == 2
        assert all(call.args[1] == "A" * 40 for call in verify.call_args_list)
        (source / 'build.sh').write_text('changed')
        newer = helper.helper_app()
        assert newer != app
        assert (helper.BUILD_DIR / 'compiles').read_text() == 'compile\n'


def test_build_cache_separates_signing_identity_and_macos_target(tmp_path, monkeypatch):
    monkeypatch.setattr(helper, 'BUILD_DIR', tmp_path)
    monkeypatch.delenv("RK_MACOS_TARGET", raising=False)
    default = helper._build_dir("A" * 40)
    assert helper._build_dir("B" * 40) != default
    monkeypatch.setenv("RK_MACOS_TARGET", "15.0")
    assert helper._build_dir("A" * 40) != default


def test_build_failure_is_recoverable_and_logs_diagnostic(tmp_path, monkeypatch, caplog):
    import subprocess

    import pytest

    monkeypatch.setattr(helper, "_identity", lambda: "A" * 40)
    monkeypatch.setattr(helper, 'BUILD_DIR', tmp_path)
    error = subprocess.CalledProcessError(1, ['build.sh'], stderr='errSecInternalComponent')
    with patch.object(helper.subprocess, 'run', side_effect=error):
        with pytest.raises(helper.HelperError) as caught:
            helper.helper_app()
    assert caught.value.code == 'helper_build_failed'
    assert 'errSecInternalComponent' in caplog.text
    assert not list(tmp_path.glob('building-*'))
    assert not helper._build_dir().exists()


def test_build_failure_returns_action_status_instead_of_http_500(tmp_path, monkeypatch):
    import subprocess

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from reminders_kanban.api import delegation

    class Owner:
        def apply(self, **action):
            helper.helper_app()
            raise AssertionError('Must not apply acceptance after failed helper preparation')

    monkeypatch.setattr(helper, "_identity", lambda: "A" * 40)
    monkeypatch.setattr(helper, 'BUILD_DIR', tmp_path)
    app = FastAPI()
    app.include_router(delegation.router)
    app.dependency_overrides[delegation.service] = Owner
    error = subprocess.CalledProcessError(1, ['build.sh'], stderr='errSecInternalComponent')
    with patch.object(helper.subprocess, 'run', side_effect=error):
        response = TestClient(app).post('/delegation/actions', json={'action': 'accept'})
    assert response.status_code == 200
    assert response.json()['status'] == 'helper_build_failed'
