"""Build an editable LEGO model from a brief, a photo or a saved Astrology design."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
from pathlib import Path

import httpx
from dotenv import dotenv_values

from ..utils.imported_kit import fulfillment_csv
from ..utils.ldraw_upload import normalize_ldraw_upload
from ..utils.prompt_parts_limit import prompt_parts_limit, tighter_parts_limit
from ..utils.supplier_catalog import get_supplier_catalog
from .agent import MODEL, design
from .design import sections
from .render import Renderer, prepare_reference
from .session import Session, open_client


def reference_image(path):
    if path.stat().st_size > 20 * 1024 * 1024:
        raise ValueError("Reference image exceeds 20 MiB")
    return prepare_reference(path.read_bytes())


def load_design(path):
    if path.stat().st_size > 512 * 1024:
        raise ValueError("Design file exceeds 512 KiB")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or type(data.get("version")) is not int or data["version"] != 1:
        raise ValueError("Expected an Astrology version 1 design file")
    limit = data.get("max_parts")
    if type(limit) is not int or not 1 <= limit <= 5000:
        raise ValueError("Invalid saved piece limit")
    return sections(data.get("sections")), limit


def write_json(path, value):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


async def run(args):
    prompt = args.prompt.strip()
    if len(prompt) > 4000 or not (prompt or args.image):
        raise ValueError("Supply an image or a brief of at most 4,000 characters")
    if args.max_parts is not None and not 1 <= args.max_parts <= 5000:
        raise ValueError("--max-parts must be 1..5,000")
    previous, inherited = load_design(args.edit) if args.edit else (None, None)
    requested = tighter_parts_limit(args.max_parts, inherited, prompt_parts_limit(prompt))
    limit = min(requested or 1000, 5000)
    reference = reference_image(args.image) if args.image else None
    renderer = Renderer()
    catalog = get_supplier_catalog()
    key = os.getenv("OPENAI_API_KEY") or dotenv_values(
        Path(__file__).resolve().parents[2] / ".env"
    ).get("OPENAI_API_KEY")
    if not key:
        raise ValueError("Set OPENAI_API_KEY in the environment or backend/.env")

    out = args.out.resolve()
    out.mkdir(mode=0o700, parents=True, exist_ok=False)

    def checkpoint(program, checked):
        path = out / ("design.json" if checked else "draft.json")
        write_json(path, {"version": 1, "max_parts": limit, "sections": program})

    if previous:
        checkpoint(previous, False)
    async with open_client(key) as client:
        session = Session(
            client, prompt or "Build the subject in the photograph.", limit, reference
        )
        print(f"Starting Astrology with a {limit}-piece limit.", flush=True)
        build = await design(
            session,
            catalog,
            limit,
            renderer,
            program=previous,
            report=lambda s: print(s, flush=True),
            checkpoint=checkpoint,
        )
    checkpoint(build.program, True)
    ldraw = build.assembly.ldraw()
    (out / "model.ldr").write_text(ldraw, encoding="utf-8")
    mpd = normalize_ldraw_upload("model.ldr", ldraw.encode("utf-8"))
    (out / "model.mpd").write_text(mpd + "0 NOFILE\n", encoding="utf-8")
    (out / "parts.csv").write_text(fulfillment_csv(build.assembly.inventory), encoding="utf-8")
    (out / "front.png").write_bytes(build.views.front)
    (out / "back.png").write_bytes(build.views.back)
    write_json(
        out / "result.json",
        {
            "model": MODEL,
            "pieces": len(build.assembly.pieces),
            "max_parts": limit,
            "part_color_combinations": len(build.assembly.inventory),
            "stud_groups": 1,
            "visual_assessment": build.assessment,
            "provider_calls": len(session.budget.usage_records),
            "estimated_cost_usd": str(session.budget.spent),
        },
    )
    (out / "draft.json").unlink(missing_ok=True)
    print(f"Saved {len(build.assembly.pieces)} pieces to {out / 'model.ldr'}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", nargs="?", default="")
    parser.add_argument("--image", type=Path, help="Local reference image")
    parser.add_argument("--edit", type=Path, help="Prior Astrology design.json")
    parser.add_argument("--out", type=Path, required=True, help="New output directory")
    parser.add_argument("--max-parts", type=int, help="Maximum physical pieces (default 1000)")
    try:
        asyncio.run(run(parser.parse_args()))
    except (ValueError, OSError, httpx.HTTPError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Astrology: {str(error) or type(error).__name__}\n")


if __name__ == "__main__":
    main()
