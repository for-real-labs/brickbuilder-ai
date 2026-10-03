"""A constrained process boundary to the separately installed AGPL Nova toolkit.

This module does not vendor Nova source or execute model-authored Python. Its
JSON plans are compiled by the selected external runtime, then independently
expanded and rendered with BrickBuilder's geometry adapter.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import hashlib
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .nova_geometry import LDrawMeshRenderer, REFERENCE_RE, flatten_mpd

BACKEND_ROOT = Path(__file__).resolve().parents[2]
MAX_PLAN_BYTES = 1_500_000
MAX_REPORT_CHARS = 42_000
MAX_RESOURCE_PAGE_CHARS = 18_000
MAX_TOOLKIT_STDOUT_BYTES = 4_000_000
MAX_TOOLKIT_STDERR_BYTES = 65_536
TOOLKIT_ENVIRONMENT_KEYS = {
    "HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "COMSPEC", "PATHEXT",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
}
SYMBOL_RE = re.compile(r"^@[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$")


def _compact_feedback(value: Any) -> Any:
    if isinstance(value, list):
        return [_compact_feedback(item) for item in value]
    if not isinstance(value, dict):
        return value
    result = {key: _compact_feedback(item) for key, item in value.items() if key != "geometry"}
    geometry = value.get("geometry")
    if isinstance(geometry, dict):
        priority = ("complete", "part_count", "triangle_count", "source_instance_count", "rendered_colours", "renderer",
                    "physical_validity", "occurrence_count", "connection_coverage", "contacts_checked",
                    "optimistic_component_count", "confirmed_component_count", "contact_count", "bounds", "diagnostics", "limitations")
        compact = {key: geometry[key] for key in priority if key in geometry}
        for key in ("optimistic_components", "confirmed_components"):
            groups = geometry.get(key)
            if isinstance(groups, list):
                compact[key] = [group[:100] if isinstance(group, list) else group for group in groups[:30]]
                compact[key + "_sizes"] = [len(group) if isinstance(group, list) else None for group in groups[:30]]
                compact[key + "_omitted"] = len(groups) > 30 or any(isinstance(group, list) and len(group) > 100 for group in groups)
            elif key in geometry:
                compact[key] = groups
        instances = geometry.get("instances", [])
        if isinstance(instances, list):
            compact["instances"] = [{key: instance[key] for key in ("index", "part", "position", "matrix", "section", "line_number") if key in instance}
                                    for instance in instances[:60] if isinstance(instance, dict)]
            compact["instances_omitted"] = len(instances) > 60 or bool(geometry.get("instances_truncated"))
            compact["instance_offset"] = geometry.get("instance_offset", 0)
        compact["overlaps"] = geometry.get("overlaps", [])[:20]
        compact["overlaps_omitted"] = len(geometry.get("overlaps", [])) > 20 or bool(geometry.get("overlaps_truncated"))
        compact["feedback_note"] = ("Detailed contact arrays and bulky instance metadata are omitted. Component lists contain at most 30 groups and 100 indices per group; instances contain at most 60 rows. "
                                    "Use inspect_build with a section or offset for remaining placements, and inspect_part to check stud positions and connector dimensions.")
        result["geometry"] = compact
    if isinstance(result.get("stud_positions"), list):
        count = len(result["stud_positions"])
        result["stud_positions"] = result["stud_positions"][:100]
        result["stud_positions_total"] = count
        result["stud_positions_omitted"] = count > 100
    if isinstance(result.get("connectors"), list):
        count = len(result["connectors"])
        result["connectors"] = result["connectors"][:20]
        result["connector_rows_omitted"] = count > 20 or bool(result.get("connectors_truncated"))
    return result


def serialize_feedback(report: Any) -> str:
    """Keep useful diagnostics first and always return bounded, complete JSON."""
    compact = _compact_feedback(report)
    encoded = json.dumps(compact, default=str, allow_nan=False)
    if len(encoded) <= MAX_REPORT_CHARS:
        return encoded

    def shrink(value, list_limit, text_limit):
        if isinstance(value, dict):
            return {key: shrink(item, list_limit, text_limit) for key, item in value.items()}
        if isinstance(value, list):
            return [shrink(item, list_limit, text_limit) for item in value[:list_limit]]
        if isinstance(value, str) and len(value) > text_limit:
            return value[:text_limit] + " [Content omitted for feedback size limit.]"
        return value

    for list_limit, text_limit in ((30, 20_000), (15, 8_000), (8, 2_000), (4, 500)):
        bounded = shrink(compact, list_limit, text_limit)
        if not isinstance(bounded, dict):
            bounded = {"results": bounded}
        bounded["feedback_truncated"] = True
        bounded["feedback_note"] = "Some rows/text are omitted for size. Inspect a smaller section or use an offset for further placements."
        encoded = json.dumps(bounded, default=str, allow_nan=False)
        if len(encoded) <= MAX_REPORT_CHARS:
            return encoded
    # Unusual deeply nested upstream metadata must not produce malformed JSON
    # or monopolize the model context. Ordinary geometry uses the paths above.
    return json.dumps({"feedback_truncated": True, "error": "This report is too large. Inspect a smaller assembly section or a single part."})


def validate_plan_boundary(plan: dict, max_parts: int) -> None:
    """Reject file access, recursion and expansion bombs before toolkit validation."""
    try:
        encoded = json.dumps(plan, allow_nan=False)
    except (TypeError, ValueError, RecursionError) as exc:
        raise ValueError("Plan must contain finite JSON values") from exc
    if len(encoded.encode()) > MAX_PLAN_BYTES or not isinstance(plan, dict):
        raise ValueError("The assembly plan is too large")
    if plan.get("includes") or plan.get("assets"):
        raise ValueError("Use self-contained sections; external plan includes and assets are disabled")
    sections = plan.get("sections")
    if not isinstance(sections, list) or not 1 <= len(sections) <= 200:
        raise ValueError("A plan requires between 1 and 200 sections")
    table = {}
    placement_count = 0
    for section in sections:
        if not isinstance(section, dict):
            raise ValueError("Invalid section")
        name = section.get("name", "")
        if not isinstance(name, str) or not REFERENCE_RE.fullmatch(name) or not name.lower().endswith(".ldr"):
            raise ValueError("Unsafe assembly section name")
        key = name.casefold()
        if key in table:
            raise ValueError("Section names must be unique ignoring case")
        steps = section.get("steps")
        if not isinstance(steps, list) or not 1 <= len(steps) <= 1000:
            raise ValueError("A section requires bounded build steps")
        placements = []
        for step in steps:
            if not isinstance(step, list) or not 1 <= len(step) <= 1000:
                raise ValueError("Invalid build step")
            for placement in step:
                if not isinstance(placement, dict):
                    raise ValueError("Invalid part placement")
                reference = placement.get("ref", "")
                if not isinstance(reference, str) or not (REFERENCE_RE.fullmatch(reference) or SYMBOL_RE.fullmatch(reference)):
                    raise ValueError("Unsafe part reference")
                repeat = placement.get("repeat", {})
                if not isinstance(repeat, dict):
                    raise ValueError("Invalid placement repeat")
                count = repeat.get("count", 1)
                if type(count) is not int or not 1 <= count <= max_parts:
                    raise ValueError("Invalid repeat count")
                placements.append((reference.casefold(), count))
                placement_count += 1
                if placement_count > max_parts * 2:
                    raise ValueError("Too many plan placements")
        table[key] = placements

    counts = {}

    def expanded_count(name, ancestors=()):
        if name in ancestors or len(ancestors) >= 40:
            raise ValueError("Cyclic or excessively nested assembly")
        if name in counts:
            return counts[name]
        total = 0
        for reference, count in table[name]:
            if reference.endswith(".ldr") and reference not in table:
                raise ValueError(f"Unknown assembly section: {reference}")
            total += count * (expanded_count(reference, (*ancestors, name)) if reference in table else 1)
            if total > max_parts:
                raise ValueError(f"The assembly exceeds the {max_parts:,}-part limit")
        counts[name] = total
        return total

    for name in table:
        expanded_count(name)


@dataclass(frozen=True)
class NovaReference:
    id: str
    source_mpd: str
    preview_mpd: str
    metadata: dict
    preview_png: bytes | None


@dataclass(frozen=True)
class NovaBuild:
    ldr: str
    mpd: str
    plan: dict
    report: dict
    preview_png: bytes
    references: tuple[NovaReference, ...] = ()
    runtime: dict | None = None


class NovaToolkit:
    def __init__(self, workspace: Path, max_parts: int = 5_000, use_jev: bool = True):
        from .nova_runtime import resolve_nova_runtime
        self.workspace = workspace.resolve()
        self.runtime = resolve_nova_runtime(BACKEND_ROOT)
        self.root, self.python = self.runtime.root, self.runtime.python
        self.library = Path(os.getenv("LDRAW_DIR", os.getenv("LDRAWDIR", Path.home() / "ldraw"))).expanduser().resolve()
        self.max_parts = max_parts
        self.use_jev = use_jev and bool(os.getenv("TYPESAFE_API_KEY"))
        self.renderer = LDrawMeshRenderer(self.library)
        self.last_build: NovaBuild | None = None
        self.last_build_turn = -1
        self.references: dict[str, NovaReference] = {}
        self.reference_inspections = 0
        self.capabilities = None
        self.capability_tools: dict[str, str] = {}
        self.capability_manifest: dict | None = None
        self.used_capabilities: set[str] = set()

    def require_ready(self) -> None:
        if not (self.root / "ldraw_tools" / "cli.py").is_file() or not self.python.is_file():
            raise ValueError("Nova toolkit is not installed. Run npm run setup:nova, then restart local development.")
        if not (self.library / "parts").is_dir() or not (self.library / "LDConfig.ldr").is_file():
            raise ValueError("Nova requires an official LDraw library; run npm run setup:nova.")

    async def run(self, arguments: list[str], timeout: int = 240) -> Any:
        return await self._run_process([str(self.python), "-m", "ldraw_tools.cli", "--library", str(self.library), *arguments], arguments[0], timeout)

    async def prepare_capabilities(self) -> None:
        """Bind the actual upstream signatures once, before model reasoning."""
        from .nova_capabilities import CapabilityRegistry
        if self.capabilities is not None:
            return
        manifest = await self._run_process(
            [str(self.python), str(Path(__file__).with_name("nova_runtime_bridge.py")),
             "--toolkit-root", str(self.root), "--library", str(self.library), "--operation", "manifest"],
            "capabilities")
        self.capabilities = CapabilityRegistry.from_manifest(manifest)
        self.capability_manifest = manifest

    def agent_tools(self, core_tools):
        """Generate provider-neutral tools from this snapshot's live parser."""
        from .llm_tool_conversation import ToolSpec
        if self.capabilities is None:
            raise ValueError("Prepare the upstream capabilities before starting an agent")
        available = self.capabilities.available
        if len(available) > 100:
            raise ValueError("Nova exposes too many capabilities for one agent context")
        tools = list(core_tools)
        self.capability_tools.clear()
        for capability in available:
            identity = capability["id"]
            name = "nova_" + identity.replace(".", "_").replace("-", "_")
            if len(name) > 64 or name in self.capability_tools:
                name = name[:45] + "_" + hashlib.sha256(identity.encode()).hexdigest()[:16]
            self.capability_tools[name] = identity
            description = (capability.get("description") or "Use this upstream construction or inspection feature.")
            tools.append(ToolSpec(name, description + " Runs the installed Nova implementation; outputs stay in the private job workspace.",
                                  capability["parameters"]))
        return tools

    def runtime_provenance(self) -> dict:
        capabilities = self.capability_manifest
        capability_hash = hashlib.sha256(json.dumps(capabilities["capabilities"], sort_keys=True).encode()).hexdigest() if capabilities else None
        result = self.runtime.provenance(capability_hash)
        if capabilities:
            result["plan_schema_sha256"] = capabilities.get("contract", {}).get("schema_sha256")
        result["used_capabilities"] = sorted(self.used_capabilities)
        return result

    async def invoke_capability(self, identity: str, arguments: dict) -> tuple[dict, None]:
        if self.capabilities is None:
            raise ValueError("Prepare the upstream capabilities before invoking a feature")
        capability = self.capabilities.get(identity)
        from jsonschema import Draft202012Validator
        if list(Draft202012Validator(capability["parameters"]).iter_errors(arguments)):
            raise ValueError("Arguments do not match this runtime's upstream capability schema")
        if identity == "discover.search" and not self.use_jev:
            arguments = {**arguments, "engine": "fts"}
        request = json.dumps({"capability": identity, "arguments": arguments}, allow_nan=False).encode()
        self.workspace.mkdir(parents=True, exist_ok=True)
        response = await self._run_process(
            [str(self.python), str(Path(__file__).with_name("nova_runtime_bridge.py")),
             "--toolkit-root", str(self.root), "--library", str(self.library), "--operation", "invoke",
             "--workspace", str(self.workspace), "--max-parts", str(self.max_parts)],
            "capability", input_data=request)
        if not isinstance(response, dict) or response.get("capability") != identity:
            raise ValueError("Upstream returned an inconsistent capability response")
        self.used_capabilities.add(identity)
        return response, None

    async def _run_process(self, command: list[str], operation: str, timeout: int = 240, input_data: bytes | None = None) -> Any:
        """Run only a fixed app/toolkit adapter, with the same bounded boundary."""
        self.require_ready()
        if input_data is not None and (not isinstance(input_data, bytes) or len(input_data) > 65_536):
            raise ValueError("Upstream capability request exceeds its size limit")
        environment = {name: value for name, value in os.environ.items() if name in TOOLKIT_ENVIRONMENT_KEYS}
        environment.update({"LDRAW_DIR": str(self.library),
                            "PATH": str(self.python.parent) + os.pathsep + os.environ.get("PATH", "")})
        if self.use_jev and os.getenv("TYPESAFE_API_KEY"):
            environment["TYPESAFE_API_KEY"] = os.environ["TYPESAFE_API_KEY"]
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=str(self.root), env=environment, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, stdin=asyncio.subprocess.PIPE if input_data is not None else asyncio.subprocess.DEVNULL,
            start_new_session=True,
        )

        async def read_bounded(stream, limit):
            chunks, size = [], 0
            while chunk := await stream.read(65_536):
                size += len(chunk)
                if size > limit:
                    raise ValueError("Nova toolkit output exceeds the supported size")
                chunks.append(chunk)
            return b"".join(chunks)

        async def send_input():
            if input_data is not None:
                process.stdin.write(input_data)
                try:
                    await process.stdin.drain()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                finally:
                    process.stdin.close()

        output_task = asyncio.gather(read_bounded(process.stdout, MAX_TOOLKIT_STDOUT_BYTES),
                                     read_bounded(process.stderr, MAX_TOOLKIT_STDERR_BYTES), process.wait(), send_input())
        try:
            stdout, _stderr, _returncode, _input = await asyncio.wait_for(output_task, timeout=timeout)
        except BaseException:
            # Drain both pipes concurrently, and terminate the whole process
            # group on cancellation, timeout, output overflow or a pipe error.
            if process.returncode is None:
                with suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                await process.wait()
            output_task.cancel()
            await asyncio.gather(output_task, return_exceptions=True)
            raise
        try:
            result = json.loads(stdout)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            # Error output can contain upstream process details; keep it bounded
            # and never forward provider credentials or environment values.
            raise ValueError(f"Nova toolkit could not complete {operation} (exit {process.returncode})") from exc
        if process.returncode not in {0, 1}:
            message = str(result.get("error", "Invalid toolkit request"))[:4000] if isinstance(result, dict) else "Invalid toolkit request"
            for key in ("TYPESAFE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "FAL_KEY"):
                secret = os.getenv(key)
                if secret:
                    message = message.replace(secret, "[redacted]")
            raise ValueError(f"Nova {operation}: {message}")
        return result

    def read_resource_page(self, path: str, offset: int = 0) -> dict:
        if not isinstance(path, str) or len(path) > 500:
            raise ValueError("Invalid toolkit resource path")
        job_resource = path.startswith(("references/", "upstream/"))
        target = ((self.workspace if job_resource else self.root) / path).resolve()
        allowed = (self.root / "docs", self.root / "examples", self.root / "ldraw_tools" / "data",
                   self.root / "data" / "models-annotated", self.workspace / "references", self.workspace / "upstream")
        instruction = target == self.root / "instructions.md"
        suffixes = {".md", ".json", ".py", ".ldr", ".mpd"} | ({".txt"} if job_resource else set())
        if not (instruction or any(target.is_relative_to(directory) for directory in allowed)) or target.suffix not in suffixes:
            raise ValueError("Only toolkit manuals, schemas and example sources are readable")
        if not target.is_file():
            raise ValueError("Toolkit resource not found")
        size_limit = 4_000_000 if job_resource else MAX_PLAN_BYTES
        if target.stat().st_size > size_limit:
            raise ValueError("Resource is too large; choose a smaller subassembly example")
        content = target.read_text(encoding="utf-8", errors="replace")
        if type(offset) is not int or not 0 <= offset <= len(content):
            raise ValueError("Resource offset must be an integer character position within the file")
        page = content[offset:offset + MAX_RESOURCE_PAGE_CHARS]

        def result():
            next_offset = offset + len(page)
            return {"source": path, "content": page, "offset": offset, "total_chars": len(content),
                    "next_offset": next_offset if next_offset < len(content) else None,
                    "note": "Offsets count characters. Read the next page with the same path and next_offset until next_offset is null."}

        # Escape-heavy Unicode can expand in JSON. Adapt the page itself before
        # returning its cursor so later serialization never skips source text.
        while len(json.dumps(result(), allow_nan=False)) > MAX_REPORT_CHARS:
            page = page[:len(page) // 2]
        return result()

    def read_resource(self, path: str, offset: int = 0) -> str:
        """Convenience text reader; tools use read_resource_page for cursors."""
        return self.read_resource_page(path, offset)["content"]

    async def search(self, kind: str, query: str, limit: int = 8) -> Any:
        if kind not in {"parts", "models", "submodels"}:
            raise ValueError("Search kind must be parts, models, or submodels")
        query = _bounded_text(query, 500)
        limit = _bounded_integer(limit, 1, 20)
        engine = "jev" if self.use_jev else "fts"
        if engine == "fts":
            # Nova's typed discovery index inventories the whole source corpus.
            # Its ordinary FTS command uses existing data directly, avoiding a
            # minutes-long cold start when semantic ranking is not configured.
            return {"engine": "fts", "results": await self.run(["search", kind, query, "--limit", str(limit)]),
                    "fallback_reason": "semantic_disabled_or_unconfigured",
                    "note": "For offline full-text searches use short specific terms, such as 'brick 2 x 4' or 'steering'. Refine or split queries with no matches."}
        arguments = ["discover", "search", kind, query, "--engine", engine, "--limit", str(limit), "--all-families"]
        fallback_reason = None
        try:
            results = await self.run(arguments)
            # Semantic discovery reports identify the engine and typed corpus.
            # Do not relabel a successful lexical/malformed response as Jev.
            if (not isinstance(results, dict) or results.get("error")
                    or results.get("engine") != "jev" or results.get("kind") != kind
                    or not isinstance(results.get("results"), list)):
                raise ValueError("Semantic search unavailable")
        except (ValueError, asyncio.TimeoutError):
            # FTS remains usable during Jev outages and with no TypeSafe key.
            results = await self.run(["search", kind, query, "--limit", str(limit)])
            engine = "fts"
            fallback_reason = "semantic_unavailable"
        return {"engine": engine, "results": results, **({"fallback_reason": fallback_reason} if fallback_reason else {})}

    async def build(self, plan: dict, turn_number: int) -> tuple[dict, bytes | None]:
        self.last_build = None
        validate_plan_boundary(plan, self.max_parts)
        plan_path, mpd_path = self.workspace / "model.plan.json", self.workspace / "model.mpd"
        plan_path.write_text(json.dumps(plan, indent=2, allow_nan=False), encoding="utf-8")
        report = await self.run(["build", str(plan_path), "--output", str(mpd_path), "--force",
                                 "--detail", "summary", "--contacts", "auto", "--limit", "50",
                                 "--max-instances", str(self.max_parts)])
        if not isinstance(report, dict) or not report.get("checks_passed") or not report.get("written"):
            return {"accepted": False, "report": report, "instruction": "Repair the plan using diagnostics, then submit_plan again."}, None
        mpd = mpd_path.read_text(encoding="utf-8")
        ldr = flatten_mpd(mpd, self.max_parts)
        preview = await asyncio.to_thread(self.renderer.render, ldr)
        self.last_build = NovaBuild(ldr, mpd, plan, report, preview, runtime=self.runtime_provenance())
        self.last_build_turn = turn_number
        return {"accepted": True, "report": report, "part_count": sum(line.startswith("1 ") for line in ldr.splitlines()),
                "instruction": "Review both rendered views against the request. Check proportions, details and attachment evidence. Submit repairs or accept_model on your next turn. Physical validity is not proven by these checks."}, preview

    async def inspect_reference(self, reference: str, section: str | None = None, colour: int | None = None) -> tuple[dict, bytes | None]:
        """Extract canonical bundled source and independently render its mesh."""
        reference = _bounded_text(reference, 400)
        if self.reference_inspections >= 16:
            raise ValueError("At most sixteen reference inspections are available per build; adapt the references already studied")
        if len(self.references) >= 8 and reference not in self.references:
            raise ValueError("At most eight reference studies are retained per build; choose the most useful techniques")
        if section is not None:
            section = _bounded_text(section, 400)
        if colour is not None:
            colour = _bounded_integer(colour, 0, 0x3FFFFFF)
            if colour in {16, 24}:
                raise ValueError("Choose an explicit preview colour")
        key = hashlib.sha256(json.dumps([reference, section]).encode()).hexdigest()[:20]
        directory = self.workspace / "references" / key
        command = [str(self.python), str(Path(__file__).with_name("nova_reference_bridge.py")),
                   "--toolkit-root", str(self.root), "--library", str(self.library),
                   "--reference", reference, "--max-instances", "10000", "--output", str(directory)]
        if section is not None:
            command += ["--section", section]
        if colour is not None:
            command += ["--colour", str(colour)]
        self.reference_inspections += 1
        result = await self._run_process(command, "inspect_reference")
        if not isinstance(result, dict) or result.get("written") is not True or not re.fullmatch(r"(?:model|submodel)-[a-f0-9]{24}", str(result.get("id", ""))):
            raise ValueError("Reference extraction did not return a canonical model identity")
        source_path, preview_path, metadata_path = (directory / name for name in ("source.mpd", "preview.mpd", "metadata.json"))
        for path in (source_path, preview_path, metadata_path):
            if not path.resolve().is_relative_to(directory) or not path.is_file() or path.stat().st_size > 4_000_000:
                raise ValueError("Invalid or oversized extracted reference resource")
        source, preview_source = source_path.read_text(encoding="utf-8"), preview_path.read_text(encoding="utf-8")
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if not isinstance(metadata, dict) or metadata.get("id") != result["id"]:
            raise ValueError("Reference extraction metadata has an inconsistent identity")
        if len(self.references) >= 8 and metadata["id"] not in self.references:
            raise ValueError("At most eight reference studies are retained per build; choose the most useful techniques")
        metadata["source_resource"] = str(source_path.relative_to(self.workspace))
        metadata["preview_resource"] = str(preview_path.relative_to(self.workspace))
        metadata["metadata_resource"] = str(metadata_path.relative_to(self.workspace))
        preview = None
        try:
            preview, geometry = await asyncio.to_thread(self.renderer.render_mpd, preview_source, max_parts=10_000)
            metadata["geometry"] = {"complete": True, **geometry,
                                    "renderer": "actual LDraw triangles, opposite-angle software views"}
        except ValueError as exc:
            metadata["geometry"] = {"complete": False, "diagnostics": [{"code": "reference_preview_unavailable", "message": str(exc)[:1000]}]}
        retained_bytes = len(source.encode()) + len(preview_source.encode()) + len(preview or b"") + len(json.dumps(metadata).encode())
        retained_bytes += sum(len(item.source_mpd.encode()) + len(item.preview_mpd.encode()) + len(item.preview_png or b"") + len(json.dumps(item.metadata).encode())
                              for identity, item in self.references.items() if identity != metadata["id"])
        if retained_bytes > 16_000_000:
            raise ValueError("Reference studies exceed the retained source budget; inspect a smaller submodel")
        metadata_path.write_text(json.dumps(metadata, allow_nan=False), encoding="utf-8")
        if preview:
            (directory / "review.png").write_bytes(preview)
        self.references[metadata["id"]] = NovaReference(metadata["id"], source, preview_source, metadata, preview)
        report = dict(metadata)
        inventory = dict(metadata.get("inventory") or {})
        for name, limit in (("bom", 120), ("dependencies", 40), ("parents", 12), ("nonphysical_or_unresolved_leaves", 20)):
            rows = inventory.get(name)
            if isinstance(rows, list):
                inventory[name] = rows[:limit]
                inventory[name + "_total_rows"] = len(rows)
                inventory[name + "_omitted"] = len(rows) > limit
        report["inventory"] = inventory
        report["attribution"] = metadata.get("attribution", [])[:40]
        report["attribution_total_rows"] = len(metadata.get("attribution", []))
        report["attribution_omitted"] = report["attribution_total_rows"] > 40
        report["instruction"] = ("Study the two actual-geometry views and BOM. Read source_resource with read_resource and follow next_offset for the complete extracted technique. "
                                 "If BOM, dependencies or attribution rows are omitted, read metadata_resource with read_resource for the full inventory and provenance. "
                                 "Adapt the construction into your own plan, retain attribution where source is reused, and inspect its real parts before changing dimensions. Full provenance and reference previews are retained in the private source archive.")
        if not preview:
            report["instruction"] += " Preview geometry could not be completed. Choose a smaller discovered submodel, or use this model's source path with a section to inspect a bounded assembly."
        return report, preview

    async def dispatch(self, name: str, arguments: dict, turn_number: int) -> tuple[Any, bytes | None]:
        if name in self.capability_tools:
            return await self.invoke_capability(self.capability_tools[name], arguments)
        if name == "search_references":
            return await self.search(arguments.get("kind", "parts"), arguments.get("query", ""), arguments.get("limit", 8)), None
        if name == "inspect_part":
            reference = _bounded_text(arguments.get("part", ""), 200)
            if not REFERENCE_RE.fullmatch(reference) and not SYMBOL_RE.fullmatch(reference):
                raise ValueError("Unsafe part reference")
            report = await self.run(["part", reference, "--limit", "20"])
            preview = None
            if isinstance(report, dict) and report.get("complete") and report.get("code"):
                ldr = f"1 7 0 0 0 1 0 0 0 1 0 0 0 1 {report['code']}\n"
                preview = await asyncio.to_thread(self.renderer.render, ldr, 360, False)
            return report, preview
        if name == "inspect_reference":
            return await self.inspect_reference(arguments.get("id", ""), arguments.get("section"), arguments.get("colour"))
        if name == "search_examples":
            family = arguments.get("family", "building")
            if family not in {"building", "vehicle", "reference", "technic", "mechanism", "spaceship"}:
                raise ValueError("Unknown example family")
            return await self.run(["examples", _bounded_text(arguments.get("query", ""), 500, allow_empty=True), "--family", family, "--limit", "5"]), None
        if name == "catalog":
            kind = arguments.get("kind", "parts")
            if kind not in {"parts", "categories", "colours"}:
                raise ValueError("Unknown catalog kind")
            command = ["catalog", kind, _bounded_text(arguments.get("query", ""), 500, allow_empty=True), "--limit", "12"]
            if kind == "parts":
                command.append("--measure")
            return await self.run(command), None
        if name == "read_resource":
            return self.read_resource_page(arguments.get("path", ""), arguments.get("offset", 0)), None
        if name == "construction_recipe":
            family = arguments.get("family", "design")
            if family not in {"design", "vehicle", "technic", "discover"}:
                raise ValueError("Unknown recipe family")
            recipe_name = _bounded_text(arguments.get("name", ""), 150, allow_empty=True)
            if not recipe_name:
                command = [family, "details"] if family == "design" else [family, "recipe" if family == "discover" else "list"]
                return await self.run(command), None
            target = self.workspace / "recipe.plan.json"
            command = [family, "details" if family == "design" else "recipe" if family == "discover" else "plan", recipe_name,
                       "--output", str(target), "--force"]
            report = await self.run(command)
            if target.is_file():
                report = {"recipe": report, "plan": json.loads(target.read_text())}
            return report, None
        if name == "submit_plan":
            return await self.build(arguments.get("plan"), turn_number)
        if name == "inspect_build":
            if not self.last_build:
                raise ValueError("Submit a successful plan first")
            section = arguments.get("section")
            offset = _bounded_integer(arguments.get("offset", 0), 0, self.max_parts)
            command = ["inspect", str(self.workspace / "model.mpd"), "--detail", "full", "--limit", "60", "--offset", str(offset), "--max-instances", str(self.max_parts)]
            if section:
                if not isinstance(section, str) or not REFERENCE_RE.fullmatch(section):
                    raise ValueError("Invalid assembly section")
                command += ["--section", section]
            return await self.run(command), None
        raise ValueError(f"Unknown Nova tool: {name}")


def _bounded_text(value, maximum: int, allow_empty=False) -> str:
    if not isinstance(value, str) or len(value) > maximum or "\x00" in value or (not value.strip() and not allow_empty):
        raise ValueError("Invalid or oversized text argument")
    return value.strip()


def _bounded_integer(value, minimum, maximum) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError("Integer argument is outside supported limits")
    return value
