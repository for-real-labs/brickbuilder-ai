import json
import shutil
from pathlib import Path

import pytest

from src.utils.nova_runtime import resolve_nova_runtime
from src.utils.nova_toolkit import NovaToolkit


def activate(backend, name="a", **overrides):
    home = backend / ".nova"
    root = home / "snapshots" / name / "toolkit"
    (root / "ldraw_tools").mkdir(parents=True, exist_ok=True)
    (root / "ldraw_tools" / "cli.py").touch()
    binary = root / ".venv" / "bin"
    binary.mkdir(parents=True, exist_ok=True)
    (binary / "python").touch()
    data = {"schema_version": 1, "toolkit_root": str(root.relative_to(home)),
            "python": str((binary / "python").relative_to(home)),
            "toolkit_revision": name * 40, "toolkit_branch": "master",
            "jev_revision": "c" * 40, "jev_branch": "main", **overrides}
    (home / "runtime.json").write_text(json.dumps(data))
    return root, data


def test_managed_runtime_follows_new_selector_but_existing_job_keeps_its_snapshot(monkeypatch, tmp_path):
    from src.utils import nova_toolkit
    root_a, _ = activate(tmp_path)
    monkeypatch.setattr(nova_toolkit, "BACKEND_ROOT", tmp_path)
    monkeypatch.delenv("NOVA_TOOLKIT_ROOT", raising=False)
    monkeypatch.delenv("NOVA_PYTHON", raising=False)
    toolkit = NovaToolkit(tmp_path / "job")
    root_b, _ = activate(tmp_path, "b")
    assert toolkit.root == root_a
    assert toolkit.python.parent.is_relative_to(root_a)
    assert toolkit.runtime.provenance()["toolkit_revision"] == "a" * 40
    next_toolkit = NovaToolkit(tmp_path / "next-job")
    assert next_toolkit.root == root_b
    assert next_toolkit.runtime.provenance()["toolkit_revision"] == "b" * 40


def test_startup_managed_exports_do_not_pin_subsequent_jobs_to_old_snapshot(tmp_path):
    root_a, _ = activate(tmp_path)
    environment = {"NOVA_MANAGED_RUNTIME": "true", "NOVA_TOOLKIT_ROOT": str(root_a),
                   "NOVA_PYTHON": str(root_a / ".venv" / "bin" / "python")}
    root_b, _ = activate(tmp_path, "b")
    assert resolve_nova_runtime(tmp_path, environment).root == root_b


def test_custom_checkout_override_is_preserved_and_uses_its_own_python(tmp_path):
    activate(tmp_path)
    custom = tmp_path / "custom"
    selected = resolve_nova_runtime(tmp_path, {"NOVA_TOOLKIT_ROOT": str(custom)})
    assert selected.source == "explicit" and selected.root == custom
    assert selected.python == custom / ".venv" / "bin" / "python"
    external_python = tmp_path / "venv" / "bin" / "python"
    selected = resolve_nova_runtime(tmp_path, {"NOVA_TOOLKIT_ROOT": str(custom), "NOVA_PYTHON": str(external_python)})
    assert selected.python == external_python


def test_runtime_preserves_virtualenv_executable_symlink(tmp_path):
    root, data = activate(tmp_path)
    binary = root / ".venv" / "bin" / "python"
    binary.unlink()
    real = tmp_path / "base-python"
    real.touch()
    binary.symlink_to(real)
    selected = resolve_nova_runtime(tmp_path, {})
    assert selected.python == binary and selected.python != real
    assert selected.python.is_file()


@pytest.mark.parametrize("field,value", [
    ("toolkit_root", "../private"), ("toolkit_root", "/private"),
    ("python", "snapshots/a/../../private/python"), ("python", "C:\\private\\python"),
    ("toolkit_revision", "not-a-sha"), ("toolkit_branch", "master\nsecret"),
    ("schema_version", True), ("schema_version", 2),
])
def test_managed_manifest_rejects_escape_invalid_identity_and_versions(tmp_path, field, value):
    activate(tmp_path, **{field: value})
    with pytest.raises(ValueError):
        resolve_nova_runtime(tmp_path, {})


def test_managed_manifest_does_not_follow_symlinked_checkout_directory(tmp_path):
    root, data = activate(tmp_path)
    external = tmp_path / "external"
    external.mkdir()
    link = tmp_path / ".nova" / "outside"
    link.symlink_to(external, target_is_directory=True)
    data["toolkit_root"] = "outside"
    (tmp_path / ".nova" / "runtime.json").write_text(json.dumps(data))
    with pytest.raises(ValueError, match="inside .nova"):
        resolve_nova_runtime(tmp_path, {})


def test_managed_manifest_cannot_mix_checkout_with_other_snapshot_interpreter(tmp_path):
    _, data_a = activate(tmp_path)
    _, data_b = activate(tmp_path, "b")
    data_a["python"] = data_b["python"]
    (tmp_path / ".nova" / "runtime.json").write_text(json.dumps(data_a))
    with pytest.raises(ValueError, match="belong to its selected checkout"):
        resolve_nova_runtime(tmp_path, {})


def test_managed_interpreter_parent_cannot_symlink_to_another_snapshot(tmp_path):
    root_a, data_a = activate(tmp_path)
    root_b, _ = activate(tmp_path, "b")
    shutil.rmtree(root_a / ".venv")
    (root_a / ".venv").symlink_to(root_b / ".venv", target_is_directory=True)
    (tmp_path / ".nova" / "runtime.json").write_text(json.dumps(data_a))
    with pytest.raises(ValueError, match="belong to its selected checkout"):
        resolve_nova_runtime(tmp_path, {})


def test_runtime_provenance_excludes_local_paths_and_environment_credentials(tmp_path):
    activate(tmp_path)
    runtime = resolve_nova_runtime(tmp_path, {"TYPESAFE_API_KEY": "secret-private-key"})
    provenance = runtime.provenance("d" * 64)
    assert provenance["toolkit_revision"] == "a" * 40
    assert provenance["capability_sha256"] == "d" * 64
    assert str(tmp_path) not in json.dumps(provenance)
    assert "secret-private-key" not in json.dumps(provenance)


def test_missing_manifest_preserves_legacy_install_location(tmp_path):
    runtime = resolve_nova_runtime(tmp_path, {})
    assert runtime.source == "legacy" and runtime.root == tmp_path / ".nova" / "toolkit"
