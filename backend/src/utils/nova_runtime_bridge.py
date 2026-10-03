"""Introspect and invoke Nova through an app-owned, fixed subprocess program.

This file runs with Nova's isolated interpreter. The app supplies JSON data;
the installed upstream parser and functions supply the implementation. No
model-authored Python, arbitrary argv, or external CAD command is accepted.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib
import io
import json
import os
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace

try:
    from .nova_capabilities import (CapabilityRegistry, MANIFEST_VERSION, MAX_ARGUMENT_BYTES,
                                    PATH_ROLES, ResourceBroker, capability_permission,
                                    command_parameters, safe_argument_argv)
except ImportError:  # Direct execution by the isolated toolkit interpreter.
    from nova_capabilities import (CapabilityRegistry, MANIFEST_VERSION, MAX_ARGUMENT_BYTES,
                                   PATH_ROLES, ResourceBroker, capability_permission,
                                   command_parameters, safe_argument_argv)

MAX_MANIFEST_BYTES = 2_000_000
MAX_REPORT_BYTES = 3_500_000
CORE_COMMAND_ARGUMENTS = {
    "search": {"kind", "query", "limit"}, "part": {"code", "limit"},
    "examples": {"query", "family", "limit"}, "catalog": {"kind", "query", "limit", "measure"},
    "discover.search": {"kind", "query", "engine", "limit", "all_families"},
    "discover.show": {"id"}, "discover.recipe": {"name", "height", "colour", "accent", "output", "force"},
    "design": {"kind", "name", "output", "force"}, "vehicle.plan": {"name", "output", "force"},
    "technic.plan": {"name", "output", "force"},
    "build": {"plan", "output", "force", "detail", "contacts", "limit", "max_instances"},
    "inspect": {"file", "section", "offset", "limit", "detail", "contacts", "max_instances"},
}
CORE_CHOICE_CONTRACT = {
    ("search", "kind"): {"parts", "models", "submodels"},
    ("discover.search", "kind"): {"parts", "models", "submodels"},
    ("discover.search", "engine"): {"jev", "fts"},
    ("catalog", "kind"): {"categories", "parts", "colours"},
    ("design", "kind"): {"palettes", "details"},
    ("build", "detail"): {"summary"}, ("inspect", "detail"): {"summary"},
    ("build", "contacts"): {"auto"}, ("inspect", "contacts"): {"auto"},
    ("examples", "family"): {"building", "vehicle", "reference", "technic", "mechanism", "spaceship"},
}
CORE_INTEGER_ARGUMENTS = {"limit", "offset", "max_instances", "height", "colour", "accent"}
CORE_BOOLEAN_ARGUMENTS = {"all_families", "force", "measure"}
CORE_OPTIONAL_POSITIONALS = {("examples", "query"), ("catalog", "query"), ("discover.recipe", "name"), ("design", "name")}
CORE_POSITIONALS = {"kind", "query", "code", "id", "name", "plan", "file"}
CORE_IMPORTS = {
    "ldraw_tools.common": ("get_parts", "normalized", "jsonable", "DATA"),
    "ldraw_tools.discovery": ("DiscoveryIndex", "source_id"),
    "ldraw_tools.document": ("dependency_closure", "parse_source", "physical_context", "resolve_section", "section_table", "selected_source"),
    "ldraw_tools.builder": ("build_plan", "load_plan", "check_schema"),
}


class CompatibilityError(ValueError):
    def __init__(self, missing: list[str]):
        self.missing = missing
        super().__init__("Nova runtime compatibility check failed")


class QuietOutput(io.TextIOBase):
    """Discard upstream debug output, with a finite budget instead of a buffer."""
    def __init__(self):
        self.bytes = 0

    def write(self, text):
        self.bytes += len(text.encode("utf-8", errors="replace"))
        if self.bytes > 65_536:
            raise ValueError("Upstream diagnostic output exceeds its size limit")
        return len(text)


def _runtime(toolkit_root: Path):
    sys.path.insert(0, str(toolkit_root.resolve()))
    cli = importlib.import_module("ldraw_tools.cli")
    modules, missing = {}, []
    for name, attributes in CORE_IMPORTS.items():
        try:
            module = importlib.import_module(name)
            for attribute in attributes:
                if not hasattr(module, attribute):
                    missing.append(name + "." + attribute)
            modules[name] = module
        except ImportError:
            missing.append(name)
    if not callable(getattr(cli, "parser", None)) or not callable(getattr(cli, "run", None)):
        missing.append("ldraw_tools.cli.parser/run")
    if missing:
        raise CompatibilityError(missing)
    return SimpleNamespace(cli=cli, common=modules["ldraw_tools.common"], modules=modules)


def _type(action) -> tuple[str, str]:
    converter = getattr(action.type, "__name__", str(action.type))
    if isinstance(action, (argparse._StoreTrueAction, argparse._StoreFalseAction)):
        return "boolean", "bool"
    if isinstance(action, argparse._CountAction):
        return "integer", "int"
    if converter in {"int", "positive"}:
        return "integer", converter
    if converter == "float":
        return "number", converter
    return "string", converter


def _argument(action) -> dict:
    kinds = {argparse._StoreAction: "store", argparse._StoreTrueAction: "store_true",
             argparse._StoreFalseAction: "store_false", argparse._AppendAction: "append",
             argparse._CountAction: "count"}
    value_type, converter = _type(action)
    result = {
        "name": action.dest, "option_strings": list(action.option_strings),
        "type": value_type, "converter": converter, "action": kinds.get(type(action), type(action).__name__),
        "required": bool(action.required or (not action.option_strings and action.nargs not in {"?", "*"})),
        "nargs": action.nargs, "choices": list(action.choices) if action.choices is not None else None,
        "description": action.help if isinstance(action.help, str) and action.help != argparse.SUPPRESS else "",
        "path_role": PATH_ROLES.get(action.dest),
    }
    if action.default is not argparse.SUPPRESS and action.default is not None:
        default = action.default
        if isinstance(default, (str, int, float, bool, list, dict)):
            result["default"] = default
        elif isinstance(default, Path):
            result["default"] = str(default)
        else:
            result["unsupported_default"] = True
    return result


def parser_capabilities(parser: argparse.ArgumentParser) -> list[dict]:
    """Enumerate every leaf and its real parser signature, without running it."""
    result = []

    def walk(current, command, inherited=(), description=""):
        own = tuple(action for action in current._actions
                    if not isinstance(action, (argparse._HelpAction, argparse._SubParsersAction))
                    and action.dest not in {"library", "shadow", "no_shadow"})
        subparsers = [action for action in current._actions if isinstance(action, argparse._SubParsersAction)]
        if subparsers:
            for subparser in subparsers:
                helps = {item.dest: item.help for item in subparser._choices_actions}
                for name, child in subparser.choices.items():
                    walk(child, [*command, name], (*inherited, *own),
                         child.description or helps.get(name, "") or description)
            return
        if not command:
            return
        arguments = [_argument(action) for action in (*inherited, *own)]
        allowed, reason = capability_permission(command, arguments)
        result.append({"id": ".".join(command), "command": command, "description": description,
                       "available": allowed, "reason": reason, "arguments": arguments,
                       "parameters": command_parameters(arguments)})

    walk(parser, [])
    return sorted(result, key=lambda item: item["id"])


def build_manifest(toolkit_root: Path, library: Path, *, runtime=None) -> dict:
    """Check the stable app contract and export live options/schema together."""
    runtime = runtime or _runtime(toolkit_root)
    capabilities = parser_capabilities(runtime.cli.parser())
    table = {item["id"]: item for item in capabilities}
    missing = []
    for identity, names in CORE_COMMAND_ARGUMENTS.items():
        if identity not in table:
            missing.append("command:" + identity)
            continue
        available = {item["name"]: item for item in table[identity]["arguments"]}
        missing.extend("argument:" + identity + "." + name for name in sorted(names - set(available)))
        for name in names & set(available):
            argument = available[name]
            expected_type = "integer" if name in CORE_INTEGER_ARGUMENTS else "boolean" if name in CORE_BOOLEAN_ARGUMENTS else "string"
            expected_action = "store_true" if name in CORE_BOOLEAN_ARGUMENTS else "store"
            expected_nargs = "?" if (identity, name) in CORE_OPTIONAL_POSITIONALS else 0 if name in CORE_BOOLEAN_ARGUMENTS else None
            if (argument["type"] != expected_type or argument["action"] != expected_action
                    or argument["nargs"] != expected_nargs):
                missing.append("signature:" + identity + "." + name)
            expected_positional = name in CORE_POSITIONALS
            if expected_positional != (not argument["option_strings"]):
                missing.append("position:" + identity + "." + name)
            if not expected_positional and "--" + name.replace("_", "-") not in argument["option_strings"]:
                missing.append("option:" + identity + "." + name)
            expected_required = expected_positional and (identity, name) not in CORE_OPTIONAL_POSITIONALS
            expected_required |= name == "output" and identity in {"build", "vehicle.plan", "technic.plan"}
            if argument["required"] != expected_required:
                missing.append("required:" + identity + "." + name)
        for name in set(available) - names:
            if available[name]["required"]:
                missing.append("new-required-argument:" + identity + "." + name)
    for (identity, name), choices in CORE_CHOICE_CONTRACT.items():
        argument = next((item for item in table.get(identity, {}).get("arguments", []) if item["name"] == name), {})
        if not choices.issubset(argument.get("choices") or []):
            missing.append("choice:" + identity + "." + name)
    schema_path = Path(runtime.common.DATA) / "plan.schema.json"
    if not schema_path.is_file() or schema_path.stat().st_size > MAX_MANIFEST_BYTES:
        missing.append("plan.schema.json")
        schema = {}
    else:
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        if (not isinstance(schema, dict) or schema.get("type") != "object"
                or not {"version", "author", "sections"}.issubset(schema.get("properties", {}))
                or not {"version", "author", "sections"}.issubset(schema.get("required", []))
                or schema.get("properties", {}).get("version", {}).get("const") != 1):
            missing.append("plan.schema.v1")
        # Existing host validation rejects includes/assets. External schema
        # references would bypass the offline dependency boundary.
        def external_refs(value):
            if isinstance(value, dict):
                return (isinstance(value.get("$ref"), str) and not value["$ref"].startswith("#")) or any(external_refs(item) for item in value.values())
            return isinstance(value, list) and any(external_refs(item) for item in value)
        if external_refs(schema):
            missing.append("plan.schema.external-reference")
    if missing:
        raise CompatibilityError(missing)
    result = {
        "schema_version": MANIFEST_VERSION, "compatible": True,
        "contract": {"compatible": True, "missing": [], "schema_sha256": hashlib.sha256(json.dumps(schema, sort_keys=True).encode()).hexdigest()},
        "plan_schema": schema, "capabilities": capabilities,
    }
    if len(json.dumps(result, allow_nan=False).encode()) > MAX_MANIFEST_BYTES:
        raise ValueError("Nova capability manifest exceeds its size limit")
    return result


def invoke(toolkit_root: Path, library: Path, workspace: Path, request: dict, *, max_parts: int = 10_000, runtime=None) -> dict:
    if not isinstance(request, dict) or set(request) - {"capability", "arguments"}:
        raise ValueError("Invalid upstream capability request")
    runtime = runtime or _runtime(toolkit_root)
    registry = CapabilityRegistry.from_manifest(build_manifest(toolkit_root, library, runtime=runtime))
    capability = registry.get(request.get("capability"))
    broker = ResourceBroker(toolkit_root, library, workspace, capability["id"], uuid.uuid4().hex)
    broker.artifacts()  # Retained limits span every capability, including retries.
    arguments = request.get("arguments", {})
    if isinstance(arguments, dict) and any(item["name"] == "engine" for item in capability["arguments"]) and not os.getenv("TYPESAFE_API_KEY"):
        arguments = {**arguments, "engine": "fts"}
    try:
        argv = safe_argument_argv(capability, arguments, broker, max_parts)
        args = runtime.cli.parser().parse_args(["--library", str(library.resolve()), *argv])
        with contextlib.redirect_stdout(QuietOutput()), contextlib.redirect_stderr(QuietOutput()):
            report, status = runtime.cli.run(args)
        report = runtime.common.jsonable(report)
        encoded = json.dumps(report, allow_nan=False)
        if len(encoded.encode()) > MAX_REPORT_BYTES:
            raise ValueError("Upstream capability report exceeds its size limit; request a smaller result")
        # Paths in reports are resources for the app, not extra local filesystem
        # access. Confinement was enforced before invoking the upstream function.
        return {"capability": capability["id"], "status": int(status), "report": report, "artifacts": broker.artifacts()}
    except BaseException:
        broker.discard_outputs()
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--toolkit-root", type=Path, required=True)
    parser.add_argument("--library", type=Path, required=True)
    parser.add_argument("--operation", choices=["manifest", "invoke"], required=True)
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--max-parts", type=int, default=10_000)
    args = parser.parse_args()
    try:
        if not 1 <= args.max_parts <= 10_000:
            raise ValueError("Invalid construction budget")
        with contextlib.redirect_stdout(QuietOutput()), contextlib.redirect_stderr(QuietOutput()):
            if args.operation == "manifest":
                result = build_manifest(args.toolkit_root, args.library)
            else:
                if args.workspace is None or not args.workspace.is_dir():
                    raise ValueError("Invocation requires a private job workspace")
                raw = sys.stdin.buffer.read(MAX_ARGUMENT_BYTES + 1)
                if len(raw) > MAX_ARGUMENT_BYTES:
                    raise ValueError("Capability request exceeds its size limit")
                request = json.loads(raw, parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))
                result = invoke(args.toolkit_root, args.library, args.workspace, request, max_parts=args.max_parts)
        print(json.dumps(result, allow_nan=False))
        return 0
    except CompatibilityError as exc:
        result = {"schema_version": MANIFEST_VERSION, "compatible": False,
                  "error": str(exc), "contract": {"compatible": False, "missing": exc.missing}}
    except (Exception, SystemExit):
        # Never forward exception strings, CLI debug output or stderr. New
        # upstream code may include paths, credentials or submitted text there.
        result = {"schema_version": MANIFEST_VERSION, "compatible": False,
                  "error": "Nova capability operation failed; check its supported arguments and runtime compatibility"}
    print(json.dumps(result))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
