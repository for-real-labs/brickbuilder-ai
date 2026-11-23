"""Runs build scripts out of process, with no credentials and bounded resources."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .kit import Build, Placement
from .sandbox import ScriptOutcome

_BOOT = "import sys; sys.path.insert(0, sys.argv[1]); from fable_agent.sandbox import main; main()"
_PACKAGE_ROOT = str(Path(__file__).resolve().parents[1])
MAX_RESULT_BYTES = 64 * 1024 * 1024


@dataclass(frozen=True)
class KitSettings:
    ldraw_dir: str
    catalog_path: str | None = None
    open_palette: bool = False
    cache_dir: str | None = None
    max_placements: int = 6000

    def to_dict(self) -> dict:
        return {"ldraw_dir": self.ldraw_dir, "catalog_path": self.catalog_path,
                "open_palette": self.open_palette, "cache_dir": self.cache_dir,
                "max_placements": self.max_placements}


class ScriptRunner(Protocol):
    def run(self, code: str) -> ScriptOutcome: ...


def _limit_resources(cpu_seconds: int):
    def apply():  # pragma: no cover - runs in the child between fork and exec
        import resource

        limits = [(resource.RLIMIT_CPU, cpu_seconds), (resource.RLIMIT_FSIZE, 64 * 1024 * 1024),
                  (resource.RLIMIT_CORE, 0)]
        if sys.platform.startswith("linux"):
            limits.append((resource.RLIMIT_AS, 4 * 1024 ** 3))
        for kind, value in limits:
            try:
                resource.setrlimit(kind, (value, value))
            except (ValueError, OSError):
                pass
    return apply


class SubprocessScriptRunner:
    """Each run gets a fresh interpreter, an empty directory and a scrubbed environment."""

    def __init__(self, settings: KitSettings, *, timeout: int = 90, python: str | None = None):
        self._settings = settings
        self._timeout = timeout
        self._python = python or sys.executable

    def run(self, code: str) -> ScriptOutcome:
        request = json.dumps({"code": code, "settings": self._settings.to_dict()})
        with tempfile.TemporaryDirectory(prefix="fable-build-") as scratch:
            environment = {"PATH": "/usr/bin:/bin", "HOME": scratch, "LANG": "C.UTF-8",
                           "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1", "PYTHONDONTWRITEBYTECODE": "1"}
            try:
                completed = subprocess.run(  # noqa: S603 - fixed argv, no shell
                    [self._python, "-I", "-c", _BOOT, _PACKAGE_ROOT], input=request.encode(),
                    capture_output=True, cwd=scratch, env=environment, timeout=self._timeout,
                    preexec_fn=_limit_resources(self._timeout + 5) if sys.platform != "win32" else None,
                    check=False)
            except subprocess.TimeoutExpired:
                return ScriptOutcome(None, "", f"The script ran longer than {self._timeout} seconds and was stopped")
        if len(completed.stdout) > MAX_RESULT_BYTES:
            return ScriptOutcome(None, "", "The script produced too much output")
        try:
            result = json.loads(completed.stdout)
        except ValueError:
            return ScriptOutcome(None, "", "The script crashed the build process (out of memory or time)")
        output = str(result.get("output") or "")
        if not result.get("ok"):
            return ScriptOutcome(None, output, str(result.get("error") or "The script failed"), result.get("line"))
        build = Build(
            placements=[Placement(p[0], int(p[1]), tuple(p[2]), tuple(p[3]), p[4], int(p[5]), bool(p[6]))
                        for p in result["placements"]],
            links=[(int(a), int(b), str(note)) for a, b, note in result.get("links", [])])
        return ScriptOutcome(build, output)
