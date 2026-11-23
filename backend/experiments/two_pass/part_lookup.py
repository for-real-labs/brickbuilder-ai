"""Give the two design calls bounded, local evidence from Nova's part inspector."""

import json
import os
import re
import shutil
import subprocess
from collections import Counter
from pathlib import Path

from src.utils.parts_catalog import normalize_part_id

from .engine import FAMILY_PARTS, PALETTE


def inspect_part(part):
    root = os.getenv("LDRAW_NOVA_TOOLKIT_DIR") or os.getenv("NOVA_TOOLKIT_ROOT")
    cli = (
        Path(root).expanduser() / "ldraw-agent" if root else shutil.which("ldraw-agent")
    )
    if not cli or not os.access(cli, os.X_OK):
        raise RuntimeError("Set LDRAW_NOVA_TOOLKIT_DIR to a configured Nova toolkit")
    cli = Path(cli).resolve()
    library = (
        Path(os.getenv("LDRAW_DIR", str(Path.home() / "ldraw"))).expanduser().resolve()
    )
    result = subprocess.run(
        [
            str(cli),
            "--library",
            str(library),
            "part",
            normalize_part_id(part),
            "--limit",
            "64",
        ],
        cwd=cli.parent,
        check=False,  # Nova returns 1 for readable but incomplete geometry.
        capture_output=True,
        text=True,
        timeout=60,
    )
    try:
        report = json.loads(result.stdout)
    except ValueError as exc:
        raise RuntimeError(
            f"Nova part inspector failed for {part}: {result.stderr[:200]}"
        ) from exc
    if report.get("error_type") == "PartNotFoundError":
        return {"status": "missing from local LDraw library"}
    if result.returncode not in (0, 1) or report.get("code") != part + ".dat":
        raise RuntimeError(
            f"Nova part inspection failed for {part}: {report.get('error', result.returncode)}"
        )
    # Prioritize distinct connector types and orientations over repeated studs.
    examples = {}
    for connector in report["connectors"]:
        frame = connector["frame"]
        key = connector["kind"], connector["role"], tuple(tuple(row) for row in frame)
        if key not in examples:
            examples[key] = [*key[:2], connector["position"], frame]
    return {
        "bounds": report["bounds"],
        "size": report["size"],
        "geometry_complete": report["complete"],
        "coverage": report["connection_metadata"]["coverage"],
        "connector_count": report["connector_count"],
        "examples": list(examples.values())[:6],
    }


def draft_parts(plan):
    """Explicit placements are worth inspecting even when compilation fails."""
    if isinstance(plan, list):
        for row in plan:
            if isinstance(row, list) and len(row) == 6 and row[0] == "repeat":
                row = row[-1]
            if isinstance(row, list) and len(row) == 7 and row[0] == "part":
                yield str(row[5]).lower().removesuffix(".dat")


def placed_parts(rows):
    return [
        p
        for p, _ in Counter(
            r.split()[-1].lower().removesuffix(".dat") for r in rows
        ).most_common()
    ]


class PartLookup:
    def __init__(self, catalog):
        self.names = {}
        self.colors = {}
        self.measured = {}
        for (part, color), item in catalog.parts.items():
            if item.max_quantity != 0:
                self.names[part] = item.name
                self.colors.setdefault(part, set()).add(color)

    def candidates(self, brief):
        words = set(re.findall(r"[a-z0-9_-]+", brief.lower()))
        named = sorted(words & self.names.keys())
        terms = {w for w in words if len(w) >= 3} - {
            "the",
            "and",
            "with",
            "for",
            "this",
            "that",
            "like",
            "use",
            "model",
            "from",
            "build",
            "lego",
            "part",
            "brick",
            "piece",
            "pieces",
        }
        matches = []
        for part, name in self.names.items():
            overlap = terms.intersection(re.findall(r"[a-z0-9_-]+", name.lower()))
            if overlap:
                matches.append(
                    (-len(overlap), part not in FAMILY_PARTS, len(name), part)
                )
        return (
            named
            + [row[-1] for row in sorted(matches)]
            + ["3001", "3024", "3039", "4070"]
        )

    def context(self, candidates):
        selected = [p for p in dict.fromkeys(candidates) if p in self.colors][:4]
        facts = {}
        for part in selected:
            if part not in self.measured:
                self.measured[part] = inspect_part(part)
            facts[part] = {
                "name": self.names[part],
                "common_colors": sorted(self.colors[part].intersection(PALETTE)),
                **self.measured[part],
            }
        return (
            "Nova part measurements in local LDraw units (20 per stud, 8 per plate, -Y up). "
            "Bounds include protrusions. Connector examples are [kind,role,position,frame]; "
            "samples do not verify a join. Use measured offsets and leave clearance.\n"
            + json.dumps(facts, separators=(",", ":"))
        )
