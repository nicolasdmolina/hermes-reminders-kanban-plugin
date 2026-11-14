import os

import pytest

from reminders_kanban.reminders import test_lists


@pytest.fixture
def calls(tmp_path, monkeypatch):
    monkeypatch.setattr(test_lists, "LEASE_DIR", tmp_path)
    calls = []
    monkeypatch.setattr(test_lists.helper, "run", lambda op, **kw: calls.append((op, kw)))
    return calls


def test_setup_and_teardown_even_after_failed_proof(calls):
    with pytest.raises(ValueError), test_lists.proof_lists():
        raise ValueError("proof failed")
    assert calls == [("lists", {}), ("test-lists", {"action": "setup"}),
                     ("test-lists", {"action": "teardown"})]
    assert not (test_lists.LEASE_DIR / "owner.json").exists()


def test_live_owner_blocks_setup_and_teardown(calls, monkeypatch):
    (test_lists.LEASE_DIR / "owner.json").write_text("123")
    monkeypatch.setattr(os, "kill", lambda *args: None)
    for action in ("setup", "teardown"):
        with pytest.raises(RuntimeError, match="in use"):
            test_lists.lifecycle(action, owner=456)
    assert calls == []


def test_crashed_owner_can_be_reused(calls, monkeypatch):
    (test_lists.LEASE_DIR / "owner.json").write_text("123")

    def dead(*args):
        raise ProcessLookupError

    monkeypatch.setattr(os, "kill", dead)
    with test_lists.proof_lists():
        pass
    assert calls[-1] == ("test-lists", {"action": "teardown"})


def test_refused_teardown_keeps_lease(calls, monkeypatch):
    test_lists.lifecycle("setup")

    def refuse(*args, **kwargs):
        raise test_lists.helper.HelperError("bad_request", "non-fixture")

    monkeypatch.setattr(test_lists.helper, "run", refuse)
    with pytest.raises(test_lists.helper.HelperError):
        test_lists.lifecycle("teardown")
    assert (test_lists.LEASE_DIR / "owner.json").exists()


def test_native_fixture_policy(tmp_path):
    import shutil
    import subprocess

    swift = shutil.which("swift")
    if swift is None:
        pytest.skip("Swift toolchain unavailable")
    policy = test_lists.helper.HELPER_SOURCE / "TestListPolicy.swift"
    script = tmp_path / "policy.swift"
    script.write_text(policy.read_text() + '''
assert(testListTitles == ["RK Test", "RK Test 2"])
for title in ["[RK-TL] fixture", "[RK-02]", "[RK-31] completed fixture"] {
    assert(isTestFixtureTitle(title))
}
for title in ["", "Shopping", "[RK-] fake", "[RK-TL]suffix", "prefix [RK-TL] fixture"] {
    assert(!isTestFixtureTitle(title))
}
''')
    subprocess.run([swift, str(script)], check=True, capture_output=True, timeout=60)


def test_nested_proof_leaves_teardown_to_parent(calls, monkeypatch):
    monkeypatch.setenv("RK_TEST_LIST_OWNER", str(os.getpid()))
    with test_lists.proof_lists():
        pass
    assert calls == [("lists", {}), ("test-lists", {"action": "setup"})]
    assert (test_lists.LEASE_DIR / "owner.json").exists()
