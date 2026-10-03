"""Policy and structured arguments for the live, external Nova command surface.

The upstream parser supplies feature names, options and choices. This module
owns the application's permissions: an update may add a recipe or query, but
cannot give an agent arbitrary files, a shell, or an external CAD process.
"""
from __future__ import annotations

import json
import math
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

MANIFEST_VERSION = 1
MAX_ARGUMENT_BYTES = 65_536
MAX_INPUT_FILE_BYTES = 4_000_000
MAX_ARTIFACT_BYTES = 16_000_000
SAFE_FAMILIES = frozenset({
    "examples", "spaceship", "mechanism", "technic", "vehicle", "design",
    "catalog", "search", "discover", "part", "colours", "spec", "matrix",
    "profiles", "sections", "study", "bom", "inspect", "validate", "connectors",
})
SAFE_FEATURE_VERBS = frozenset({"list", "parts", "details", "recipe", "plan", "brief", "check", "search", "show"})
BLOCKED_COMMAND_WORDS = frozenset({
    "index", "doctor", "render", "glb", "cad-check", "compare-bom", "prepare",
    "catalog", "review", "example", "execute", "exec", "shell", "run", "python",
    "install", "download", "upload", "delete", "remove", "serve", "sync",
})
PATH_ROLES = {
    "file": "read_source", "contract": "read_json", "results": "read_json",
    "output": "write_file", "report": "write_file", "outdir": "write_directory",
}
PATH_LIKE = re.compile(r"(?:path|file|directory|folder|script|command|executable|url|uri|token|credentials|config|notes|manifest|csv|reference|destination|target|source|state|save|load|write|read)|(?:^|_)(?:dir|key)(?:$|_)", re.I)
SAFE_TEXT_ARGUMENTS = frozenset({"name", "query", "kind", "code", "id", "section", "palette", "category", "yes", "no", "title"})
IDENTITY = re.compile(r"^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$")
RESOURCE_REFERENCE = re.compile(r"^(?:@[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+|[A-Za-z0-9][A-Za-z0-9 _-]*(?:\.dat)?)$")


def capability_permission(command: list[str], arguments: list[dict]) -> tuple[bool, str | None]:
    """Approve construction/query families, while failing closed on new I/O."""
    if not command:
        return False, "Invalid upstream command"
    if command[0] not in SAFE_FAMILIES and not (len(command) == 2 and command[-1] in SAFE_FEATURE_VERBS):
        return False, "This command family requires a separately reviewed adapter"
    if any(word in BLOCKED_COMMAND_WORDS for word in command if word != "catalog"):
        return False, "External processes and unscoped mutations are unavailable"
    if command[0] == "discover" and command[1:] not in (["search"], ["show"], ["recipe"]):
        return False, "Reference rendering and mutation use the app-owned reference adapter"
    if any(word in BLOCKED_COMMAND_WORDS for word in command[1:]):
        return False, "External processes and unscoped mutations are unavailable"
    if command[0] == "mechanism" and command[1:] != ["list"]:
        return False, "Mechanism source manuals require a separately reviewed adapter"
    if len(command) > 1 and command[-1] not in SAFE_FEATURE_VERBS and command != ["spaceship", "export"]:
        return False, "This operation requires a separately reviewed adapter"
    for argument in arguments:
        name = argument["name"]
        if argument.get("action") not in {"store", "store_true", "store_false", "append", "count"}:
            return False, "This parser action requires a separately reviewed adapter"
        if argument.get("converter", "str") not in {"str", "int", "float", "positive", "bool", "None"}:
            return False, "This option converter requires a separately reviewed adapter"
        if name not in PATH_ROLES and PATH_LIKE.search(name) and not (name == "profile" and argument.get("choices") is not None):
            return False, "This filesystem or process option requires a separately reviewed adapter"
        if (argument.get("type", "string") == "string" and argument.get("choices") is None
                and name not in PATH_ROLES and name not in SAFE_TEXT_ARGUMENTS):
            return False, "This free-text option requires a separately reviewed adapter"
        if (argument.get("path_role") or "").startswith("read_") and argument.get("default") is not None:
            return False, "An implicit input resource requires a separately reviewed adapter"
        if argument.get("unsupported_default"):
            return False, "This parser default requires a separately reviewed adapter"
    return True, None


def argument_schema(argument: dict) -> dict:
    value_type = argument.get("type", "string")
    schema = {"type": value_type if value_type in {"integer", "number", "boolean"} else "string"}
    if schema["type"] == "string":
        schema.update(maxLength=4000)
    if argument.get("choices") is not None:
        schema["enum"] = argument["choices"]
    if argument.get("description"):
        schema["description"] = argument["description"]
    if argument.get("path_role"):
        schema["description"] = (schema.get("description", "") + " Relative resource name; confined by BrickBuilder's resource broker.").strip()
    nargs = argument.get("nargs")
    if nargs in {"+", "*"} or type(nargs) is int or argument.get("action") == "append":
        count = nargs if type(nargs) is int else None
        schema = {"type": "array", "items": schema, "maxItems": count or 32,
                  "minItems": count if count is not None else 1 if nargs == "+" else 0}
    return schema


def command_parameters(arguments: list[dict]) -> dict:
    public = [item for item in arguments if not str(item.get("path_role", "")).startswith("write_")
              and item["name"] != "force"]
    return {"type": "object", "properties": {item["name"]: argument_schema(item) for item in public},
            "required": [item["name"] for item in public if item["required"]], "additionalProperties": False}


@dataclass(frozen=True)
class CapabilityRegistry:
    """Validated descriptions from one activated upstream checkout."""
    manifest: dict

    @classmethod
    def from_manifest(cls, manifest: dict) -> "CapabilityRegistry":
        if (not isinstance(manifest, dict) or type(manifest.get("schema_version")) is not int
                or manifest.get("schema_version") != MANIFEST_VERSION
                or manifest.get("compatible") is not True or not isinstance(manifest.get("capabilities"), list)):
            raise ValueError("Nova returned an incompatible capability manifest")
        identities = set()
        for capability in manifest["capabilities"]:
            if not isinstance(capability, dict) or not IDENTITY.fullmatch(str(capability.get("id", ""))):
                raise ValueError("Nova returned an invalid capability identity")
            if capability["id"] in identities or capability.get("command") != capability["id"].split("."):
                raise ValueError("Nova returned inconsistent command identities")
            identities.add(capability["id"])
            if not isinstance(capability.get("arguments"), list):
                raise ValueError("Nova returned an invalid capability signature")
            allowed, _ = capability_permission(capability["command"], capability["arguments"])
            if capability.get("available") is True and not allowed:
                raise ValueError("Nova returned an unsupported capability permission")
        return cls(manifest)

    @property
    def available(self) -> list[dict]:
        return [item for item in self.manifest["capabilities"] if item.get("available") is True]

    @property
    def plan_schema(self) -> dict:
        return self.manifest["plan_schema"]

    def get(self, identity: str) -> dict:
        if not isinstance(identity, str) or not IDENTITY.fullmatch(identity):
            raise ValueError("Invalid upstream capability identity")
        capability = next((item for item in self.available if item["id"] == identity), None)
        if capability is None:
            raise ValueError("This upstream capability is unavailable in BrickBuilder")
        return capability

    def catalog(self, query: str = "") -> list[dict]:
        if not isinstance(query, str) or len(query) > 500:
            raise ValueError("Invalid capability query")
        words = query.casefold().split()
        return [item for item in self.available
                if all(word in (item["id"] + " " + item.get("description", "")).casefold() for word in words)]


class ResourceBroker:
    """Resolve declared resources without exposing arbitrary local filenames."""
    def __init__(self, toolkit_root: Path, library: Path, workspace: Path, capability_id: str = "tools", invocation_id: str | None = None):
        self.toolkit_root = toolkit_root.resolve()
        self.library = library.resolve()
        self.workspace = workspace.resolve()
        if not IDENTITY.fullmatch(capability_id):
            raise ValueError("Invalid capability resource namespace")
        self.output_root = self.workspace / "upstream" / capability_id
        if invocation_id is not None:
            if not re.fullmatch(r"[a-f0-9]{32}", invocation_id):
                raise ValueError("Invalid invocation resource namespace")
            self.output_root /= invocation_id
        self.input_roots = (self.workspace, self.toolkit_root / "examples",
                            self.toolkit_root / "data" / "models-annotated", self.library / "parts")

    def _relative(self, value: Any) -> Path:
        if (not isinstance(value, str) or not 1 <= len(value) <= 400 or "\x00" in value
                or "\\" in value or value.startswith("-") or Path(value).is_absolute()
                or any(part in {"..", "."} for part in value.split("/"))):
            raise ValueError("Resources require a safe relative name")
        return Path(value)

    def resolve(self, value: str, role: str) -> str:
        relative = self._relative(value)
        if role.startswith("write_"):
            path = self.output_root / relative
            resolved = path.resolve()
            if not resolved.is_relative_to(self.output_root.resolve()):
                raise ValueError("Output resource leaves the private workspace")
            if self.output_root.is_symlink() or any(parent.is_symlink() for parent in (path, *path.parents)
                                                     if parent.is_relative_to(self.workspace)):
                raise ValueError("Symlink output resources are unavailable")
            if role == "write_file" and resolved.suffix.lower() not in {".json", ".mpd", ".ldr", ".txt"}:
                raise ValueError("Unsupported output resource format")
            resolved.parent.mkdir(parents=True, exist_ok=True)
            return str(resolved)
        # Names are explicit about bundled namespaces; other names are private
        # job resources. Neither /Users paths nor runtime code are readable.
        if value.startswith(("examples/", "data/models-annotated/")):
            candidate = self.toolkit_root / relative
        elif value.startswith("parts/"):
            candidate = self.library / relative
        else:
            candidate = self.workspace / relative
        path = candidate.resolve()
        allowed = [root for root in self.input_roots
                   if root.resolve().is_relative_to(self.workspace)
                   or root.resolve().is_relative_to(self.toolkit_root)
                   or root.resolve().is_relative_to(self.library)]
        if not any(path.is_relative_to(root.resolve()) for root in allowed):
            raise ValueError("Input resource leaves the approved source libraries")
        if not path.is_file() or path.stat().st_size > MAX_INPUT_FILE_BYTES:
            raise ValueError("Input resource is missing or exceeds the inspection limit")
        suffixes = {".json"} if role == "read_json" else {".ldr", ".mpd", ".dat"}
        if path.suffix.lower() not in suffixes:
            raise ValueError("Unsupported input resource format")
        if path.suffix.lower() == ".json":
            document = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(document, dict) and (document.get("includes") or document.get("assets")):
                raise ValueError("External plan includes and assets are unavailable")
        return str(path)

    def artifacts(self) -> list[dict]:
        total, file_count, results = 0, 0, []
        shared_root = self.workspace / "upstream"
        if not shared_root.exists():
            return results
        if shared_root.is_symlink():
            raise ValueError("Invalid upstream output resource")
        for path in sorted(shared_root.rglob("*")):
            if path.is_symlink() or not path.resolve().is_relative_to(shared_root):
                raise ValueError("Invalid upstream output resource")
            if path.is_file():
                file_count += 1
                total += path.stat().st_size
                if total > MAX_ARTIFACT_BYTES or file_count > 100:
                    raise ValueError("Upstream output resources exceed the retained size limit")
                if path.is_relative_to(self.output_root):
                    results.append({"path": str(path.relative_to(self.workspace)), "bytes": path.stat().st_size})
        return results

    def discard_outputs(self) -> None:
        """Remove this invocation's failed output, preserving previous studies."""
        if self.output_root.is_symlink():
            self.output_root.unlink()
        elif self.output_root.exists() and self.output_root.resolve().is_relative_to(self.workspace / "upstream"):
            shutil.rmtree(self.output_root)


def _scalar(value: Any, argument: dict, max_parts: int = 10_000) -> str:
    kind = argument.get("type", "string")
    if kind == "integer":
        if type(value) is not int or not -1_000_000 <= value <= 1_000_000:
            raise ValueError("Expected a bounded integer option")
    elif kind == "number":
        if type(value) not in {int, float} or not math.isfinite(value) or abs(value) > 1_000_000:
            raise ValueError("Expected a finite numeric option")
    elif not isinstance(value, str) or len(value) > 4000 or any(char in value for char in "\x00\r\n"):
        raise ValueError("Expected a bounded text option")
    if isinstance(value, str) and value.startswith("-"):
        raise ValueError("Text values cannot be command options")
    if argument.get("choices") is not None and value not in argument["choices"]:
        raise ValueError("Choose an option from the live upstream capability schema")
    name = argument["name"]
    if name in {"limit", "pool", "candidates", "max_candidates", "max_instances", "levels", "height"}:
        maximum = max_parts if name == "max_instances" else 1000
        minimum = 1 if name in {"candidates", "max_candidates", "max_instances", "levels", "height"} else 0
        if type(value) is not int or not minimum <= value <= maximum:
            raise ValueError("This inspection or construction budget exceeds the app limit")
    if name == "code" and not RESOURCE_REFERENCE.fullmatch(str(value)):
        raise ValueError("Part identities must be library references or catalog symbols")
    return str(value)


def safe_argument_argv(capability: dict, values: dict, broker: ResourceBroker, max_parts: int = 10_000) -> list[str]:
    """Translate schema-matched data to argv; callers never supply argv text."""
    if not isinstance(values, dict):
        raise ValueError("Capability arguments must be a JSON object")
    if len(json.dumps(values, allow_nan=False).encode()) > MAX_ARGUMENT_BYTES:
        raise ValueError("Capability arguments exceed the size limit")
    arguments = capability["arguments"]
    known = {item["name"] for item in arguments}
    if set(values) - known:
        raise ValueError("Unknown upstream capability argument")
    values = dict(values)
    for argument in arguments:
        name = argument["name"]
        if ((argument.get("path_role") or "").startswith("write_")
                and (argument["required"] or argument.get("default") is not None) and name not in values):
            values[name] = "export" if argument["path_role"] == "write_directory" else "plan.json" if name == "output" else "report.json"
        if name == "max_instances":
            values.setdefault(name, max(1, min(argument.get("default", max_parts), max_parts)))
        if name in {"limit", "pool", "candidates", "max_candidates", "levels", "height"} and argument.get("default") is not None:
            values.setdefault(name, max(1, min(argument["default"], 1000)))
        if name == "contacts" and "auto" in (argument.get("choices") or []):
            values.setdefault(name, "auto")
        if name == "force":
            values.setdefault(name, True)
    if values.get("contacts") == "all":
        if values.get("max_instances", max_parts) > 500:
            raise ValueError("Full pair analysis requires a 500-instance or smaller inspection budget")
    result = list(capability["command"])
    for argument in arguments:
        name = argument["name"]
        if name not in values:
            if argument["required"]:
                raise ValueError("Missing a required upstream capability argument")
            continue
        value = values[name]
        option = next((item for item in argument["option_strings"] if item.startswith("--")), None)
        if not option and argument["option_strings"]:
            option = argument["option_strings"][0]
        action = argument["action"]
        if action in {"store_true", "store_false"}:
            if type(value) is not bool:
                raise ValueError("Expected a boolean option")
            if value == (action == "store_true"):
                result.append(option)
            continue
        if action == "count":
            if type(value) is not int or not 0 <= value <= 4:
                raise ValueError("Expected a bounded count option")
            result.extend([option] * value)
            continue
        nargs = argument.get("nargs")
        repeated = action == "append"
        array = nargs in {"+", "*"} or type(nargs) is int or repeated
        if array:
            if not isinstance(value, list) or len(value) > 32 or (nargs == "+" and not value) or (type(nargs) is int and len(value) != nargs):
                raise ValueError("Invalid upstream option array length")
            entries = value
        else:
            entries = [value]
        encoded = [broker.resolve(item, argument["path_role"]) if argument.get("path_role") else _scalar(item, argument, max_parts)
                   for item in entries]
        if repeated:
            for item in encoded:
                result.extend([option, item])
        else:
            if option:
                result.append(option)
            result.extend(encoded)
    return result
