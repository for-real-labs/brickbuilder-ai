"""Fixed reference adapter executed inside the optional, isolated Nova runtime.

Only this app-owned program is executable. Reference source stays data, while
the external toolkit supplies its canonical identities and MPD parser. No CAD
application or rendering executable is used.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path
from types import SimpleNamespace

REFERENCE_ID_RE = re.compile(r"^(?:model|submodel)-[a-f0-9]{24}$")
MAX_REFERENCE_SOURCE_BYTES = 4_000_000
MAX_EXTRACTED_SOURCE_BYTES = 3_000_000


def _runtime(toolkit_root: Path):
    sys.path.insert(0, str(toolkit_root))
    from ldraw_tools.common import get_parts, normalized
    from ldraw_tools.discovery import DiscoveryIndex, source_id
    from ldraw_tools.document import (
        dependency_closure, parse_source, physical_context, resolve_section,
        section_table, selected_source,
    )
    return SimpleNamespace(**locals())


def _source_path(root: Path, reference: str) -> Path:
    candidate = Path(reference)
    if candidate.is_absolute() or reference.startswith(("data/", "examples/")):
        path = (root / candidate).resolve()
    else:
        path = (root / "data" / "models-annotated" / candidate).resolve()
    allowed = (root / "data" / "models-annotated", root / "examples")
    if not any(path.is_relative_to(directory) for directory in allowed) or path.suffix.lower() not in {".ldr", ".mpd"}:
        raise ValueError("Reference must be a bundled model or example source")
    if not path.is_file():
        raise ValueError("Reference source not found")
    if path.stat().st_size > MAX_REFERENCE_SOURCE_BYTES:
        raise ValueError("Reference source exceeds the inspection size limit")
    return path


def _inventory(runtime, model, selected, parts, max_instances: int) -> dict:
    """Inventory an unindexed bundled example without losing embedded parts."""
    physical, overlay = runtime.physical_context(model, parts, selected.name)
    counts, count = Counter(), 0
    for occurrence in physical.iter_occurrences():
        count += 1
        if count > max_instances:
            raise ValueError("Reference exceeds the inspection placement limit; select a smaller section")
        counts[runtime.normalized(occurrence.reference)] += 1
    bom = [{"part": part, "count": amount,
            "description": overlay.by_code.get(part.removesuffix(".dat"), ""),
            "physical_index_entry": part.removesuffix(".dat") in overlay.by_code}
           for part, amount in sorted(counts.items())]
    closure = runtime.dependency_closure(model, selected.name)
    raw = [section.name for section in closure if not section.name.lower().endswith(".dat")
           and any(type(item).__name__ in {"Triangle", "Quadrilateral", "Line", "OptionalLine"} for item in section.objects)]
    unresolved = [row for row in bom if not row["physical_index_entry"]]
    parents = [{"section": section.name, "colour": piece.colour.code}
               for section in runtime.section_table(model).values() for piece in section.pieces
               if runtime.normalized(piece.reference) == runtime.normalized(selected.name)]
    return {"expanded_leaf_count": count, "physical_accounting_complete": not raw and not unresolved,
            "physical_placements": count if not raw and not unresolved else None, "bom": bom,
            "nonphysical_or_unresolved_leaves": unresolved, "raw_geometry_sections": raw, "parents": parents,
            "dependencies": [{"section": item.name, "kind": "part_definition" if item.name.lower().endswith(".dat") else "assembly",
                              "author": item.author, "license": item.license} for item in closure]}


def prepare_reference(toolkit_root: Path, library: Path, reference: str, *, section: str | None = None,
                      colour: int | None = None, max_instances: int = 10_000, runtime=None) -> dict:
    """Resolve one canonical source, then preserve its dependency-closed bytes."""
    root = toolkit_root.resolve()
    if not isinstance(reference, str) or not 1 <= len(reference) <= 400 or "\x00" in reference:
        raise ValueError("Invalid reference identity")
    if section is not None and (not isinstance(section, str) or not 1 <= len(section) <= 400 or "\x00" in section):
        raise ValueError("Invalid reference section")
    if type(max_instances) is not int or not 1 <= max_instances <= 10_000:
        raise ValueError("Invalid reference placement limit")
    if colour is not None and (type(colour) is not int or not 0 <= colour <= 0x3FFFFFF or colour in {16, 24}):
        raise ValueError("Preview colour must be an explicit LDraw colour")
    runtime = runtime or _runtime(root)
    parts = runtime.get_parts(library)
    index, row = None, None
    if REFERENCE_ID_RE.fullmatch(reference):
        index = runtime.DiscoveryIndex(parts)
        index.ensure()
        row = index.get(reference)
        if row.get("id") != reference or row.get("kind") not in {"models", "submodels"}:
            raise ValueError("Discovery returned a different reference identity")
        if row["kind"] == "submodels" and section is not None and runtime.normalized(section).strip() != runtime.normalized(row.get("section", "")).strip():
            raise ValueError("The section does not match the discovered submodel identity")
        path = _source_path(root, row.get("model", ""))
        if hashlib.sha256(path.read_bytes()).hexdigest() != row.get("source_sha256"):
            raise ValueError("Reference source changed since indexing; rebuild the discovery index")
        section = section or row.get("section")
    else:
        path = _source_path(root, reference)

    model = runtime.parse_source(path)
    selected = runtime.resolve_section(model, section)
    model_name = str(path.relative_to(root / "data" / "models-annotated")) if path.is_relative_to(root / "data" / "models-annotated") else str(path.relative_to(root))
    kind = "submodels" if section is not None else "models"
    identity = runtime.source_id(kind, model=model_name, **({"section": selected.name} if kind == "submodels" else {}))
    if row is not None and row["kind"] == "submodels" and identity != reference:
        raise ValueError("Parsed source section does not match the discovered submodel identity")
    if index is not None:
        inventory_row = {**row, "id": identity, "kind": kind, "model": model_name,
                         **({"section": selected.name} if section is not None else {})}
        inventory = index.inventory(inventory_row, max_instances=max_instances)
    else:
        inventory = _inventory(runtime, model, selected, parts, max_instances)

    parent_colours = sorted({item["colour"] for item in inventory.get("parents", [])
                             if type(item.get("colour")) is int and item["colour"] not in {16, 24}})
    if colour is not None:
        preview_colour, colour_origin = colour, "explicit_preview"
    elif len(parent_colours) == 1:
        preview_colour, colour_origin = parent_colours[0], "source_parent"
    else:
        preview_colour, colour_origin = 7, "preview_default"
    source, _ = runtime.selected_source(path, selected.name)
    preview, _ = runtime.selected_source(path, selected.name, colour=preview_colour)
    if max(len(source.encode()), len(preview.encode())) > MAX_EXTRACTED_SOURCE_BYTES:
        raise ValueError("Extracted reference exceeds the source size limit; select a smaller section")
    dependencies = inventory.get("dependencies", [])
    metadata = {
        "id": identity, "kind": kind, "model": model_name, "section": selected.name,
        "description": selected.description, "source": str(path.relative_to(root)),
        "source_field": row.get("source_field") if row else None,
        "source_start_line": row.get("start_line") if row else None,
        "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "extracted_sha256": hashlib.sha256(source.encode()).hexdigest(),
        "preview_colour": preview_colour, "preview_colour_origin": colour_origin,
        "preview_colour_note": "Explicit source colours are unchanged. Only inherited colour 16 is resolved by the preview wrapper; source-parent colour is used when unambiguous, otherwise the preview uses colour 7.",
        "inventory": inventory, "attribution": [{"section": item.get("section"), "author": item.get("author"), "license": item.get("license")} for item in dependencies],
        "limitations": ["This is a root-relative source geometry study. It does not prove connections, stability or real-world buildability.",
                         "Original namespace, dependency source, authors and licences are retained. Source bytes are not repaired or relabelled."],
    }
    return {"metadata": metadata, "source_mpd": source, "preview_mpd": preview}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--toolkit-root", type=Path, required=True)
    parser.add_argument("--library", type=Path, required=True)
    parser.add_argument("--reference", required=True)
    parser.add_argument("--section")
    parser.add_argument("--colour", type=int)
    parser.add_argument("--max-instances", type=int, default=10_000)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = prepare_reference(args.toolkit_root, args.library, args.reference, section=args.section,
                                   colour=args.colour, max_instances=args.max_instances)
        args.output.mkdir(parents=True, exist_ok=True)
        for name in ("source", "preview"):
            (args.output / (name + ".mpd")).write_text(result[name + "_mpd"], encoding="utf-8")
        (args.output / "metadata.json").write_text(json.dumps(result["metadata"], allow_nan=False), encoding="utf-8")
        print(json.dumps({"written": True, "id": result["metadata"]["id"]}))
        return 0
    except (ValueError, OSError, RecursionError) as exc:
        message = str(exc)[:2000]
        for path in (args.toolkit_root, args.library, args.output):
            message = message.replace(str(path), "[local reference resource]")
        print(json.dumps({"error": message}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
