import runpy
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
package = runpy.run_path(str(ROOT / "scripts" / "package-plugin"))["package"]


def test_package_is_independent_and_contains_native_sources(tmp_path):
    output = package(tmp_path / "package", backend_only=True)
    assert (output / "native/reminders-helper/main.swift").is_file()
    assert (output / "native/reminders-helper/build.sh").stat().st_mode & 0o111
    assert (output / "dashboard/plugin_api.py").is_file()
    assert not (output / "pyproject.toml").exists()
    assert not (output / "tests").exists()
    assert not any(p.is_symlink() or p.name == "__pycache__" for p in output.rglob("*"))
    with pytest.raises(FileExistsError):
        package(output, backend_only=True)


def test_full_package_requires_and_preserves_desktop_build(tmp_path):
    source = package(tmp_path / "source", backend_only=True)
    (source / "dashboard/manifest.json").write_text("{}")
    output = tmp_path / "release"
    with pytest.raises(ValueError, match="build ui/"):
        package(output, root=source)
    assert not output.exists()
    (source / "desktop").mkdir()
    (source / "desktop/plugin.js").write_text("export default { id: 'reminders-kanban' };")
    package(output, root=source)
    assert (output / "desktop/plugin.js").read_bytes() == (
        source / "desktop/plugin.js"
    ).read_bytes()


def test_runtime_python_range_matches_lock():
    project = tomllib.loads((ROOT / "pyproject.toml").read_text())
    lock = tomllib.loads((ROOT / "uv.lock").read_text())
    from packaging.specifiers import SpecifierSet

    supported = SpecifierSet(project["project"]["requires-python"])
    assert supported == SpecifierSet(lock["requires-python"])
    assert "3.11" in supported and "3.14" in supported
    assert "3.10" not in supported


def test_missing_signer_stops_before_compilation(tmp_path):
    import os
    import subprocess

    security = tmp_path / "security"
    security.write_text("#!/bin/sh\nexit 1\n")
    security.chmod(0o755)
    destination = tmp_path / "build"
    env = {**os.environ, "PATH": f"{tmp_path}:/usr/bin:/bin", "RK_COMPILE_ONLY": "0"}
    result = subprocess.run(
        [str(ROOT / "native/reminders-helper/build.sh"), str(destination)],
        env=env, capture_output=True, text=True,
    )
    assert result.returncode == 78
    assert "signing_required" in result.stderr
    assert not destination.exists()


def test_missing_signer_is_a_recoverable_helper_error(monkeypatch, tmp_path):
    import subprocess

    from reminders_kanban.reminders import helper

    def failed(*args, **kwargs):
        raise subprocess.CalledProcessError(78, args[0], stderr="signing_required: missing")

    monkeypatch.setattr(helper, "BUILD_DIR", tmp_path)
    monkeypatch.setattr(helper, "_identity", lambda: "A" * 40)
    monkeypatch.setattr(helper.subprocess, "run", failed)
    with pytest.raises(helper.HelperError) as error:
        helper.helper_app()
    assert error.value.code == "signing_required"


def test_dashboard_entry_is_required_and_copied_when_declared(tmp_path):
    import json

    source = package(tmp_path / "source", backend_only=True)
    (source / "desktop").mkdir()
    (source / "desktop/plugin.js").write_text("export default {};")
    manifest = source / "dashboard/manifest.json"
    manifest.write_text(json.dumps({"entry": "dist/index.js"}))
    (source / "dashboard/dist/index.js").unlink(missing_ok=True)
    with pytest.raises(ValueError, match="dashboard/dist/index.js"):
        package(tmp_path / "missing", root=source)
    assert not (tmp_path / "missing").exists()
    (source / "dashboard/dist").mkdir(exist_ok=True)
    (source / "dashboard/dist/index.js").write_text("export default {};")
    output = package(tmp_path / "complete", root=source)
    assert (output / "dashboard/dist/index.js").read_bytes() == (
        source / "dashboard/dist/index.js"
    ).read_bytes()


release = runpy.run_path(str(ROOT / "scripts" / "prepare-public-release"))
check_package = runpy.run_path(str(ROOT / "scripts" / "package-plugin"))["check_package"]


def test_runtime_package_contains_public_docs_without_development_debris(tmp_path):
    output = package(tmp_path / "package", backend_only=True)
    for name in ("README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "licenses/codicons.txt",
                 "docs/installation.md", "docs/development.md"):
        assert (output / name).read_bytes() == (ROOT / name).read_bytes()
    assert not (output / "reminders_kanban/runtime-contract.md").exists()
    assert not (output / ".scratch").exists()
    assert not (output / "plugin").exists()
    assert check_package(output, root=ROOT, backend_only=True) == output


@pytest.mark.parametrize("change", ["extra", "modified", "missing", "symlink"])
def test_package_comparison_rejects_changed_tree(tmp_path, change):
    output = package(tmp_path / "package", backend_only=True)
    if change == "extra":
        (output / "unexpected.txt").write_text("not published")
    elif change == "modified":
        (output / "plugin.yaml").write_text("changed")
    elif change == "missing":
        (output / "plugin.yaml").unlink()
    else:
        (output / "outside").symlink_to(ROOT, target_is_directory=True)
    with pytest.raises(ValueError, match="differs"):
        check_package(output, backend_only=True)


def test_package_rebuild_has_identical_file_bytes(tmp_path):
    first = package(tmp_path / "one", backend_only=True)
    second = package(tmp_path / "two", backend_only=True)
    first_files = {str(path.relative_to(first)): path.read_bytes()
                   for path in first.rglob("*") if path.is_file()}
    second_files = {str(path.relative_to(second)): path.read_bytes()
                    for path in second.rglob("*") if path.is_file()}
    assert first_files == second_files


def test_public_source_allowlist_excludes_private_history_and_proofs():
    files = {str(path) for path in release["source_files"]()}
    assert {"README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "licenses/codicons.txt",
            "ui/package-lock.json", "uv.lock",
            "scripts/package-plugin", "scripts/prepare-public-release",
            "tests/test_packaging.py", ".github/workflows/ci.yml"} <= files
    assert not any(path.startswith((".git/", ".scratch/", ".claude/", "plugin/",
                                    "docs/agents/", "scripts/hermes-sandbox/"))
                   for path in files)
    assert not any(path.endswith("_live.py") for path in files)
    assert "tests/fake_llm.py" not in files
    assert "docs/installation.md" in files


@pytest.mark.parametrize("name", ["board.png", "setup.png"])
def test_public_source_optional_screenshot_is_only_included_when_present(tmp_path, name):
    import shutil

    for fixed in release["FIXED_FILES"]:
        target = tmp_path / fixed
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / fixed, target)
    image = Path("docs/media") / name
    assert image not in release["source_files"](tmp_path)
    (tmp_path / image).parent.mkdir(parents=True)
    (tmp_path / image).write_bytes(b"approved screenshot placeholder for the unit test")
    assert image in release["source_files"](tmp_path)


def test_public_export_cli_refuses_existing_destination_without_touching_it(tmp_path):
    import subprocess

    destination = tmp_path / "user-owned"
    destination.mkdir()
    sentinel = destination / "keep.txt"
    sentinel.write_text("keep my text")
    result = subprocess.run(
        [str(ROOT / "scripts/prepare-public-release"), str(destination)],
        capture_output=True, text=True,
    )
    assert result.returncode == 1
    assert sentinel.read_text() == "keep my text"
    assert list(destination.iterdir()) == [sentinel]


def test_public_export_refuses_checkout_or_descendant_destination():
    for destination in (ROOT, ROOT / "plugin", ROOT.parent):
        with pytest.raises(ValueError, match="outside"):
            release["prepare"](destination)


def test_package_rejects_symlinked_sources_before_creating_destination(tmp_path):
    source = package(tmp_path / "source", backend_only=True)
    (source / "README.md").unlink()
    (source / "README.md").symlink_to(ROOT / "README.md")
    destination = tmp_path / "destination"
    with pytest.raises(ValueError, match="symlinked"):
        package(destination, root=source, backend_only=True)
    assert not destination.exists()


def test_full_package_copies_only_declared_desktop_and_dashboard_files(tmp_path):
    source = package(tmp_path / "source", backend_only=True)
    (source / "desktop").mkdir()
    (source / "desktop/plugin.js").write_text("export default {};")
    (source / "desktop/.hermes-package.json").write_text("private marker")
    (source / "dashboard/manifest.json").write_text('{"entry":"dist/index.js"}')
    (source / "dashboard/dist").mkdir()
    (source / "dashboard/dist/index.js").write_text("generated dashboard")
    (source / "dashboard/dist/private.json").write_text("private extra")
    output = package(tmp_path / "output", root=source)
    assert not (output / "desktop/.hermes-package.json").exists()
    assert not (output / "dashboard/dist/private.json").exists()
    assert check_package(output, root=source) == output


def test_package_rejects_dashboard_entry_outside_dashboard(tmp_path):
    source = package(tmp_path / "source", backend_only=True)
    (source / "desktop").mkdir()
    (source / "desktop/plugin.js").write_text("export default {};")
    (source / "dashboard/manifest.json").write_text('{"entry":"../README.md"}')
    with pytest.raises(ValueError, match="inside dashboard"):
        package(tmp_path / "output", root=source)
    assert not (tmp_path / "output").exists()


def test_public_docs_do_not_reference_private_paths_or_planning():
    for name in ("README.md", "docs/installation.md", "docs/development.md"):
        text = (ROOT / name).read_text()
        assert "/Users/" not in text
        assert ".scratch/" not in text
        assert "hermes-reminders-kanban-evidence" not in text
