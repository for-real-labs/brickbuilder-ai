"""Resolve one immutable upstream checkout for the lifetime of a build."""
from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Mapping

BACKEND_ROOT = Path(__file__).resolve().parents[2]
_REVISION = re.compile(r"[a-f0-9]{40}")


@dataclass(frozen=True)
class NovaRuntime:
    root: Path
    python: Path
    source: str
    toolkit_revision: str | None = None
    toolkit_branch: str | None = None
    jev_revision: str | None = None
    jev_branch: str | None = None

    def provenance(self, capability_hash: str | None = None) -> dict:
        """Record reproducibility information without local paths or secrets."""
        result = {"schema_version": 1, "selection": self.source,
                  "toolkit_repository": "https://github.com/anteloc/ldraw-nova",
                  "jev_repository": "https://github.com/anteloc/jev-rerank",
                  "toolkit_revision": self.toolkit_revision, "toolkit_branch": self.toolkit_branch,
                  "jev_revision": self.jev_revision, "jev_branch": self.jev_branch}
        if capability_hash:
            result["capability_sha256"] = capability_hash
        return result


def _manifest_path(home: Path, value: object, *, executable: bool = False) -> Path:
    if not isinstance(value, str) or not 1 <= len(value) <= 400 or "\x00" in value:
        raise ValueError("Invalid managed Nova runtime path")
    value = value.replace("\\", "/")
    parts = PurePosixPath(value)
    if parts.is_absolute() or ":" in value or any(piece in {"", ".", ".."} for piece in value.split("/")):
        raise ValueError("Managed Nova runtime paths must stay inside .nova")
    path = home.joinpath(*parts.parts).absolute()
    # A venv's Python executable normally points outside the venv. Validate
    # its directory instead, preserving the executable's virtualenv identity.
    checked = path.parent.resolve() if executable else path.resolve()
    if not checked.is_relative_to(home.resolve()):
        raise ValueError("Managed Nova runtime paths must stay inside .nova")
    return path if executable else checked


def _optional_identity(data: dict, key: str, *, revision: bool = False) -> str | None:
    value = data.get(key)
    if value is None:
        return None
    pattern = _REVISION if revision else re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,199}")
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ValueError("Invalid managed Nova revision metadata")
    return value


def resolve_nova_runtime(backend_dir: Path | None = None, environment: Mapping[str, str] | None = None) -> NovaRuntime:
    """Select active managed state, explicit configuration, or legacy install.

    Local startup marks the paths it exports as managed. Subsequent jobs then
    read the latest atomic pointer; existing NovaToolkit instances retain the
    earlier resolved paths throughout every tool call.
    """
    environment = os.environ if environment is None else environment
    home = Path(backend_dir or BACKEND_ROOT).resolve() / ".nova"
    explicit = bool(environment.get("NOVA_TOOLKIT_ROOT") or environment.get("NOVA_PYTHON"))
    if explicit and environment.get("NOVA_MANAGED_RUNTIME") != "true":
        root = Path(environment.get("NOVA_TOOLKIT_ROOT", home / "toolkit")).expanduser().resolve()
        default = root / ".venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        python = Path(environment.get("NOVA_PYTHON", default)).expanduser().absolute()
        return NovaRuntime(root, python, "explicit")

    manifest = home / "runtime.json"
    if manifest.exists():
        if not manifest.resolve().is_relative_to(home.resolve()) or manifest.stat().st_size > 65_536:
            raise ValueError("Invalid managed Nova runtime manifest")
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
        except (ValueError, OSError) as exc:
            raise ValueError("Cannot read the managed Nova runtime manifest; run npm run update:nova") from exc
        if not isinstance(data, dict) or type(data.get("schema_version")) is not int or data["schema_version"] != 1:
            raise ValueError("Unsupported managed Nova runtime manifest")
        root = _manifest_path(home, data.get("toolkit_root"))
        python = _manifest_path(home, data.get("python"), executable=True)
        expected_bin = root / ".venv" / ("Scripts" if sys.platform == "win32" else "bin")
        if (not python.parent.resolve().is_relative_to(root) or (root / ".venv").is_symlink()
                or python.parent.resolve() != expected_bin.resolve()
                or python.name != ("python.exe" if sys.platform == "win32" else "python")):
            raise ValueError("Managed Nova interpreter must belong to its selected checkout")
        return NovaRuntime(root, python, "managed",
                           _optional_identity(data, "toolkit_revision", revision=True),
                           _optional_identity(data, "toolkit_branch"),
                           _optional_identity(data, "jev_revision", revision=True),
                           _optional_identity(data, "jev_branch"))

    root = home / "toolkit"
    python = root / ".venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    return NovaRuntime(root, python, "legacy")
