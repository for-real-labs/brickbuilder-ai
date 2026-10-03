"""A constrained process boundary to the separately installed AGPL Nova toolkit.

This module does not vendor Nova source or execute model-authored Python. Its
JSON plans are compiled by the pinned external dependency, then independently
expanded and rendered with BrickBuilder's geometry adapter.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import signal
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
        priority = ("complete", "physical_validity", "occurrence_count", "connection_coverage", "contacts_checked",
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
class NovaBuild:
    ldr: str
    mpd: str
    plan: dict
    report: dict
    preview_png: bytes


class NovaToolkit:
    def __init__(self, workspace: Path, max_parts: int = 5_000, use_jev: bool = True):
        self.workspace = workspace.resolve()
        self.root = Path(os.getenv("NOVA_TOOLKIT_ROOT", BACKEND_ROOT / ".nova" / "toolkit")).expanduser().resolve()
        # Preserve the virtualenv executable path: resolving its symlink would
        # run the base interpreter without the isolated toolkit dependencies.
        self.python = Path(os.getenv("NOVA_PYTHON", self.root / ".venv" / "bin" / "python")).expanduser().absolute()
        self.library = Path(os.getenv("LDRAW_DIR", os.getenv("LDRAWDIR", Path.home() / "ldraw"))).expanduser().resolve()
        self.max_parts = max_parts
        self.use_jev = use_jev and bool(os.getenv("TYPESAFE_API_KEY"))
        self.renderer = LDrawMeshRenderer(self.library)
        self.last_build: NovaBuild | None = None
        self.last_build_turn = -1

    def require_ready(self) -> None:
        if not (self.root / "ldraw_tools" / "cli.py").is_file() or not self.python.is_file():
            raise ValueError("Nova toolkit is not installed. Run npm run setup:nova, then restart local development.")
        if not (self.library / "parts").is_dir() or not (self.library / "LDConfig.ldr").is_file():
            raise ValueError("Nova requires an official LDraw library; run npm run setup:nova.")

    async def run(self, arguments: list[str], timeout: int = 240) -> Any:
        self.require_ready()
        environment = {name: value for name, value in os.environ.items() if name in TOOLKIT_ENVIRONMENT_KEYS}
        environment.update({"LDRAW_DIR": str(self.library),
                            "PATH": str(self.python.parent) + os.pathsep + os.environ.get("PATH", "")})
        if self.use_jev and os.getenv("TYPESAFE_API_KEY"):
            environment["TYPESAFE_API_KEY"] = os.environ["TYPESAFE_API_KEY"]
        process = await asyncio.create_subprocess_exec(
            str(self.python), "-m", "ldraw_tools.cli", "--library", str(self.library), *arguments,
            cwd=str(self.root), env=environment, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, start_new_session=True,
        )

        async def read_bounded(stream, limit):
            chunks, size = [], 0
            while chunk := await stream.read(65_536):
                size += len(chunk)
                if size > limit:
                    raise ValueError("Nova toolkit output exceeds the supported size")
                chunks.append(chunk)
            return b"".join(chunks)

        output_task = asyncio.gather(read_bounded(process.stdout, MAX_TOOLKIT_STDOUT_BYTES),
                                     read_bounded(process.stderr, MAX_TOOLKIT_STDERR_BYTES), process.wait())
        try:
            stdout, _stderr, _returncode = await asyncio.wait_for(output_task, timeout=timeout)
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
            raise ValueError(f"Nova toolkit could not complete {arguments[0]} (exit {process.returncode})") from exc
        if process.returncode not in {0, 1}:
            message = str(result.get("error", "Invalid toolkit request"))[:4000] if isinstance(result, dict) else "Invalid toolkit request"
            for key in ("TYPESAFE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "FAL_KEY"):
                secret = os.getenv(key)
                if secret:
                    message = message.replace(secret, "[redacted]")
            raise ValueError(f"Nova {arguments[0]}: {message}")
        return result

    def read_resource_page(self, path: str, offset: int = 0) -> dict:
        if not isinstance(path, str) or len(path) > 250:
            raise ValueError("Invalid toolkit resource path")
        target = (self.root / path).resolve()
        allowed = (self.root / "docs" / "agent", self.root / "examples", self.root / "ldraw_tools" / "data",
                   self.root / "data" / "models-annotated")
        if not any(target.is_relative_to(directory) for directory in allowed) or target.suffix not in {".md", ".json", ".py", ".ldr", ".mpd"}:
            raise ValueError("Only toolkit manuals, schemas and example sources are readable")
        if not target.is_file():
            raise ValueError("Toolkit resource not found")
        if target.stat().st_size > MAX_PLAN_BYTES:
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
                    "note": "For offline full-text searches use short specific terms, such as 'brick 2 x 4' or 'steering'. Refine or split queries with no matches."}
        arguments = ["discover", "search", kind, query, "--engine", engine, "--limit", str(limit), "--all-families"]
        try:
            results = await self.run(arguments)
            if engine == "jev" and isinstance(results, dict) and results.get("error"):
                raise ValueError("Semantic search unavailable")
        except (ValueError, asyncio.TimeoutError):
            # FTS remains usable during Jev outages and with no TypeSafe key.
            results = await self.run(["search", kind, query, "--limit", str(limit)])
            engine = "fts"
        return {"engine": engine, "results": results}

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
        self.last_build = NovaBuild(ldr, mpd, plan, report, preview)
        self.last_build_turn = turn_number
        return {"accepted": True, "report": report, "part_count": sum(line.startswith("1 ") for line in ldr.splitlines()),
                "instruction": "Review both rendered views against the request. Check proportions, details and attachment evidence. Submit repairs or accept_model on your next turn. Physical validity is not proven by these checks."}, preview

    async def dispatch(self, name: str, arguments: dict, turn_number: int) -> tuple[Any, bytes | None]:
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
            reference = _bounded_text(arguments.get("id", ""), 400)
            path = (self.root / reference).resolve()
            if path.suffix.lower() in {".ldr", ".mpd"} and any(path.is_relative_to(directory) for directory in
                    (self.root / "data" / "models-annotated", self.root / "examples")):
                return await self.run(["study", str(path), "--detail", "summary", "--limit", "30",
                                       "--max-instances", str(max(self.max_parts, 10_000))]), None
            return await self.run(["discover", "show", reference]), None
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
