"""Runs build scripts out of process: no credentials, bounded resources, a separate account.

A build script is code the model wrote, so it is treated as untrusted. The dialect check in
``sandbox`` is the first barrier. This module is the second: the script runs in a fresh
interpreter with an empty environment and hard limits and, on a server, under an unprivileged
operating-system account that can read the parts library and nothing that belongs to the caller.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Protocol

from .kit import Build, Placement
from .sandbox import ScriptOutcome

_BOOT = "import sys; sys.path.insert(0, sys.argv[1]); from fable_agent.sandbox import main; main()"
_PACKAGE_ROOT = str(Path(__file__).resolve().parents[1])
MAX_RESULT_BYTES = 64 * 1024 * 1024
SANDBOX_USER_ENV = "FABLE_SANDBOX_USER"
FALLBACK_ACCOUNT = "nobody"


class SandboxError(RuntimeError):
    """Build scripts cannot be run safely in this environment, so none are run."""


@dataclass(frozen=True)
class Account:
    """The operating-system account build scripts run under."""

    name: str
    uid: int | None
    gid: int | None
    separate: bool  # False when scripts share the caller's account (a developer's machine)


def script_account(environ: Mapping[str, str] | None = None) -> Account:
    """Decide which account runs build scripts, or refuse.

    - ``FABLE_SANDBOX_USER`` names the account to use. Only root can switch to it, so a caller
      that is neither root nor that account is refused.
    - Root never runs a script itself: without the setting it switches to ``nobody``.
    - Any other caller without the setting runs scripts as itself. That suits a developer's
      machine; a shared service must set the variable.
    """
    environ = os.environ if environ is None else environ
    wanted = (environ.get(SANDBOX_USER_ENV) or "").strip()
    if not hasattr(os, "geteuid"):  # no POSIX accounts to switch between
        if wanted:
            raise SandboxError(f"{SANDBOX_USER_ENV} is set, but this system cannot switch accounts")
        return Account("caller", None, None, False)
    import pwd

    caller = os.geteuid()
    if not wanted and caller != 0:
        return Account("caller", caller, os.getegid(), False)
    name = wanted or FALLBACK_ACCOUNT
    try:
        entry = pwd.getpwnam(name)
    except KeyError:
        raise SandboxError(f"The build-script account {name!r} does not exist") from None
    if entry.pw_uid == 0:
        raise SandboxError("Build scripts must not run as root")
    if entry.pw_uid == caller:
        return Account(name, caller, os.getegid(), False)
    if caller != 0:
        raise SandboxError(f"Only root can run build scripts as {name!r}, and this process is not root")
    return Account(name, entry.pw_uid, entry.pw_gid, True)


@dataclass(frozen=True)
class KitSettings:
    ldraw_dir: str
    catalog_path: str | None = None
    open_palette: bool = False
    cache_dir: str | None = None
    max_placements: int = 6000
    inventory_csv: str | None = None
    studio_only: bool = False

    def to_dict(self) -> dict:
        return {"ldraw_dir": self.ldraw_dir, "catalog_path": self.catalog_path,
                "open_palette": self.open_palette, "cache_dir": self.cache_dir,
                "max_placements": self.max_placements, "inventory_csv": self.inventory_csv, "studio_only": self.studio_only}


class ScriptRunner(Protocol):
    def run(self, code: str) -> ScriptOutcome: ...


def _real(path: str | None) -> str | None:
    """A path with links resolved by the caller, which may be able to follow links the script account cannot."""
    return str(Path(path).expanduser().resolve()) if path else path


class SubprocessScriptRunner:
    """Each run gets a fresh interpreter, an empty directory, a scrubbed environment and hard limits."""

    def __init__(self, settings: KitSettings, *, timeout: int = 90, python: str | None = None,
                 account: Account | None = None):
        self._settings = settings
        self._timeout = timeout
        self._python = python or sys.executable
        self._account = account or script_account()

    @property
    def account(self) -> Account:
        return self._account

    def _limits(self) -> dict:
        limits = {"CPU": self._timeout + 5, "FSIZE": 64 * 1024 * 1024, "CORE": 0}
        if sys.platform.startswith("linux"):
            limits["AS"] = 4 * 1024 ** 3
        if self._account.separate:
            # These count against the script account only, so they cannot starve the caller.
            limits.update(NPROC=64, NOFILE=256)
        return limits

    def run(self, code: str) -> ScriptOutcome:
        account = self._account
        settings = {**self._settings.to_dict(), "ldraw_dir": _real(self._settings.ldraw_dir),
                    "catalog_path": _real(self._settings.catalog_path)}
        request = json.dumps({"code": code, "settings": settings})
        with tempfile.TemporaryDirectory(prefix="fable-build-") as scratch:
            environment = {"PATH": "/usr/bin:/bin", "HOME": scratch, "LANG": "C.UTF-8",
                           "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1", "PYTHONDONTWRITEBYTECODE": "1"}
            switch = {}
            if account.separate:
                os.chown(scratch, account.uid, account.gid)
                switch = {"user": account.uid, "group": account.gid, "extra_groups": []}
            try:
                # The child lowers its own limits before it reads the request (see sandbox.confine):
                # a preexec hook is not safe in a threaded server.
                completed = subprocess.run(  # noqa: S603 - fixed argv, no shell
                    [self._python, "-I", "-c", _BOOT, _PACKAGE_ROOT, json.dumps(self._limits())],
                    input=request.encode(), capture_output=True, cwd=scratch, env=environment,
                    timeout=self._timeout, check=False, **switch)
            except subprocess.TimeoutExpired:
                return ScriptOutcome(None, "", f"The script ran longer than {self._timeout} seconds and was stopped")
            except (OSError, subprocess.SubprocessError) as exc:
                raise SandboxError(f"The build process could not be started: {type(exc).__name__}") from None
        if len(completed.stdout) > MAX_RESULT_BYTES:
            return ScriptOutcome(None, "", "The script produced too much output")
        try:
            result = json.loads(completed.stdout)
        except ValueError:
            return ScriptOutcome(None, "", "The script crashed the build process (out of memory or time)")
        if not isinstance(result, dict):
            return ScriptOutcome(None, "", "The script crashed the build process (out of memory or time)")
        if account.separate and result.get("uid") != account.uid:
            raise SandboxError("The build process did not run under its own account; its result was discarded")
        output = str(result.get("output") or "")
        if not result.get("ok"):
            return ScriptOutcome(None, output, str(result.get("error") or "The script failed"), result.get("line"))
        build = Build(
            placements=[Placement(p[0], int(p[1]), tuple(p[2]), tuple(p[3]), p[4], int(p[5]), bool(p[6]))
                        for p in result["placements"]],
            links=[(int(a), int(b), str(note)) for a, b, note in result.get("links", [])])
        return ScriptOutcome(build, output)
