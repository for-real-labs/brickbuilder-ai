"""Runs a model-written build script in a restricted Python dialect.

A build script only needs arithmetic, loops, functions and the kit. Everything else
is refused before execution: imports, classes, underscore and frame attributes, and
any builtin that reaches files, processes or the interpreter. The parent additionally
runs this module in a separate process with no credentials (see ``runner``).

This is defense in depth, not a security boundary on its own. A multi-tenant host
should still run builds under an unprivileged account or container.
"""

from __future__ import annotations

import ast
import builtins
import json
import math
import os
import random
import re
import sys
import traceback
import types
from dataclasses import dataclass
from pathlib import Path

from .catalog import PartFinder
from .helpers import bind as bind_helpers
from .kit import Build, Kit, KitError, rect, ring
from .ldraw import LDrawError, LDrawLibrary
from .palette import load_palette
from .shape import ShapeLibrary

SCRIPT_NAME = "build.py"
MAX_SCRIPT_BYTES = 400_000
MAX_PRINTED = 6000
_ALLOWED_IMPORTS = frozenset({"math", "random"})
_DENIED_NODES = (ast.ClassDef, ast.AsyncFunctionDef, ast.AsyncFor, ast.AsyncWith, ast.Await, ast.With)
_DENIED_ATTRIBUTES = re.compile(r"^(_|gi_|cr_|ag_|f_|tb_|co_)|^(format|format_map|mro|func_globals)$")
_DENIED_NAMES = frozenset({
    "eval", "exec", "compile", "open", "input", "globals", "locals", "vars", "dir", "getattr", "setattr",
    "delattr", "hasattr", "type", "object", "super", "breakpoint", "help", "exit", "quit", "memoryview",
    "classmethod", "staticmethod", "property",
})
_BUILTINS = (
    "abs", "all", "any", "bool", "chr", "dict", "divmod", "enumerate", "filter", "float", "frozenset", "int",
    "isinstance", "iter", "len", "list", "map", "max", "min", "next", "ord", "pow", "range", "repr",
    "reversed", "round", "set", "sorted", "str", "sum", "tuple", "zip",
    "ArithmeticError", "AssertionError", "Exception", "IndexError", "KeyError", "StopIteration",
    "TypeError", "ValueError", "ZeroDivisionError",
)


class ScriptError(ValueError):
    """The script was refused or failed; the message is written for the agent."""

    def __init__(self, message: str, line: int | None = None, output: str = ""):
        super().__init__(message)
        self.line = line
        self.output = output


@dataclass(frozen=True)
class ScriptOutcome:
    build: Build | None
    output: str
    error: str | None = None
    line: int | None = None


def validate_script(code: str) -> ast.Module:
    if len(code.encode("utf-8", errors="replace")) > MAX_SCRIPT_BYTES:
        raise ScriptError("The script is too large")
    try:
        tree = ast.parse(code, SCRIPT_NAME)
    except SyntaxError as exc:
        raise ScriptError(f"Syntax error: {exc.msg}", exc.lineno) from None
    for node in ast.walk(tree):
        line = getattr(node, "lineno", None)
        if isinstance(node, _DENIED_NODES):
            raise ScriptError(f"{type(node).__name__} is not available in build scripts; "
                              "use functions, loops and the kit", line)
        if isinstance(node, ast.Import):
            if any(alias.name not in _ALLOWED_IMPORTS for alias in node.names):
                raise ScriptError("Only math and random can be imported (both are already available)", line)
        elif isinstance(node, ast.ImportFrom):
            if node.module not in _ALLOWED_IMPORTS or node.level:
                raise ScriptError("Only math and random can be imported (both are already available)", line)
            if any(alias.name.startswith("_") or alias.name == "*" for alias in node.names):
                raise ScriptError("Import names explicitly, without underscores", line)
        elif isinstance(node, ast.Attribute) and _DENIED_ATTRIBUTES.search(node.attr):
            raise ScriptError(f"Attribute .{node.attr} is not available in build scripts", line)
        elif isinstance(node, ast.Name) and (node.id.startswith("__") or node.id in _DENIED_NAMES):
            raise ScriptError(f"{node.id} is not available in build scripts", line)
    return tree


def _public(module, names=None) -> types.SimpleNamespace:
    chosen = names or [name for name in dir(module) if not name.startswith("_")]
    return types.SimpleNamespace(**{name: getattr(module, name) for name in chosen})


def execute_script(code: str, kit: Kit) -> str:
    """Validate and run ``code`` against ``kit``; returns what the script printed."""
    tree = validate_script(code)
    printed: list[str] = []
    size = 0

    def capture(*values, sep=" ", end="\n", **_ignored):
        nonlocal size
        if size < MAX_PRINTED:
            text = str(sep).join(str(v) for v in values) + str(end)
            printed.append(text[: MAX_PRINTED - size])
            size += len(text)

    generator = random.Random(0)  # deterministic: the same script always builds the same model
    modules = {
        "math": _public(math),
        "random": _public(generator, ["random", "randint", "randrange", "choice", "uniform", "shuffle",
                                      "sample", "gauss", "seed"]),
    }

    def restricted_import(name, _globals=None, _locals=None, _fromlist=(), level=0):
        if level or name not in modules:
            raise ImportError("Only math and random are available in build scripts")
        return modules[name]

    safe = {name: getattr(builtins, name) for name in _BUILTINS}
    safe.update({"print": capture, "__import__": restricted_import, "True": True, "False": False, "None": None})
    scope = {
        "__builtins__": safe, "__name__": "build", **modules,
        "place": kit.place, "place_ldu": kit.place_ldu, "row": kit.row, "fill": kit.fill,
        "module": kit.module, "step": kit.step, "connect": kit.connect, "part": kit.part, "inset": kit.inset,
        "color": kit.color, "colour": kit.color, "rect": rect, "ring": ring, **bind_helpers(kit),
    }
    try:
        exec(compile(tree, SCRIPT_NAME, "exec"), scope)  # noqa: S102 - validated, restricted dialect
    except ScriptError:
        raise
    except RecursionError:
        raise ScriptError("The script recursed too deeply") from None
    except MemoryError:
        raise ScriptError("The script ran out of memory") from None
    except Exception as exc:  # noqa: BLE001 - every script failure is reported to the agent
        line = next((frame.lineno for frame in reversed(traceback.extract_tb(exc.__traceback__))
                     if frame.filename == SCRIPT_NAME), None)
        kind = "" if isinstance(exc, KitError) else f"{type(exc).__name__}: "
        raise ScriptError(f"{kind}{exc}"[:1500], line, "".join(printed)) from None
    return "".join(printed)


def build_kit(settings: dict) -> Kit:
    library = LDrawLibrary(settings.get("ldraw_dir"))
    cache = settings.get("cache_dir")
    shapes = ShapeLibrary(library, Path(cache) if cache else None)
    palette = load_palette(library, settings.get("catalog_path"), open_palette=bool(settings.get("open_palette")),
                           inventory_csv=settings.get("inventory_csv"), studio_only=bool(settings.get("studio_only")))
    return Kit(library, shapes, palette, PartFinder(library, palette),
               max_placements=int(settings.get("max_placements", 6000)))


def confine(limits: dict) -> None:
    """Bound this process before it runs a script. Limits can only be lowered from here on."""
    try:
        import resource
    except ImportError:  # not a POSIX system
        return
    for name, value in limits.items():
        kind = getattr(resource, f"RLIMIT_{name}", None)
        if kind is None:
            continue
        try:
            resource.setrlimit(kind, (int(value), int(value)))
        except (ValueError, OSError):
            pass
    if sys.platform.startswith("linux"):
        try:
            import ctypes

            ctypes.CDLL(None, use_errno=True).prctl(38, 1, 0, 0, 0)  # PR_SET_NO_NEW_PRIVS
        except (OSError, AttributeError):
            pass


def main() -> None:
    """Child-process entry: limits in argv, JSON request on stdin, JSON result on stdout."""
    if len(sys.argv) > 2:
        confine(json.loads(sys.argv[2]))
    request = json.loads(sys.stdin.read())
    # The parent checks this against the account it asked for.
    result: dict = {"ok": False, "output": "", "uid": os.geteuid() if hasattr(os, "geteuid") else None}
    try:
        kit = build_kit(request["settings"])
        result["output"] = execute_script(request["code"], kit)
        result.update(ok=True, links=kit.build.links, placements=[
            [p.part, p.color, p.position, p.matrix, p.module, p.step, p.allow_overlap]
            for p in kit.build.placements])
    except ScriptError as exc:
        result.update(error=str(exc), line=exc.line, output=exc.output)
    except (LDrawError, OSError, ValueError) as exc:
        result.update(error=f"Build environment error: {exc}"[:600])
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
